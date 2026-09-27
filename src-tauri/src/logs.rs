//! Log streaming (`docker logs -f`, `kubectl logs -f`) for the frontend's
//! live log viewer. Each stream is a child process tracked by a uuid
//! `streamId` in managed state; lines are emitted as `log-line` events and
//! the stream's exit as `log-end`.

use crate::colima::resolve_docker_socket;
use crate::kubeconfig;
use crate::state::AppState;
use crate::validate::{kube_context, validate_profile_name};
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// What to stream logs from: a docker container or a kubernetes pod.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LogTarget {
    #[serde(rename_all = "camelCase")]
    Container { id: String, tail: u32 },
    #[serde(rename_all = "camelCase")]
    Pod {
        namespace: String,
        pod: String,
        container: Option<String>,
        tail: u32,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub stream_id: String,
    pub line: String,
    pub stream: String, // "stdout" | "stderr"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEnd {
    pub stream_id: String,
    pub code: Option<i32>,
}

fn base_command(bin: &str, args: &[String]) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    cmd.env_remove("DOCKER_HOST");
    cmd.env_remove("DOCKER_CONTEXT");
    cmd.env_remove("KUBECONFIG");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    cmd
}

/// Build the argv (bin + args) for a given log target. For a pod target,
/// ensures the app-managed kubeconfig is fresh first (§2.1a) — a long-lived
/// `kubectl logs -f` stream can't be retried mid-stream the way a one-shot
/// command can, so the file must already be current before it's spawned.
async fn build_log_command(
    app: &AppHandle,
    state: &AppState,
    profile: &str,
    target: &LogTarget,
) -> Result<(String, Vec<String>), String> {
    match target {
        LogTarget::Container { id, tail } => {
            let socket = resolve_docker_socket(state, profile).await;
            Ok((
                "docker".to_string(),
                vec![
                    "-H".to_string(),
                    socket,
                    "logs".to_string(),
                    "-f".to_string(),
                    "--tail".to_string(),
                    tail.to_string(),
                    id.clone(),
                ],
            ))
        }
        LogTarget::Pod {
            namespace,
            pod,
            container,
            tail,
        } => {
            let kubeconfig_path = kubeconfig::ensure_fresh(app, profile).await?;
            let ctx = kube_context(profile);
            let mut args = vec![
                "--kubeconfig".to_string(),
                kubeconfig_path.to_string_lossy().to_string(),
                "--context".to_string(),
                ctx,
                "logs".to_string(),
                "-f".to_string(),
                format!("--tail={tail}"),
                pod.clone(),
                "-n".to_string(),
                namespace.clone(),
            ];
            if let Some(c) = container {
                args.push("-c".to_string());
                args.push(c.clone());
            }
            Ok(("kubectl".to_string(), args))
        }
    }
}

#[tauri::command]
pub async fn start_log_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    target: LogTarget,
) -> Result<String, String> {
    validate_profile_name(&profile)?;
    let (bin, args) = build_log_command(&app, &state, &profile, &target).await?;

    let mut cmd = base_command(&bin, &args);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{bin} not found in PATH")
        } else {
            e.to_string()
        }
    })?;

    let stream_id = uuid::Uuid::new_v4().to_string();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Keep the child in managed state so `stop_log_stream` can kill it;
    // waiting for exit and emitting `log-end` happens in the spawned task
    // below, which owns the exit-status side (the child itself stays in
    // the map so it can be killed on demand until then).
    state
        .log_streams
        .lock()
        .unwrap()
        .insert(stream_id.clone(), child);

    let app_stdout = app.clone();
    let id_stdout = stream_id.clone();
    if let Some(stdout) = stdout {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_stdout.emit(
                    "log-line",
                    LogEvent {
                        stream_id: id_stdout.clone(),
                        line,
                        stream: "stdout".to_string(),
                    },
                );
            }
        });
    }

    let app_stderr = app.clone();
    let id_stderr = stream_id.clone();
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_stderr.emit(
                    "log-line",
                    LogEvent {
                        stream_id: id_stderr.clone(),
                        line,
                        stream: "stderr".to_string(),
                    },
                );
            }
        });
    }

    // Poll for exit without holding the state lock across an await: the
    // child is removed from the map once it exits (or once stop_log_stream
    // removes+kills it), whichever happens first. We re-fetch the managed
    // state from the AppHandle each iteration rather than trying to clone
    // the Mutex/HashMap directly (Tauri owns the single AppState instance;
    // `app.state()` is how any task reaches it after the initial command
    // call returns).
    let app_end = app.clone();
    let id_end = stream_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let state = app_end.state::<AppState>();
            let mut guard = state.log_streams.lock().unwrap();
            let Some(child) = guard.get_mut(&id_end) else {
                // already removed by stop_log_stream
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    guard.remove(&id_end);
                    drop(guard);
                    let _ = app_end.emit(
                        "log-end",
                        LogEnd {
                            stream_id: id_end.clone(),
                            code: status.code(),
                        },
                    );
                    return;
                }
                Ok(None) => continue,
                Err(_) => {
                    guard.remove(&id_end);
                    drop(guard);
                    let _ = app_end.emit(
                        "log-end",
                        LogEnd {
                            stream_id: id_end.clone(),
                            code: None,
                        },
                    );
                    return;
                }
            }
        }
    });

    Ok(stream_id)
}

#[tauri::command]
pub async fn stop_log_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), String> {
    let child = state.log_streams.lock().unwrap().remove(&stream_id);
    if let Some(mut child) = child {
        let _ = child.start_kill();
        // The exit-polling task spawned in `start_log_stream` will find the
        // stream already gone from the map and quietly stop rather than
        // emit `log-end` itself, so emit it here on the caller's behalf.
        let _ = app.emit(
            "log-end",
            LogEnd {
                stream_id,
                code: None,
            },
        );
    }
    Ok(())
}

/// Kill every tracked log stream child; used on app exit.
pub fn kill_all(state: &AppState) {
    let mut streams = state.log_streams.lock().unwrap();
    for (_, mut child) in streams.drain() {
        let _ = child.start_kill();
    }
}
