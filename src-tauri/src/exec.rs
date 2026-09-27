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

/// Build a [`Command`] with a clean environment: `DOCKER_HOST` and
/// `DOCKER_CONTEXT` removed so nothing can override the explicit `-H`
/// socket / `--context` flags we always pass.
fn base_command(bin: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    cmd.env_remove("DOCKER_HOST");
    cmd.env_remove("DOCKER_CONTEXT");
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
    let mut cmd = base_command(bin, args);
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
        let joined: Vec<String> = tail.into_iter().collect();
        Err(joined.join("\n"))
    }
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

    #[test]
    fn trimmed_error_prefers_stderr() {
        assert_eq!(trimmed_error("out\n", "  err  \n"), "err");
        assert_eq!(trimmed_error("  out  \n", ""), "out");
        assert_eq!(trimmed_error("", ""), "");
    }
}
