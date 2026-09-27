//! PATH resolution and environment info.
//!
//! GUI apps launched from Finder/dock on macOS (and many Linux desktop
//! environments) do not inherit the interactive shell `PATH`, so common
//! install locations for `colima`/`docker`/`kubectl` (Homebrew, linuxbrew,
//! nix, etc.) are often missing. We resolve the user's real shell `PATH`
//! once at startup and merge in a list of well-known directories, then set
//! it as the process `PATH` so every child process (including colima's own
//! subprocesses such as `limactl`/`qemu`) can find its dependencies.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

/// Directories appended to `PATH` if not already present, in order.
const KNOWN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "~/.local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "~/.nix-profile/bin",
    "/nix/var/nix/profiles/default/bin",
    "/run/current-system/sw/bin",
    "/snap/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

const PATH_MARKER: &str = "__PATH__";

/// Expand a leading `~` to the user's home directory.
fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// Fetch the user's login-interactive shell `PATH` by running
/// `$SHELL -ilc 'printf "__PATH__%s__PATH__" "$PATH"'` with a 3s timeout.
/// Returns `None` on any failure (missing `$SHELL`, timeout, parse failure).
fn shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    let shell_clone = shell.clone();
    let handle = std::thread::spawn(move || {
        let output = std::process::Command::new(&shell_clone)
            .args(["-ilc", "printf \"__PATH__%s__PATH__\" \"$PATH\""])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(output);
    });

    let output = rx.recv_timeout(Duration::from_secs(3)).ok()?.ok()?;
    // don't block shutdown on a hung shell; detach the thread if it's slow.
    let _ = handle;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let start = stdout.find(PATH_MARKER)? + PATH_MARKER.len();
    let rest = &stdout[start..];
    let end = rest.find(PATH_MARKER)?;
    Some(rest[..end].to_string())
}

/// Merge the shell `PATH` (if resolvable) with [`KNOWN_DIRS`], de-duplicated,
/// preserving order (shell entries first).
fn merge_path(shell_path: Option<&str>) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut parts: Vec<String> = Vec::new();

    if let Some(sp) = shell_path {
        for entry in std::env::split_paths(sp) {
            let s = entry.to_string_lossy().to_string();
            if !s.is_empty() && seen.insert(s.clone()) {
                parts.push(s);
            }
        }
    }

    for dir in KNOWN_DIRS {
        let expanded = expand_home(dir).to_string_lossy().to_string();
        if seen.insert(expanded.clone()) {
            parts.push(expanded);
        }
    }

    parts.join(":")
}

/// Resolve and set the process `PATH` from the user's shell plus known
/// install directories. Must run before any subprocess is spawned.
pub fn fix_path() {
    let resolved = merge_path(shell_path().as_deref());
    std::env::set_var("PATH", resolved);
}

/// Environment/tooling info surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub platform: String,
    pub arch: String,
    pub colima_version: Option<String>,
    pub docker_available: bool,
    pub kubectl_available: bool,
    pub limactl_available: bool,
    pub path: String,
}

/// Look up `bin` in the current `PATH`, the same way a shell would.
pub fn find_in_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    }
}

/// Gather [`EnvInfo`] for display in the frontend (versions, availability).
#[tauri::command]
pub async fn env_info() -> EnvInfo {
    let colima_version = crate::exec::run("colima", &["version"])
        .await
        .ok()
        .and_then(|out| out.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty());

    EnvInfo {
        platform: platform_name().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        colima_version,
        docker_available: find_in_path("docker").is_some(),
        kubectl_available: find_in_path("kubectl").is_some(),
        limactl_available: find_in_path("limactl").is_some(),
        path: std::env::var("PATH").unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_tilde() {
        std::env::set_var("HOME", "/Users/test");
        assert_eq!(expand_home("~/.local/bin"), PathBuf::from("/Users/test/.local/bin"));
        assert_eq!(expand_home("/usr/bin"), PathBuf::from("/usr/bin"));
    }

    #[test]
    fn merge_path_dedupes_and_orders_shell_first() {
        std::env::set_var("HOME", "/Users/test");
        let merged = merge_path(Some("/usr/local/bin:/usr/bin"));
        let parts: Vec<&str> = merged.split(':').collect();
        assert_eq!(parts[0], "/usr/local/bin");
        // /usr/bin only appears once even though it's both in shell path and KNOWN_DIRS
        assert_eq!(parts.iter().filter(|p| **p == "/usr/bin").count(), 1);
        // known dirs still present
        assert!(parts.contains(&"/bin"));
    }

    #[test]
    fn merge_path_without_shell_path_still_has_known_dirs() {
        std::env::set_var("HOME", "/Users/test");
        let merged = merge_path(None);
        assert!(merged.contains("/usr/local/bin"));
        assert!(merged.contains("/opt/homebrew/bin"));
    }

    #[test]
    fn parses_path_between_markers() {
        let stdout = format!("{}/foo:/bar{}", PATH_MARKER, PATH_MARKER);
        let start = stdout.find(PATH_MARKER).unwrap() + PATH_MARKER.len();
        let rest = &stdout[start..];
        let end = rest.find(PATH_MARKER).unwrap();
        assert_eq!(&rest[..end], "/foo:/bar");
    }
}
