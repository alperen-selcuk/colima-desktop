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
const KUBECONFIG_MARKER: &str = "__KUBECONFIG__";

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

/// Extract the text between a pair of `marker` occurrences in `haystack`
/// (as printed by e.g. `printf "__PATH__%s__PATH__" "$PATH"`), or `None` if
/// the marker doesn't appear (twice).
fn extract_between_markers(haystack: &str, marker: &str) -> Option<String> {
    let start = haystack.find(marker)? + marker.len();
    let rest = &haystack[start..];
    let end = rest.find(marker)?;
    Some(rest[..end].to_string())
}

/// Result of resolving the user's login-interactive shell environment: its
/// `PATH` and (if set) its `KUBECONFIG`, fetched in a single shell
/// invocation so GUI apps (which inherit neither) can resolve both cheaply.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ShellEnv {
    path: Option<String>,
    kubeconfig: Option<String>,
}

/// Fetch the user's login-interactive shell `PATH` and `KUBECONFIG` by
/// running a single `$SHELL -ilc '...'` invocation with a 3s timeout, each
/// wrapped in its own pair of markers. Returns defaults (`None`/`None`) on
/// any failure (missing `$SHELL`, timeout, parse failure).
fn shell_env() -> ShellEnv {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    let shell_clone = shell.clone();
    let handle = std::thread::spawn(move || {
        let output = std::process::Command::new(&shell_clone)
            .args([
                "-ilc",
                "printf \"__PATH__%s__PATH____KUBECONFIG__%s__KUBECONFIG__\" \"$PATH\" \"$KUBECONFIG\"",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(output);
    });

    let Some(Ok(output)) = rx.recv_timeout(Duration::from_secs(3)).ok() else {
        return ShellEnv::default();
    };
    // don't block shutdown on a hung shell; detach the thread if it's slow.
    let _ = handle;

    let stdout = String::from_utf8_lossy(&output.stdout);
    ShellEnv {
        path: extract_between_markers(&stdout, PATH_MARKER),
        kubeconfig: extract_between_markers(&stdout, KUBECONFIG_MARKER).filter(|s| !s.is_empty()),
    }
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
/// their `~/.kube/config`. Fetched in one shell invocation (`shell_env`).
/// Every kubectl child command explicitly strips `KUBECONFIG` from its own
/// env regardless (§2.1a), so setting it here only affects that one lookup,
/// never what kubectl itself sees. Must run before any subprocess is
/// spawned.
pub fn fix_path() {
    let env = shell_env();
    std::env::set_var("PATH", merge_path(env.path.as_deref()));
    if let Some(kubeconfig) = env.kubeconfig {
        std::env::set_var("KUBECONFIG", kubeconfig);
    }
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
    fn parses_path_between_markers() {
        let stdout = format!("{}/foo:/bar{}", PATH_MARKER, PATH_MARKER);
        assert_eq!(extract_between_markers(&stdout, PATH_MARKER).as_deref(), Some("/foo:/bar"));
    }

    #[test]
    fn extract_between_markers_parses_both_path_and_kubeconfig() {
        let stdout = format!(
            "{}/foo:/bar{}{}/Users/x/.kube/config{}",
            PATH_MARKER, PATH_MARKER, KUBECONFIG_MARKER, KUBECONFIG_MARKER
        );
        assert_eq!(extract_between_markers(&stdout, PATH_MARKER).as_deref(), Some("/foo:/bar"));
        assert_eq!(
            extract_between_markers(&stdout, KUBECONFIG_MARKER).as_deref(),
            Some("/Users/x/.kube/config")
        );
    }

    #[test]
    fn extract_between_markers_missing_marker_is_none() {
        assert_eq!(extract_between_markers("no markers here", PATH_MARKER), None);
    }

    #[test]
    fn extract_between_markers_empty_value() {
        let stdout = format!("{}{}", KUBECONFIG_MARKER, KUBECONFIG_MARKER);
        assert_eq!(extract_between_markers(&stdout, KUBECONFIG_MARKER).as_deref(), Some(""));
    }
}
