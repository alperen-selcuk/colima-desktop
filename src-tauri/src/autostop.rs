//! Idle auto-stop (§6.11): stop a running Colima machine after it has been
//! idle for a user-chosen number of minutes, so the VM's memory goes back to
//! the host (colima/Lima never return guest RAM while the VM runs — see the
//! README benchmark). Opt-in per profile; settings live in
//! `<app_data_dir>/autostop.json`.
//!
//! A machine counts as idle only when every signal agrees: Kubernetes is off,
//! no container is running, no docker event happened since the last check,
//! the guest 1-minute load average is low, and the app holds no terminal,
//! log stream or port-forward. Any doubt (a failed probe) counts as busy.

use crate::exec;
use crate::state::AppState;
use crate::validate::validate_profile_name;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// Idle limits the UI offers, in minutes.
pub const ALLOWED_MINUTES: [u32; 4] = [5, 15, 30, 60];
/// How often the background task samples each configured machine.
const TICK: Duration = Duration::from_secs(30);
/// Guest 1-minute load average at or below this counts as idle.
const LOAD_IDLE_MAX: f32 = 0.30;
const SETTINGS_FILE: &str = "autostop.json";

/// Persisted settings: profile name -> idle limit in minutes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStopSettings {
    #[serde(default)]
    pub profiles: BTreeMap<String, u32>,
}

impl AutoStopSettings {
    /// Drop entries with an invalid profile name or a limit the UI doesn't
    /// offer (hand-edited file).
    fn sanitized(mut self) -> Self {
        self.profiles
            .retain(|name, min| validate_profile_name(name).is_ok() && ALLOWED_MINUTES.contains(min));
        self
    }
}

/// Live state of one configured profile, for the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStopStatus {
    pub profile: String,
    pub minutes: u32,
    /// Seconds the machine has been continuously idle (0 when busy/stopped).
    pub idle_seconds: u64,
    /// Why the machine is not idle, or `None` when idle. `"stopped"` when the
    /// machine isn't running.
    pub busy_reason: Option<String>,
}

/// Payload of the `auto-stopped` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStopped {
    pub profile: String,
    pub minutes: u32,
}

/// One sample of a running machine's activity signals.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Activity {
    pub kubernetes: bool,
    pub running_containers: usize,
    pub docker_events: usize,
    /// Guest 1-minute load average; `None` when the probe failed.
    pub load1: Option<f32>,
    /// App-held terminals, log streams and port-forwards.
    pub app_sessions: usize,
}

/// `None` when the sample is idle, else the first reason it is busy.
pub fn busy_reason(a: &Activity) -> Option<&'static str> {
    if a.kubernetes {
        Some("kubernetes")
    } else if a.running_containers > 0 {
        Some("containers")
    } else if a.docker_events > 0 {
        Some("docker activity")
    } else if a.app_sessions > 0 {
        Some("open sessions")
    } else {
        match a.load1 {
            None => Some("unknown load"),
            Some(l) if l > LOAD_IDLE_MAX => Some("cpu load"),
            Some(_) => None,
        }
    }
}

/// Per-profile "idle since" bookkeeping.
#[derive(Debug, Default)]
pub struct IdleTracker {
    since: HashMap<String, Instant>,
}

impl IdleTracker {
    /// Record a sample; returns how long `profile` has been continuously idle.
    pub fn observe(&mut self, profile: &str, idle: bool, now: Instant) -> Duration {
        if !idle {
            self.since.remove(profile);
            return Duration::ZERO;
        }
        let since = *self.since.entry(profile.to_string()).or_insert(now);
        now.saturating_duration_since(since)
    }

    pub fn reset(&mut self, profile: &str) {
        self.since.remove(profile);
    }
}

/// Managed state held in [`AppState`].
#[derive(Default)]
pub struct AutoStopState {
    tracker: Mutex<IdleTracker>,
    status: Mutex<BTreeMap<String, AutoStopStatus>>,
}

/// First field of `/proc/loadavg`.
pub fn parse_load1(s: &str) -> Option<f32> {
    s.split_whitespace().next()?.parse().ok()
}

fn count_lines(s: &str) -> usize {
    s.lines().filter(|l| !l.trim().is_empty()).count()
}

fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SETTINGS_FILE)
}

/// Read settings; a missing or unreadable file means "nothing configured".
pub fn load_settings(app_data_dir: &Path) -> AutoStopSettings {
    std::fs::read_to_string(settings_path(app_data_dir))
        .ok()
        .and_then(|s| serde_json::from_str::<AutoStopSettings>(&s).ok())
        .unwrap_or_default()
        .sanitized()
}

/// Write settings atomically (temp file + rename).
fn save_settings(app_data_dir: &Path, settings: &AutoStopSettings) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    let path = settings_path(app_data_dir);
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Apply one change: `Some(minutes)` enables, `None` disables.
pub fn apply_change(mut settings: AutoStopSettings, profile: &str, minutes: Option<u32>) -> Result<AutoStopSettings, String> {
    validate_profile_name(profile)?;
    match minutes {
        Some(m) if !ALLOWED_MINUTES.contains(&m) => {
            return Err(format!("idle limit must be one of {ALLOWED_MINUTES:?} minutes"))
        }
        Some(m) => {
            settings.profiles.insert(profile.to_string(), m);
        }
        None => {
            settings.profiles.remove(profile);
        }
    }
    Ok(settings)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("could not resolve app data dir: {e}"))
}

#[derive(Deserialize)]
struct RawStatus {
    #[serde(default)]
    kubernetes: bool,
}

/// Sample a machine. `None` when it isn't running.
async fn sample(state: &AppState, profile: &str) -> Option<Activity> {
    // `colima status` exits non-zero when the machine is stopped.
    let raw = exec::run("colima", &["status", "--json", "-p", profile]).await.ok()?;
    let status: RawStatus = serde_json::from_str(raw.trim()).ok()?;
    let sock = crate::colima::resolve_docker_socket(state, profile).await;

    let running_containers = match exec::run("docker", &["-H", &sock, "ps", "-q"]).await {
        Ok(out) => count_lines(&out),
        Err(_) => 1, // can't tell: treat as busy
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let since = now.saturating_sub(TICK.as_secs() + 1).to_string();
    let until = now.to_string();
    let docker_events = match exec::run(
        "docker",
        &["-H", &sock, "events", "--since", &since, "--until", &until, "--format", "{{.Type}}"],
    )
    .await
    {
        Ok(out) => count_lines(&out),
        Err(_) => 1,
    };
    let load1 = exec::run("colima", &["ssh", "-p", profile, "--", "cat", "/proc/loadavg"])
        .await
        .ok()
        .and_then(|s| parse_load1(&s));

    let app_sessions = state.pty_sessions.lock().unwrap().len()
        + state.log_streams.lock().unwrap().len()
        + crate::portforward::count_profile(state, profile);

    Some(Activity {
        kubernetes: status.kubernetes,
        running_containers,
        docker_events,
        load1,
        app_sessions,
    })
}

/// One pass over every configured profile.
async fn tick(app: &AppHandle) {
    let Ok(dir) = app_data_dir(app) else { return };
    let settings = load_settings(&dir);
    let state = app.state::<AppState>();
    let busy_ops = state.busy_profiles();

    let mut statuses = BTreeMap::new();
    let mut to_stop = Vec::new();
    for (profile, &minutes) in &settings.profiles {
        let reason: Option<String> = if busy_ops.contains(profile) {
            Some("operation in progress".into())
        } else {
            match sample(&state, profile).await {
                None => Some("stopped".into()),
                Some(a) => busy_reason(&a).map(str::to_string),
            }
        };
        let idle = state
            .autostop
            .tracker
            .lock()
            .unwrap()
            .observe(profile, reason.is_none(), Instant::now());
        if reason.is_none() && idle >= Duration::from_secs(u64::from(minutes) * 60) {
            to_stop.push((profile.clone(), minutes));
        }
        statuses.insert(
            profile.clone(),
            AutoStopStatus {
                profile: profile.clone(),
                minutes,
                idle_seconds: idle.as_secs(),
                busy_reason: reason,
            },
        );
    }
    *state.autostop.status.lock().unwrap() = statuses;

    for (profile, minutes) in to_stop {
        state.autostop.tracker.lock().unwrap().reset(&profile);
        let stopped =
            crate::colima::stop_profile(app.clone(), app.state::<AppState>(), profile.clone(), false).await;
        if stopped.is_ok() {
            let _ = app.emit("auto-stopped", AutoStopped { profile, minutes });
        }
    }
}

/// Start the background task (called once from app setup).
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            tick(&app).await;
        }
    });
}

#[tauri::command]
pub async fn autostop_settings(app: AppHandle) -> Result<AutoStopSettings, String> {
    Ok(load_settings(&app_data_dir(&app)?))
}

#[tauri::command]
pub async fn set_autostop(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    minutes: Option<u32>,
) -> Result<AutoStopSettings, String> {
    let dir = app_data_dir(&app)?;
    let next = apply_change(load_settings(&dir), &profile, minutes)?;
    save_settings(&dir, &next)?;
    state.autostop.tracker.lock().unwrap().reset(&profile);
    if minutes.is_none() {
        state.autostop.status.lock().unwrap().remove(&profile);
    }
    Ok(next)
}

#[tauri::command]
pub async fn autostop_status(state: State<'_, AppState>) -> Result<Vec<AutoStopStatus>, String> {
    Ok(state.autostop.status.lock().unwrap().values().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> Activity {
        Activity { load1: Some(0.05), ..Activity::default() }
    }

    #[test]
    fn quiet_machine_is_idle() {
        assert_eq!(busy_reason(&idle()), None);
    }

    #[test]
    fn every_signal_marks_busy() {
        assert_eq!(busy_reason(&Activity { kubernetes: true, ..idle() }), Some("kubernetes"));
        assert_eq!(busy_reason(&Activity { running_containers: 1, ..idle() }), Some("containers"));
        assert_eq!(busy_reason(&Activity { docker_events: 3, ..idle() }), Some("docker activity"));
        assert_eq!(busy_reason(&Activity { app_sessions: 1, ..idle() }), Some("open sessions"));
        assert_eq!(busy_reason(&Activity { load1: Some(0.9), ..idle() }), Some("cpu load"));
        assert_eq!(busy_reason(&Activity { load1: None, ..idle() }), Some("unknown load"));
    }

    #[test]
    fn load_at_threshold_is_idle() {
        assert_eq!(busy_reason(&Activity { load1: Some(LOAD_IDLE_MAX), ..idle() }), None);
    }

    #[test]
    fn tracker_accumulates_and_resets_on_activity() {
        let mut t = IdleTracker::default();
        let t0 = Instant::now();
        assert_eq!(t.observe("default", true, t0), Duration::ZERO);
        assert_eq!(t.observe("default", true, t0 + Duration::from_secs(90)), Duration::from_secs(90));
        assert_eq!(t.observe("default", false, t0 + Duration::from_secs(120)), Duration::ZERO);
        assert_eq!(t.observe("default", true, t0 + Duration::from_secs(150)), Duration::ZERO);
        assert_eq!(t.observe("default", true, t0 + Duration::from_secs(180)), Duration::from_secs(30));
    }

    #[test]
    fn tracker_profiles_are_independent() {
        let mut t = IdleTracker::default();
        let t0 = Instant::now();
        t.observe("a", true, t0);
        t.observe("b", true, t0 + Duration::from_secs(60));
        assert_eq!(t.observe("a", true, t0 + Duration::from_secs(120)), Duration::from_secs(120));
        assert_eq!(t.observe("b", true, t0 + Duration::from_secs(120)), Duration::from_secs(60));
        t.reset("a");
        assert_eq!(t.observe("a", true, t0 + Duration::from_secs(130)), Duration::ZERO);
    }

    #[test]
    fn parses_loadavg() {
        assert_eq!(parse_load1("0.08 0.03 0.01 1/123 456\n"), Some(0.08));
        assert_eq!(parse_load1(""), None);
        assert_eq!(parse_load1("garbage"), None);
    }

    #[test]
    fn apply_change_enables_disables_and_validates() {
        let s = apply_change(AutoStopSettings::default(), "default", Some(15)).unwrap();
        assert_eq!(s.profiles.get("default"), Some(&15));
        let s = apply_change(s, "default", None).unwrap();
        assert!(s.profiles.is_empty());
        assert!(apply_change(AutoStopSettings::default(), "default", Some(7)).is_err());
        assert!(apply_change(AutoStopSettings::default(), "-bad", Some(5)).is_err());
    }

    #[test]
    fn settings_roundtrip_and_sanitize() {
        let dir = std::env::temp_dir().join(format!("autostop-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_settings(&dir), AutoStopSettings::default());
        let s = apply_change(AutoStopSettings::default(), "work", Some(30)).unwrap();
        save_settings(&dir, &s).unwrap();
        assert_eq!(load_settings(&dir), s);
        std::fs::write(settings_path(&dir), r#"{"profiles":{"ok":5,"odd":7,"-x":5}}"#).unwrap();
        assert_eq!(load_settings(&dir).profiles.into_iter().collect::<Vec<_>>(), vec![("ok".to_string(), 5)]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
