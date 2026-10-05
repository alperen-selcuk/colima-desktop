//! Process execution helpers: one-shot commands, JSON-lines parsing, and
//! streaming commands whose stdout/stderr are forwarded as `colima-op-log`
//! events while the process runs.

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Number of trailing lines kept (from combined stdout+stderr, in emission
/// order) to build the error message when a streamed command fails.
const TAIL_LINES: usize = 20;

/// Event payload for `colima-op-log`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpLog {
    pub profile: String,
    pub op: String,
    pub line: String,
}

/// Build a [`Command`] with a clean environment: `DOCKER_HOST`,
/// `DOCKER_CONTEXT`, and `KUBECONFIG` removed so nothing can override the
/// explicit `-H` socket / `--context`/`--kubeconfig` flags we always pass.
fn base_command(bin: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    cmd.env_remove("DOCKER_HOST");
    cmd.env_remove("DOCKER_CONTEXT");
    cmd.env_remove("KUBECONFIG");
    cmd.stdin(Stdio::null());
    cmd
}

/// Trim stderr if non-empty, else stdout. Used to build `Result::Err`
/// strings uniformly across commands.
fn trimmed_error(stdout: &str, stderr: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        stderr.to_string()
    } else {
        stdout.trim().to_string()
    }
}

/// Run `bin` with `args` to completion and return trimmed stdout on success.
/// On failure (non-zero exit or missing binary) returns `Err` with the
/// trimmed stderr (or stdout if stderr is empty). Missing binary yields
/// `"<bin> not found in PATH"`.
pub async fn run(bin: &str, args: &[&str]) -> Result<String, String> {
    let output = base_command(bin, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{bin} not found in PATH")
            } else {
                e.to_string()
            }
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        Err(trimmed_error(&stdout, &stderr))
    }
}

/// Run `bin` with `args` to completion and return stdout **regardless of
/// exit status** (empty string if the process couldn't even be spawned).
/// Unlike [`run`], a non-zero exit does not discard stdout: some commands
/// (e.g. `docker inspect id1 id2 id3` where one id has since disappeared)
/// still print successful results to stdout before failing overall. Only
/// use this for best-effort/batched lookups where partial data is
/// acceptable and the caller doesn't need the failure reason.
pub async fn run_capture_stdout(bin: &str, args: &[&str]) -> String {
    let output = base_command(bin, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;
    match output {
        Ok(output) => String::from_utf8_lossy(&output.stdout).to_string(),
        Err(_) => String::new(),
    }
}

/// Run `bin` with `args` and parse stdout as JSON-lines: one JSON value per
/// non-empty line (as emitted by `colima list --json`, `docker ps --format
/// '{{json .}}'`, etc). Empty stdout yields an empty vec.
pub async fn run_json_lines<T: for<'de> Deserialize<'de>>(
    bin: &str,
    args: &[&str],
) -> Result<Vec<T>, String> {
    let stdout = run(bin, args).await?;
    parse_json_lines(&stdout)
}

/// Parse pre-fetched text as JSON-lines (see [`run_json_lines`]).
pub fn parse_json_lines<T: for<'de> Deserialize<'de>>(stdout: &str) -> Result<Vec<T>, String> {
    let mut items = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: T = serde_json::from_str(line)
            .map_err(|e| format!("failed to parse JSON line: {e}\nline: {line}"))?;
        items.push(value);
    }
    Ok(items)
}

/// Parse pre-fetched text as either a single JSON array (e.g. `docker
/// compose ls --format json`, which prints `[...]`, not JSON-lines) or, for
/// robustness, JSON-lines if it isn't an array. Empty/whitespace-only input
/// yields an empty vec.
pub fn parse_json_lines_or_array<T: for<'de> Deserialize<'de>>(stdout: &str) -> Result<Vec<T>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    if trimmed.starts_with('[') {
        return serde_json::from_str(trimmed).map_err(|e| format!("failed to parse JSON array: {e}"));
    }
    parse_json_lines(trimmed)
}

/// Run `bin` with `args` to completion with extra environment variables set
/// (e.g. `DOCKER_HOST` for standalone `docker-compose`), returning trimmed
/// stdout on success or the trimmed stderr/stdout on failure — same
/// contract as [`run`].
pub async fn run_with_env(bin: &str, args: &[&str], env: &[(&str, &str)]) -> Result<String, String> {
    let mut cmd = base_command(bin, args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{bin} not found in PATH")
            } else {
                e.to_string()
            }
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        Err(trimmed_error(&stdout, &stderr))
    }
}

/// Run `bin` with `args`, streaming each stdout/stderr line as a
/// `colima-op-log` event (`OpLog { profile, op, line }`) as soon as it's
/// produced. Stdout and stderr are read concurrently so slow/interleaved
/// output from one stream doesn't block the other. Resolves once the
/// process exits: `Ok(())` on success, `Err(last_20_lines)` on failure.
pub async fn run_streaming(
    app: &AppHandle,
    bin: &str,
    args: &[&str],
    profile: &str,
    op: &str,
) -> Result<(), String> {
    run_streaming_with_env(app, bin, args, profile, op, &[], None).await
}

/// Like [`run_streaming`], but allows extra environment variables (e.g.
/// `DOCKER_HOST` for standalone `docker-compose`) and an optional working
/// directory (compose resolves relative paths inside the file, e.g. build
/// contexts and bind mounts, against the cwd it's run from).
pub async fn run_streaming_with_env(
    app: &AppHandle,
    bin: &str,
    args: &[&str],
    profile: &str,
    op: &str,
    env: &[(&str, &str)],
    cwd: Option<&std::path::Path>,
) -> Result<(), String> {
    let mut cmd = base_command(bin, args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{bin} not found in PATH")
        } else {
            e.to_string()
        }
    })?;

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let tx_out = tx.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_out.send(line);
        }
    });
    let tx_err = tx.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_err.send(line);
        }
    });
    drop(tx);

    let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    while let Some(line) = rx.recv().await {
        if tail.len() >= TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line.clone());
        let _ = app.emit(
            "colima-op-log",
            OpLog {
                profile: profile.to_string(),
                op: op.to_string(),
                line,
            },
        );
    }

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        let lines: Vec<String> = tail.into_iter().collect();
        Err(friendly_error(&lines, cfg!(target_os = "macos")))
    }
}

/// Extract the value of `msg="..."` from a logfmt-style line (handles `\"` escapes).
fn extract_msg(line: &str) -> Option<String> {
    let start = line.find("msg=\"")? + 5;
    let mut out = String::new();
    let mut chars = line[start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('n') => out.push(' '),
                Some(o) => {
                    out.push('\\');
                    out.push(o);
                }
                None => break,
            },
            '"' => return Some(out),
            _ => out.push(c),
        }
    }
    None
}

/// Turn the last output lines of a failed colima op into a user-facing message.
/// Prefers the `msg` of the last `level=fatal` line (else last `level=error`),
/// maps known cases to actionable hints, and falls back to the raw lines.
pub(crate) fn friendly_error(lines: &[String], macos: bool) -> String {
    let find = |level: &str| {
        let needle = format!("level={level}");
        lines
            .iter()
            .rev()
            .find(|l| l.contains(&needle))
            .and_then(|l| extract_msg(l))
    };
    let Some(msg) = find("fatal").or_else(|| find("error")) else {
        return lines.join("\n");
    };
    if msg.contains("dependency check failed for docker") && msg.contains("docker not found") {
        return if macos {
            "Docker CLI not found. Install it with `brew install docker`, or if it is installed but unlinked run `brew link docker`.".to_string()
        } else {
            "Docker CLI not found. Install your distribution's docker CLI package (e.g. `docker-ce-cli` or `docker.io`) and make sure `docker` is on your PATH.".to_string()
        };
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct Item {
        name: String,
    }

    #[test]
    fn parses_multiple_json_lines() {
        let input = "{\"name\":\"a\"}\n{\"name\":\"b\"}\n";
        let items: Vec<Item> = parse_json_lines(input).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "a");
        assert_eq!(items[1].name, "b");
    }

    #[test]
    fn empty_stdout_yields_empty_vec() {
        let items: Vec<Item> = parse_json_lines("").unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn skips_blank_lines() {
        let input = "{\"name\":\"a\"}\n\n   \n{\"name\":\"b\"}\n";
        let items: Vec<Item> = parse_json_lines(input).unwrap();
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn invalid_json_line_errors() {
        let input = "not json\n";
        let result: Result<Vec<Item>, String> = parse_json_lines(input);
        assert!(result.is_err());
    }

    const DOCKER_LINE: &str = "time=\"2026-10-06T10:00:00+03:00\" level=info msg=\"starting colima\" profile=default\ntime=\"2026-10-06T10:00:01+03:00\" level=fatal msg=\"dependency check failed for docker: docker not found, run 'brew install docker' to install\"";

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(String::from).collect()
    }

    #[test]
    fn friendly_error_maps_missing_docker() {
        let m = friendly_error(&lines(DOCKER_LINE), true);
        assert!(m.starts_with("Docker CLI not found. Install it with `brew install docker`"));
        assert!(m.contains("brew link docker"));
        let l = friendly_error(&lines(DOCKER_LINE), false);
        assert!(l.contains("distribution"));
        assert!(!l.contains("brew"));
    }

    #[test]
    fn friendly_error_extracts_fatal_then_error_msg() {
        let fatal = "level=error msg=\"minor\"\nlevel=fatal msg=\"boom \\\"x\\\"\" a=b";
        assert_eq!(friendly_error(&lines(fatal), true), "boom \"x\"");
        let err = "level=info msg=\"hi\"\nlevel=error msg=\"bad thing\"\nlevel=info msg=\"after\"";
        assert_eq!(friendly_error(&lines(err), true), "bad thing");
    }

    #[test]
    fn friendly_error_falls_back_to_raw_lines() {
        assert_eq!(friendly_error(&lines("plain\nlines"), true), "plain\nlines");
    }

    #[test]
    fn trimmed_error_prefers_stderr() {
        assert_eq!(trimmed_error("out\n", "  err  \n"), "err");
        assert_eq!(trimmed_error("  out  \n", ""), "out");
        assert_eq!(trimmed_error("", ""), "");
    }
}
