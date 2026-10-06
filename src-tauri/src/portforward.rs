//! Port-forwards (v0.2.5, §6.10): long-running `kubectl port-forward`
//! children bound to 127.0.0.1, tracked in [`AppState`] and killed on app
//! exit and when their profile stops / restarts / is deleted.

use crate::kubeconfig;
use crate::state::AppState;
use crate::validate::{kube_context, validate_k8s_arg, validate_profile_name};
use serde::Serialize;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: String,
    pub profile: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardEnded {
    pub id: String,
    pub error: Option<String>,
}

/// One running forward: its public description plus the child process.
pub struct ForwardEntry {
    info: PortForward,
    child: Child,
}

const READY_TIMEOUT: Duration = Duration::from_secs(10);

fn validate_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "pod" => Ok("pod"),
        "service" => Ok("service"),
        other => Err(format!("cannot port-forward a {other}")),
    }
}

/// Pick the local port: prefer `remote` when it is > 1024 and free, else the
/// first free port >= 8080.
pub fn choose_local_port(remote: u16, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    if remote > 1024 && is_free(remote) {
        return Some(remote);
    }
    (8080..=u16::MAX).find(|p| is_free(*p))
}

fn is_ready_line(line: &str) -> bool {
    line.contains("Forwarding from")
}

/// Args after `--kubeconfig <f> --context <c>` (those are prepended by
/// [`build_command`]).
fn forward_args(kind: &str, namespace: &str, name: &str, local: u16, remote: u16) -> Vec<String> {
    vec![
        "port-forward".into(),
        "--address".into(),
        "127.0.0.1".into(),
        "-n".into(),
        namespace.into(),
        format!("{kind}/{name}"),
        format!("{local}:{remote}"),
    ]
}

fn build_command(kubeconfig_path: &std::path::Path, ctx: &str, args: &[String]) -> Command {
    let mut cmd = Command::new("kubectl");
    cmd.arg("--kubeconfig").arg(kubeconfig_path);
    cmd.arg("--context").arg(ctx);
    cmd.args(args);
    cmd.env_remove("KUBECONFIG");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    cmd
}

fn tail_message(lines: &Arc<Mutex<Vec<String>>>) -> String {
    let joined = lines.lock().unwrap().join("\n");
    kubeconfig::strip_kubectl_noise(joined.trim())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn k8s_port_forward_start(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    kind: String,
    namespace: String,
    name: String,
    remote_port: u16,
    local_port: Option<u16>,
) -> Result<PortForward, String> {
    validate_profile_name(&profile)?;
    let kind = validate_kind(&kind)?;
    validate_k8s_arg("namespace", &namespace)?;
    validate_k8s_arg("name", &name)?;
    if remote_port == 0 {
        return Err("remote port must be 1-65535".to_string());
    }

    let taken: Vec<u16> = state.port_forwards.lock().unwrap().values().map(|e| e.info.local_port).collect();
    let free = |p: u16| !taken.contains(&p) && crate::marketplace::port_bind_free(p);
    let local = match local_port {
        Some(0) => return Err("local port must be 1-65535".to_string()),
        Some(p) => {
            if !free(p) {
                return Err(format!("local port {p} is already in use"));
            }
            p
        }
        None => choose_local_port(remote_port, free).ok_or("no free local port found")?,
    };

    let path = kubeconfig::ensure_fresh(&app, &profile).await?;
    let args = forward_args(kind, &namespace, &name, local, remote_port);
    let mut child = build_command(&path, &kube_context(&profile), &args).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "kubectl not found in PATH".to_string()
        } else {
            e.to_string()
        }
    })?;

    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut tx = Some(ready_tx);
            while let Ok(Some(line)) = lines.next_line().await {
                if is_ready_line(&line) {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(());
                    }
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let sink = stderr_lines.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut g = sink.lock().unwrap();
                g.push(line);
                if g.len() > 50 {
                    g.remove(0);
                }
            }
        });
    }

    match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
        Ok(Ok(())) => {}
        other => {
            // Process exited before becoming ready (sender dropped) or timed out.
            let timed_out = other.is_err();
            let _ = child.start_kill();
            let _ = child.wait().await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let msg = tail_message(&stderr_lines);
            return Err(if !msg.is_empty() {
                msg
            } else if timed_out {
                "port-forward did not become ready within 10s".to_string()
            } else {
                "kubectl port-forward exited unexpectedly".to_string()
            });
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let info = PortForward {
        id: id.clone(),
        profile,
        kind: kind.to_string(),
        namespace,
        name,
        remote_port,
        local_port: local,
        url: format!("http://127.0.0.1:{local}"),
    };
    state.port_forwards.lock().unwrap().insert(id.clone(), ForwardEntry { info: info.clone(), child });

    // Exit watcher: removes the entry and emits `port-forward-ended` when the
    // process dies on its own (pod deleted, VM stopped, connection lost…).
    let app_end = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = app_end.state::<AppState>();
            let mut guard = state.port_forwards.lock().unwrap();
            let Some(entry) = guard.get_mut(&id) else { return }; // stopped by user
            let exited = match entry.child.try_wait() {
                Ok(Some(status)) => Some(status.success()),
                Ok(None) => None,
                Err(_) => Some(false),
            };
            if let Some(success) = exited {
                guard.remove(&id);
                drop(guard);
                let msg = tail_message(&stderr_lines);
                let error = if success && msg.is_empty() {
                    None
                } else if msg.is_empty() {
                    Some("kubectl port-forward exited".to_string())
                } else {
                    Some(msg)
                };
                let _ = app_end.emit("port-forward-ended", PortForwardEnded { id: id.clone(), error });
                return;
            }
        }
    });

    Ok(info)
}

#[tauri::command]
pub fn k8s_port_forward_list(state: State<'_, AppState>) -> Vec<PortForward> {
    let mut v: Vec<PortForward> = state.port_forwards.lock().unwrap().values().map(|e| e.info.clone()).collect();
    v.sort_by(|a, b| (&a.profile, a.local_port).cmp(&(&b.profile, b.local_port)));
    v
}

#[tauri::command]
pub fn k8s_port_forward_stop(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let entry = state.port_forwards.lock().unwrap().remove(&id);
    if let Some(mut e) = entry {
        let _ = e.child.start_kill();
        let _ = app.emit("port-forward-ended", PortForwardEnded { id, error: None });
    }
    Ok(())
}

/// Kill every forward of `profile` (profile stop / restart / delete).
pub fn kill_profile(app: &AppHandle, state: &AppState, profile: &str) {
    let removed: Vec<(String, ForwardEntry)> = {
        let mut map = state.port_forwards.lock().unwrap();
        let ids: Vec<String> = map.iter().filter(|(_, e)| e.info.profile == profile).map(|(k, _)| k.clone()).collect();
        ids.into_iter().filter_map(|id| map.remove(&id).map(|e| (id, e))).collect()
    };
    for (id, mut e) in removed {
        let _ = e.child.start_kill();
        let _ = app.emit("port-forward-ended", PortForwardEnded { id, error: None });
    }
}

/// Kill every forward (app exit).
pub fn kill_all(state: &AppState) {
    let mut map = state.port_forwards.lock().unwrap();
    for (_, mut e) in map.drain() {
        let _ = e.child.start_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_remote_port_when_free_and_unprivileged() {
        assert_eq!(choose_local_port(3000, |_| true), Some(3000));
    }

    #[test]
    fn privileged_remote_falls_back_to_8080() {
        assert_eq!(choose_local_port(80, |_| true), Some(8080));
        assert_eq!(choose_local_port(1024, |_| true), Some(8080));
    }

    #[test]
    fn busy_remote_scans_upward_from_8080() {
        assert_eq!(choose_local_port(3000, |p| p != 3000 && p != 8080), Some(8081));
        assert_eq!(choose_local_port(8080, |p| p != 8080), Some(8081));
    }

    #[test]
    fn nothing_free_is_none() {
        assert_eq!(choose_local_port(3000, |_| false), None);
    }

    #[test]
    fn kind_validation() {
        assert!(validate_kind("pod").is_ok());
        assert!(validate_kind("service").is_ok());
        assert!(validate_kind("deployment").is_err());
    }

    #[test]
    fn ready_line_detection() {
        assert!(is_ready_line("Forwarding from 127.0.0.1:8080 -> 80"));
        assert!(!is_ready_line("Handling connection for 8080"));
    }

    #[test]
    fn args_shape() {
        let a = forward_args("service", "dev", "web", 8080, 80);
        assert_eq!(
            a,
            vec!["port-forward", "--address", "127.0.0.1", "-n", "dev", "service/web", "8080:80"]
        );
    }
}
