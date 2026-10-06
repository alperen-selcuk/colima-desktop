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

/// Printed before `env -0` so rc-file noise (prompt banners etc.) written to
/// stdout by an interactive shell never corrupts the first variable.
const ENV_MARKER: &str = "__COLIMA_DESKTOP_ENV__";

/// Expand a leading `~` to `home`, if given. Pure function so tests can
/// inject a home directory instead of mutating the process-global `HOME`
/// env var.
fn expand_home_with(path: &str, home: Option<&std::ffi::OsStr>) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// Parse the NUL-separated output of `env -0` (after [`ENV_MARKER`]) into
/// `(key, value)` pairs. Entries without a valid `NAME=` prefix are skipped.
pub fn parse_env_nul(stdout: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(stdout);
    let body = match text.find(ENV_MARKER) {
        Some(i) => &text[i + ENV_MARKER.len()..],
        None => return Vec::new(),
    };
    body.split('\0')
        .filter_map(|entry| {
            let (k, v) = entry.split_once('=')?;
            let valid = !k.is_empty()
                && !k.starts_with(|c: char| c.is_ascii_digit())
                && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            valid.then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// The user's full login-shell environment, captured once at startup by
/// [`fix_path`]. Empty if capture failed (callers then inherit the process env).
static LOGIN_ENV: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();

/// Full login-shell environment for host terminal sessions (may be empty).
pub fn login_env() -> &'static [(String, String)] {
    LOGIN_ENV.get().map(Vec::as_slice).unwrap_or(&[])
}

/// Capture the user's login-interactive shell environment with a single
/// `$SHELL -ilc 'printf MARKER; env -0'` and a 3s timeout. Empty on any
/// failure (missing `$SHELL`, timeout, parse failure).
fn capture_login_env() -> Vec<(String, String)> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let output = std::process::Command::new(&shell)
            .args(["-ilc", &format!("printf '%s' {ENV_MARKER}; env -0")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(output);
    });

    let Some(Ok(output)) = rx.recv_timeout(Duration::from_secs(3)).ok() else {
        return Vec::new();
    };
    // don't block shutdown on a hung shell; detach the thread if it's slow.
    let _ = handle;
    parse_env_nul(&output.stdout)
}

fn env_get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// Merge the shell `PATH` (if resolvable) with [`KNOWN_DIRS`] (expanded
/// against `home`), de-duplicated, preserving order (shell entries first).
/// Pure function so tests can inject `home` instead of mutating the
/// process-global `HOME` env var.
fn merge_path_with(shell_path: Option<&str>, home: Option<&std::ffi::OsStr>) -> String {
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
        let expanded = expand_home_with(dir, home).to_string_lossy().to_string();
        if seen.insert(expanded.clone()) {
            parts.push(expanded);
        }
    }

    parts.join(":")
}

/// Merge the shell `PATH` (if resolvable) with [`KNOWN_DIRS`], de-duplicated,
/// preserving order (shell entries first).
fn merge_path(shell_path: Option<&str>) -> String {
    merge_path_with(shell_path, std::env::var_os("HOME").as_deref())
}

/// Resolve and set the process `PATH` from the user's shell plus known
/// install directories, and (if the shell has one set) the process
/// `KUBECONFIG` — GUI apps on macOS inherit neither, but `kubeconfig.rs`'s
/// host-kubeconfig health check needs the user's real `KUBECONFIG` to find
/// their `~/.kube/config`. The whole login env is captured once and kept for
/// host terminal sessions ([`login_env`]). Every app-internal kubectl/docker
/// child command strips `KUBECONFIG`/`DOCKER_HOST` from its own env
/// regardless (§2.1a); host PTY shells do not. Must run before any
/// subprocess is spawned.
pub fn fix_path() {
    let env = capture_login_env();
    std::env::set_var("PATH", merge_path(env_get(&env, "PATH")));
    if let Some(kubeconfig) = env_get(&env, "KUBECONFIG").filter(|s| !s.is_empty()) {
        std::env::set_var("KUBECONFIG", kubeconfig);
    }
    let _ = LOGIN_ENV.set(env);
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
    /// Basename of the user's login shell (`zsh`, `bash`, ...), for the Terminal button label.
    pub shell: String,
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
        shell: crate::terminal::shell_name(&crate::terminal::host_shell()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_tilde() {
        let home = std::ffi::OsStr::new("/Users/test");
        assert_eq!(expand_home_with("~/.local/bin", Some(home)), PathBuf::from("/Users/test/.local/bin"));
        assert_eq!(expand_home_with("/usr/bin", Some(home)), PathBuf::from("/usr/bin"));
    }

    #[test]
    fn merge_path_dedupes_and_orders_shell_first() {
        let home = std::ffi::OsStr::new("/Users/test");
        let merged = merge_path_with(Some("/usr/local/bin:/usr/bin"), Some(home));
        let parts: Vec<&str> = merged.split(':').collect();
        assert_eq!(parts[0], "/usr/local/bin");
        // /usr/bin only appears once even though it's both in shell path and KNOWN_DIRS
        assert_eq!(parts.iter().filter(|p| **p == "/usr/bin").count(), 1);
        // known dirs still present
        assert!(parts.contains(&"/bin"));
    }

    #[test]
    fn merge_path_without_shell_path_still_has_known_dirs() {
        let home = std::ffi::OsStr::new("/Users/test");
        let merged = merge_path_with(None, Some(home));
        assert!(merged.contains("/usr/local/bin"));
        assert!(merged.contains("/opt/homebrew/bin"));
    }

    #[test]
    fn parse_env_nul_splits_entries_and_skips_noise() {
        let out = format!("banner text{ENV_MARKER}PATH=/a:/b\0KUBECONFIG=/k1:/k2\0MULTI=line1\nline2\0EMPTY=\0bad entry\09X=1\0");
        let env = parse_env_nul(out.as_bytes());
        assert_eq!(env_get(&env, "PATH"), Some("/a:/b"));
        assert_eq!(env_get(&env, "KUBECONFIG"), Some("/k1:/k2"));
        assert_eq!(env_get(&env, "MULTI"), Some("line1\nline2"));
        assert_eq!(env_get(&env, "EMPTY"), Some(""));
        assert_eq!(env.len(), 4);
    }

    #[test]
    fn parse_env_nul_without_marker_is_empty() {
        assert!(parse_env_nul(b"PATH=/a\0").is_empty());
    }

    #[test]
    fn parse_env_nul_value_may_contain_equals() {
        let out = format!("{ENV_MARKER}OPTS=a=b=c\0");
        assert_eq!(env_get(&parse_env_nul(out.as_bytes()), "OPTS"), Some("a=b=c"));
    }
}
