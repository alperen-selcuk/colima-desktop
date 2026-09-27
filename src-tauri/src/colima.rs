//! Profile (colima machine) lifecycle commands: list, status, config,
//! start/stop/restart/delete, kubernetes enable/disable/reset.

use crate::exec::{self};
use crate::state::AppState;
use crate::validate::validate_profile_name;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

/// One line of `colima list --json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub status: String,
    pub arch: String,
    pub cpus: u32,
    pub memory: u64,
    pub disk: u64,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
}

/// Raw shape of `colima status --json -p <p>` (snake_case on the wire).
#[derive(Debug, Clone, Deserialize)]
struct RawProfileStatus {
    display_name: String,
    driver: String,
    arch: String,
    runtime: String,
    mount_type: String,
    ip_address: String,
    docker_socket: String,
    #[serde(default)]
    containerd_socket: Option<String>,
    #[serde(default)]
    kubernetes: bool,
    cpu: u32,
    memory: u64,
    disk: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStatus {
    pub display_name: String,
    pub driver: String,
    pub arch: String,
    pub runtime: String,
    pub mount_type: String,
    pub ip_address: String,
    pub docker_socket: String,
    pub containerd_socket: Option<String>,
    pub kubernetes: bool,
    pub cpu: u32,
    pub memory: u64,
    pub disk: u64,
}

impl From<RawProfileStatus> for ProfileStatus {
    fn from(r: RawProfileStatus) -> Self {
        ProfileStatus {
            display_name: r.display_name,
            driver: r.driver,
            arch: r.arch,
            runtime: r.runtime,
            mount_type: r.mount_type,
            ip_address: r.ip_address,
            docker_socket: r.docker_socket,
            containerd_socket: r.containerd_socket,
            kubernetes: r.kubernetes,
            cpu: r.cpu,
            memory: r.memory,
            disk: r.disk,
        }
    }
}

/// Mirrors the on-disk colima.yaml shape closely enough to extract the
/// fields we surface; every field is optional so partial/older configs
/// still parse (missing fields fall back to defaults in [`ProfileConfig`]).
#[derive(Debug, Default, Deserialize)]
struct RawYamlMount {
    location: String,
    #[serde(default)]
    writable: bool,
}

#[derive(Debug, Default, Deserialize)]
struct RawYamlKubernetes {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    version: String,
}

#[derive(Debug, Default, Deserialize)]
struct RawYamlNetwork {
    #[serde(default)]
    address: bool,
}

#[derive(Debug, Default, Deserialize)]
struct RawYamlConfig {
    #[serde(default)]
    cpu: Option<u32>,
    #[serde(default)]
    memory: Option<f32>,
    #[serde(default)]
    disk: Option<u32>,
    #[serde(default)]
    arch: Option<String>,
    #[serde(default)]
    runtime: Option<String>,
    #[serde(rename = "vmType", default)]
    vm_type: Option<String>,
    #[serde(rename = "mountType", default)]
    mount_type: Option<String>,
    #[serde(default)]
    rosetta: Option<bool>,
    #[serde(default)]
    network: RawYamlNetwork,
    #[serde(default)]
    kubernetes: RawYamlKubernetes,
    #[serde(default)]
    mounts: Vec<RawYamlMount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConfig {
    pub cpu: u32,
    pub memory: u32,
    pub disk: u32,
    pub arch: String,
    pub runtime: String,
    pub vm_type: String,
    pub mount_type: String,
    pub rosetta: bool,
    pub network_address: bool,
    pub kubernetes_enabled: bool,
    pub kubernetes_version: String,
    pub mounts: Vec<String>,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        ProfileConfig {
            cpu: 2,
            memory: 2,
            disk: 100,
            arch: std::env::consts::ARCH.to_string(),
            runtime: "docker".to_string(),
            vm_type: if cfg!(target_os = "macos") { "vz" } else { "qemu" }.to_string(),
            mount_type: "sshfs".to_string(),
            rosetta: false,
            network_address: false,
            kubernetes_enabled: false,
            kubernetes_version: String::new(),
            mounts: Vec::new(),
        }
    }
}

fn raw_yaml_to_config(raw: RawYamlConfig) -> ProfileConfig {
    let defaults = ProfileConfig::default();
    ProfileConfig {
        cpu: raw.cpu.unwrap_or(defaults.cpu),
        memory: raw.memory.map(|m| m as u32).unwrap_or(defaults.memory),
        disk: raw.disk.unwrap_or(defaults.disk),
        arch: raw.arch.unwrap_or(defaults.arch),
        runtime: raw.runtime.unwrap_or(defaults.runtime),
        vm_type: raw.vm_type.unwrap_or(defaults.vm_type),
        mount_type: raw.mount_type.unwrap_or(defaults.mount_type),
        rosetta: raw.rosetta.unwrap_or(defaults.rosetta),
        network_address: raw.network.address,
        kubernetes_enabled: raw.kubernetes.enabled,
        kubernetes_version: raw.kubernetes.version,
        mounts: raw
            .mounts
            .into_iter()
            .map(|m| {
                if m.writable {
                    format!("{}:w", m.location)
                } else {
                    m.location
                }
            })
            .collect(),
    }
}

/// Options accepted by `start_profile`; only present fields become CLI
/// flags.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    pub cpu: Option<u32>,
    pub memory: Option<u32>,
    pub disk: Option<u32>,
    pub arch: Option<String>,
    pub runtime: Option<String>,
    pub vm_type: Option<String>,
    pub mount_type: Option<String>,
    pub kubernetes: Option<bool>,
    pub kubernetes_version: Option<String>,
    pub vz_rosetta: Option<bool>,
    pub network_address: Option<bool>,
    pub activate: Option<bool>,
    pub mounts: Option<Vec<String>>,
}

/// Build the `colima start -p <profile> [flags...]` argument list from
/// [`StartOptions`]. Never emits `--edit`/`--foreground`.
fn start_args(profile: &str, opts: &StartOptions) -> Vec<String> {
    let mut args = vec!["start".to_string(), "-p".to_string(), profile.to_string()];

    if let Some(v) = opts.cpu {
        args.push("--cpu".into());
        args.push(v.to_string());
    }
    if let Some(v) = opts.memory {
        args.push("--memory".into());
        args.push(v.to_string());
    }
    if let Some(v) = opts.disk {
        args.push("--disk".into());
        args.push(v.to_string());
    }
    if let Some(v) = &opts.arch {
        args.push("--arch".into());
        args.push(v.clone());
    }
    if let Some(v) = &opts.runtime {
        args.push("--runtime".into());
        args.push(v.clone());
    }
    if let Some(v) = &opts.vm_type {
        args.push("--vm-type".into());
        args.push(v.clone());
    }
    if let Some(v) = &opts.mount_type {
        args.push("--mount-type".into());
        args.push(v.clone());
    }
    if let Some(v) = opts.kubernetes {
        args.push(if v { "--kubernetes" } else { "--kubernetes=false" }.into());
    }
    if let Some(v) = &opts.kubernetes_version {
        args.push("--kubernetes-version".into());
        args.push(v.clone());
    }
    if let Some(v) = opts.vz_rosetta {
        args.push(if v { "--vz-rosetta" } else { "--vz-rosetta=false" }.into());
    }
    if let Some(v) = opts.network_address {
        args.push(if v {
            "--network-address"
        } else {
            "--network-address=false"
        }
        .into());
    }
    if let Some(v) = opts.activate {
        args.push(if v { "--activate" } else { "--activate=false" }.into());
    }
    if let Some(mounts) = &opts.mounts {
        for m in mounts {
            args.push("--mount".into());
            args.push(m.clone());
        }
    }

    args
}

/// Resolve `colima_home_env` (or `home_env`/`.colima`), the root under which
/// each profile's directory (config, sockets, ssh config) lives. Pure
/// function so tests can inject values instead of mutating the
/// process-global `COLIMA_HOME`/`HOME` env vars.
fn resolve_colima_home(colima_home_env: Option<&str>, home_env: Option<&str>) -> PathBuf {
    if let Some(home) = colima_home_env {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let home = home_env.unwrap_or(".");
    PathBuf::from(home).join(".colima")
}

/// Resolve `$COLIMA_HOME` (or `~/.colima`), the root under which each
/// profile's directory (config, sockets, ssh config) lives.
pub fn colima_home() -> PathBuf {
    resolve_colima_home(std::env::var("COLIMA_HOME").ok().as_deref(), std::env::var("HOME").ok().as_deref())
}

/// Fallback docker socket path when `colima status` can't be consulted:
/// `unix://<colima_home>/<profile>/docker.sock`.
fn fallback_docker_socket_at(home: &std::path::Path, profile: &str) -> String {
    let path = home.join(profile).join("docker.sock");
    format!("unix://{}", path.display())
}

/// Fallback docker socket path when `colima status` can't be consulted:
/// `unix://<colima_home>/<profile>/docker.sock`.
fn fallback_docker_socket(profile: &str) -> String {
    fallback_docker_socket_at(&colima_home(), profile)
}

/// Resolve the docker socket for `profile`, using the 30s cache (§2.2)
/// before falling back to `colima status --json -p <profile>`, and finally
/// to the well-known path if status fails.
pub async fn resolve_docker_socket(state: &AppState, profile: &str) -> String {
    if let Some(cached) = state.cached_docker_socket(profile) {
        return cached;
    }

    let socket = match exec::run("colima", &["status", "--json", "-p", profile]).await {
        Ok(stdout) => serde_json::from_str::<RawProfileStatus>(stdout.trim())
            .ok()
            .map(|s| s.docker_socket)
            .unwrap_or_else(|| fallback_docker_socket(profile)),
        Err(_) => fallback_docker_socket(profile),
    };

    state.cache_docker_socket(profile, socket.clone());
    socket
}

#[tauri::command]
pub async fn list_profiles() -> Result<Vec<Profile>, String> {
    exec::run_json_lines("colima", &["list", "--json"]).await
}

#[tauri::command]
pub async fn profile_status(profile: String) -> Result<Option<ProfileStatus>, String> {
    validate_profile_name(&profile)?;
    match exec::run("colima", &["status", "--json", "-p", &profile]).await {
        Ok(stdout) => {
            let raw: RawProfileStatus = serde_json::from_str(stdout.trim())
                .map_err(|e| format!("failed to parse profile status: {e}"))?;
            Ok(Some(raw.into()))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn profile_config(profile: String) -> Result<Option<ProfileConfig>, String> {
    validate_profile_name(&profile)?;
    let path = colima_home().join(&profile).join("colima.yaml");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let raw: RawYamlConfig =
        serde_yaml::from_str(&contents).map_err(|e| format!("failed to parse colima.yaml: {e}"))?;
    Ok(Some(raw_yaml_to_config(raw)))
}

#[tauri::command]
pub async fn busy_profiles(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.busy_profiles())
}

fn emit_profiles_changed(app: &AppHandle) {
    let _ = app.emit("profiles-changed", ());
}

#[tauri::command]
pub async fn start_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    options: StartOptions,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let _guard = state.try_lock_profile(&profile)?;
    state.invalidate_docker_socket(&profile);
    state.kubeconfig.invalidate(&profile);

    let args = start_args(&profile, &options);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = exec::run_streaming(&app, "colima", &arg_refs, &profile, "start").await;

    state.invalidate_docker_socket(&profile);
    state.kubeconfig.invalidate(&profile);
    emit_profiles_changed(&app);
    result
}

#[tauri::command]
pub async fn stop_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    force: bool,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let _guard = state.try_lock_profile(&profile)?;

    let mut args = vec!["stop".to_string(), "-p".to_string(), profile.clone()];
    if force {
        args.push("--force".to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = exec::run_streaming(&app, "colima", &arg_refs, &profile, "stop").await;

    state.invalidate_docker_socket(&profile);
    state.kubeconfig.invalidate(&profile);
    emit_profiles_changed(&app);
    result
}

#[tauri::command]
pub async fn restart_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let _guard = state.try_lock_profile(&profile)?;

    let args = ["restart", "-p", profile.as_str()];
    let result = exec::run_streaming(&app, "colima", &args, &profile, "restart").await;

    state.invalidate_docker_socket(&profile);
    state.kubeconfig.invalidate(&profile);
    emit_profiles_changed(&app);
    result
}

#[tauri::command]
pub async fn delete_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let _guard = state.try_lock_profile(&profile)?;

    let args = ["delete", "-f", "-p", profile.as_str()];
    let result = exec::run_streaming(&app, "colima", &args, &profile, "delete").await;

    state.invalidate_docker_socket(&profile);
    state.kubeconfig.invalidate(&profile);
    emit_profiles_changed(&app);
    result
}

/// `reset`/`delete` on some colima versions accept a force flag, others
/// don't (see module docs on `kubernetes_action`). Try with `-f` first and
/// retry without it if the CLI rejects the flag as unknown.
async fn run_kubernetes_streaming_with_optional_force(
    app: &AppHandle,
    profile: &str,
    action: &str,
    op: &str,
) -> Result<(), String> {
    let with_force = [
        "kubernetes".to_string(),
        action.to_string(),
        "-f".to_string(),
        "-p".to_string(),
        profile.to_string(),
    ];
    let arg_refs: Vec<&str> = with_force.iter().map(String::as_str).collect();
    match exec::run_streaming(app, "colima", &arg_refs, profile, op).await {
        Err(e) if e.contains("unknown shorthand flag") || e.contains("unknown flag") => {
            let without_force = ["kubernetes", action, "-p", profile];
            exec::run_streaming(app, "colima", &without_force, profile, op).await
        }
        other => other,
    }
}

/// Friendly error returned by `kubernetes_action` when the profile isn't
/// running, instead of letting colima's own (much less clear) error surface.
fn not_running_message(profile: &str) -> String {
    format!("{profile} is not running — start it first")
}

/// `kubernetes_action`: `colima kubernetes <start|stop|reset|delete> -p
/// <profile>`. `reset`/`delete` add `-f` when the installed CLI accepts it,
/// retrying without it otherwise: the colima source vendored alongside this
/// project has no force flag on `kubernetes reset`/`delete` (verified against
/// its `cmd/kubernetes.go`), matching the installed colima 0.8.1 on this
/// machine, but future/other colima builds may add one — so we probe rather
/// than hard-code either behavior.
///
/// Guarded (§6.5) so the frontend never has to interpret colima's own error
/// text: calling this when the profile isn't running returns
/// `not_running_message` instead of shelling out at all.
#[tauri::command]
pub async fn kubernetes_action(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    action: String,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    if !["start", "stop", "reset", "delete"].contains(&action.as_str()) {
        return Err(format!("invalid kubernetes action: {action}"));
    }

    let is_running = matches!(
        exec::run("colima", &["status", "--json", "-p", &profile]).await,
        Ok(stdout) if serde_json::from_str::<RawProfileStatus>(stdout.trim()).is_ok()
    );
    if !is_running {
        return Err(not_running_message(&profile));
    }

    let _guard = state.try_lock_profile(&profile)?;
    let op = format!("k8s-{action}");

    let result = if action == "reset" || action == "delete" {
        run_kubernetes_streaming_with_optional_force(&app, &profile, &action, &op).await
    } else {
        let args = ["kubernetes", action.as_str(), "-p", profile.as_str()];
        exec::run_streaming(&app, "colima", &args, &profile, &op).await
    };

    state.kubeconfig.invalidate(&profile);
    emit_profiles_changed(&app);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_colima_list_json_lines() {
        let input = concat!(
            "{\"name\":\"default\",\"status\":\"Running\",\"arch\":\"aarch64\",\"cpus\":2,\"memory\":3221225472,\"disk\":42949672960,\"runtime\":\"docker\"}\n",
            "{\"name\":\"rosetta\",\"status\":\"Stopped\",\"arch\":\"aarch64\",\"cpus\":4,\"memory\":8589934592,\"disk\":107374182400}\n"
        );
        let profiles: Vec<Profile> = exec::parse_json_lines(input).unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "default");
        assert_eq!(profiles[0].runtime.as_deref(), Some("docker"));
        assert_eq!(profiles[1].name, "rosetta");
        assert_eq!(profiles[1].runtime, None);
        assert_eq!(profiles[1].address, None);
    }

    #[test]
    fn empty_list_output_is_empty_vec() {
        let profiles: Vec<Profile> = exec::parse_json_lines("").unwrap();
        assert!(profiles.is_empty());
    }

    #[test]
    fn parses_profile_status_json() {
        let input = r#"{"display_name":"colima","driver":"macOS Virtualization.Framework","arch":"aarch64","runtime":"docker","mount_type":"sshfs","ip_address":"","docker_socket":"unix:///Users/x/.colima/default/docker.sock","kubernetes":false,"cpu":2,"memory":3221225472,"disk":42949672960}"#;
        let raw: RawProfileStatus = serde_json::from_str(input).unwrap();
        let status: ProfileStatus = raw.into();
        assert_eq!(status.docker_socket, "unix:///Users/x/.colima/default/docker.sock");
        assert!(!status.kubernetes);
        assert_eq!(status.containerd_socket, None);
    }

    #[test]
    fn start_args_only_includes_provided_fields() {
        let opts = StartOptions {
            cpu: Some(4),
            kubernetes: Some(true),
            ..Default::default()
        };
        let args = start_args("default", &opts);
        assert_eq!(
            args,
            vec!["start", "-p", "default", "--cpu", "4", "--kubernetes"]
        );
        assert!(!args.contains(&"--edit".to_string()));
        assert!(!args.contains(&"--foreground".to_string()));
    }

    #[test]
    fn start_args_empty_options_is_bare_start() {
        let args = start_args("default", &StartOptions::default());
        assert_eq!(args, vec!["start", "-p", "default"]);
    }

    #[test]
    fn start_args_false_bools_pass_explicit_flag() {
        let opts = StartOptions {
            kubernetes: Some(false),
            ..Default::default()
        };
        let args = start_args("default", &opts);
        assert!(args.contains(&"--kubernetes=false".to_string()));
    }

    #[test]
    fn raw_yaml_to_config_applies_defaults_for_missing_fields() {
        let raw: RawYamlConfig = serde_yaml::from_str("cpu: 4\n").unwrap();
        let cfg = raw_yaml_to_config(raw);
        assert_eq!(cfg.cpu, 4);
        assert_eq!(cfg.memory, 2); // default
        assert_eq!(cfg.disk, 100); // default
        assert_eq!(cfg.runtime, "docker");
    }

    #[test]
    fn raw_yaml_to_config_mounts_encode_writable_suffix() {
        let yaml = "mounts:\n  - location: /tmp/a\n    writable: true\n  - location: /tmp/b\n    writable: false\n";
        let raw: RawYamlConfig = serde_yaml::from_str(yaml).unwrap();
        let cfg = raw_yaml_to_config(raw);
        assert_eq!(cfg.mounts, vec!["/tmp/a:w".to_string(), "/tmp/b".to_string()]);
    }

    #[test]
    fn fallback_docker_socket_uses_colima_home() {
        let sock = fallback_docker_socket_at(std::path::Path::new("/tmp/colimahome"), "default");
        assert_eq!(sock, "unix:///tmp/colimahome/default/docker.sock");
    }

    #[test]
    fn resolve_colima_home_prefers_colima_home_env() {
        assert_eq!(
            resolve_colima_home(Some("/tmp/colimahome"), Some("/Users/test")),
            PathBuf::from("/tmp/colimahome")
        );
    }

    #[test]
    fn resolve_colima_home_falls_back_to_home_dot_colima() {
        assert_eq!(resolve_colima_home(None, Some("/Users/test")), PathBuf::from("/Users/test/.colima"));
    }

    #[test]
    fn resolve_colima_home_ignores_empty_colima_home_env() {
        assert_eq!(resolve_colima_home(Some(""), Some("/Users/test")), PathBuf::from("/Users/test/.colima"));
    }

    #[test]
    fn resolve_colima_home_falls_back_to_dot_when_home_missing() {
        assert_eq!(resolve_colima_home(None, None), PathBuf::from("./.colima"));
    }

    #[test]
    fn not_running_message_names_the_profile() {
        assert_eq!(
            not_running_message("default"),
            "default is not running — start it first"
        );
        assert_eq!(
            not_running_message("work"),
            "work is not running — start it first"
        );
    }
}
