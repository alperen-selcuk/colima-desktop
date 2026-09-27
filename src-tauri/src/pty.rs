//! In-app PTY terminal sessions (`terminal_open`/`terminal_write`/
//! `terminal_resize`/`terminal_close`), backed by `portable-pty`. Replaces
//! the old `open_terminal` external-terminal-launcher command: nothing
//! opens an OS terminal window anymore, everything is rendered by the
//! frontend's xterm.js dock against these commands and the
//! `terminal-output`/`terminal-exit` events.

use crate::state::AppState;
use crate::terminal::{build_command, TerminalTarget};
use crate::validate::validate_profile_name;
use base64::Engine;
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter, Manager, State};

/// Bytes read from the PTY per `read()` call, per §4.
const READ_CHUNK_SIZE: usize = 16 * 1024;

/// One live terminal session: the PTY master (for resize + re-cloning the
/// reader if ever needed) and its writer, plus the child so it can be
/// killed on `terminal_close`/app quit. The reader lives entirely inside
/// the blocking thread spawned by `terminal_open` and is not stored here.
pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub session_id: String,
    pub data: String, // base64 of raw PTY bytes
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub session_id: String,
    pub code: Option<i32>,
}

/// Build the env overrides applied on top of the (already PATH-fixed)
/// inherited process environment: `TERM`/`COLORTERM` forced,
/// `LANG` defaulted if unset, `DOCKER_HOST`/`DOCKER_CONTEXT` stripped (§2.2,
/// §4) so nothing overrides the explicit `-H`/`--context` flags baked into
/// the command itself.
fn apply_pty_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd.env_remove("DOCKER_HOST");
    cmd.env_remove("DOCKER_CONTEXT");
    cmd.env_remove("KUBECONFIG");
}

/// Build the `portable_pty::CommandBuilder` for `target`, applying cwd
/// (host target only, per §4) and the shared env overrides.
async fn build_pty_command(
    app: &AppHandle,
    state: &AppState,
    profile: Option<&str>,
    target: &TerminalTarget,
) -> Result<CommandBuilder, String> {
    let app = app.clone();
    let (program, args) = build_command(state, profile, target, move |profile| {
        let app = app.clone();
        async move { crate::kubeconfig::ensure_fresh(&app, &profile).await }
    })
    .await?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    if matches!(target, TerminalTarget::Host) {
        if let Some(home) = std::env::var_os("HOME") {
            cmd.cwd(home);
        }
    }
    apply_pty_env(&mut cmd);
    Ok(cmd)
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: Option<String>,
    target: TerminalTarget,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    if let Some(p) = &profile {
        validate_profile_name(p)?;
    }
    let cmd = build_pty_command(&app, &state, profile.as_deref(), &target).await?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave end is only needed to spawn the child; drop it so the
    // master is the sole owner of the pty on our side (standard
    // portable-pty usage — otherwise the master's reader never sees EOF
    // once the child exits, since the slave fd would still be open here).
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session_id = uuid::Uuid::new_v4().to_string();

    state.pty_sessions.lock().unwrap().insert(
        session_id.clone(),
        Session {
            master: pair.master,
            writer,
            child,
        },
    );

    spawn_reader_thread(app, session_id.clone(), reader);

    Ok(session_id)
}

/// Spawn the blocking OS thread that reads from the PTY master until EOF,
/// emitting `terminal-output` per chunk, then waits the child and emits
/// `terminal-exit`, removing the session from managed state.
///
/// This runs on `std::thread` (not a tokio task) because `Read::read` on a
/// pty reader is a blocking syscall with no async-friendly equivalent
/// exposed by `portable-pty`. `AppState` is 'static (owned by Tauri for the
/// process lifetime), so the thread re-fetches it from the `AppHandle`
/// rather than needing a borrow.
fn spawn_reader_thread(app_handle: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK_SIZE];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_handle.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }

        let state = app_handle.state::<AppState>();
        let code = {
            let mut sessions = state.pty_sessions.lock().unwrap();
            match sessions.get_mut(&session_id) {
                Some(session) => {
                    let code = session
                        .child
                        .wait()
                        .ok()
                        .map(|status| status.exit_code() as i32);
                    sessions.remove(&session_id);
                    code
                }
                // already removed by terminal_close
                None => return,
            }
        };

        let _ = app_handle.emit(
            "terminal-exit",
            TerminalExit {
                session_id: session_id.clone(),
                code,
            },
        );
    });
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.pty_sessions.lock().unwrap();
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("no terminal session {session_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.pty_sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("no terminal session {session_id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_close(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let session = state.pty_sessions.lock().unwrap().remove(&session_id);
    if let Some(mut session) = session {
        let _ = session.child.kill();
        // The reader thread spawned in `terminal_open` will find the
        // session already gone from the map once it notices EOF and
        // quietly stop rather than emit `terminal-exit` itself, so emit it
        // here on the caller's behalf (mirrors `stop_log_stream`).
        let _ = app.emit(
            "terminal-exit",
            TerminalExit {
                session_id,
                code: None,
            },
        );
    }
    Ok(())
}

/// Kill every tracked PTY session's child; used on app exit.
pub fn kill_all(state: &AppState) {
    let mut sessions = state.pty_sessions.lock().unwrap();
    for (_, mut session) in sessions.drain() {
        let _ = session.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real smoke test: opens an actual host PTY running `/bin/echo hi`
    /// and asserts the output contains "hi". Ignored by default (spawns a
    /// real process/pty) but has been run once to confirm the mechanism
    /// works end-to-end on this machine.
    #[test]
    #[ignore]
    fn host_pty_echo_smoke_test() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/echo");
        cmd.arg("hi");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");

        // Read to EOF *before* waiting the child, mirroring the real
        // `spawn_reader_thread` order: the pty's read side only sees EOF
        // once every write end is closed, so waiting first can race with
        // (or block past) the child's last writes never being observed by
        // this reader on some platforms.
        let mut output = String::new();
        reader.read_to_string(&mut output).ok();
        let _ = child.wait().expect("wait");

        assert!(output.contains("hi"), "expected output to contain 'hi', got: {output:?}");
    }
}
