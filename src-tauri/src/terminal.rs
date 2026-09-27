//! Pure command-building helpers shared by the in-app PTY terminal
//! (`crate::pty`): given a [`TerminalTarget`] and profile, resolve the
//! program + argv to spawn. No shell is ever invoked here — the PTY spawns
//! `program` with `args` directly via `portable_pty::CommandBuilder`, so
//! there is no shell-quoting concern (unlike the old external-terminal
//! `open_terminal`, which this module used to implement and which has been
//! removed: nothing opens an OS terminal window anymore).

use crate::colima::resolve_docker_socket;
use crate::k8s::{exec_pod_args, SHELL_FALLBACK};
use crate::state::AppState;
use serde::Deserialize;

/// What a terminal session is attached to.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalTarget {
    /// The user's local login shell, cwd `$HOME`. `profile` is ignored for
    /// this target.
    Host,
    /// `colima ssh -p <profile>`.
    Vm,
    Container {
        id: String,
    },
    #[serde(rename_all = "camelCase")]
    Pod {
        namespace: String,
        pod: String,
        container: Option<String>,
    },
}

/// Resolve the program and argv for `target`. `profile` is required for
/// `vm`/`container`/`pod` targets (validated by the caller) and ignored for
/// `host`.
pub async fn build_command(
    state: &AppState,
    profile: Option<&str>,
    target: &TerminalTarget,
) -> Result<(String, Vec<String>), String> {
    match target {
        TerminalTarget::Host => Ok((host_shell(), vec!["-l".to_string()])),
        TerminalTarget::Vm => {
            let profile = require_profile(profile)?;
            Ok(("colima".to_string(), vec!["ssh".to_string(), "-p".to_string(), profile.to_string()]))
        }
        TerminalTarget::Container { id } => {
            let profile = require_profile(profile)?;
            let socket = resolve_docker_socket(state, profile).await;
            Ok((
                "docker".to_string(),
                vec![
                    "-H".to_string(),
                    socket,
                    "exec".to_string(),
                    "-it".to_string(),
                    id.clone(),
                    "sh".to_string(),
                    "-c".to_string(),
                    SHELL_FALLBACK.to_string(),
                ],
            ))
        }
        TerminalTarget::Pod {
            namespace,
            pod,
            container,
        } => {
            let profile = require_profile(profile)?;
            Ok(("kubectl".to_string(), exec_pod_args(profile, namespace, pod, container.as_deref())))
        }
    }
}

fn require_profile(profile: Option<&str>) -> Result<&str, String> {
    profile.ok_or_else(|| "profile is required for this terminal target".to_string())
}

/// Pick the host login shell: `$SHELL` if it exists on disk, else the
/// first of `/bin/zsh`, `/bin/bash`, `/bin/sh` that exists.
pub fn host_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() && std::path::Path::new(&shell).is_file() {
            return shell;
        }
    }
    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    // Last resort: `sh` is required by POSIX to exist, even if somehow not
    // found above (e.g. a nonstandard filesystem layout).
    "/bin/sh".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn host_target_ignores_profile_and_runs_login_shell() {
        let state = AppState::default();
        let (program, args) = build_command(&state, None, &TerminalTarget::Host).await.unwrap();
        assert_eq!(program, host_shell());
        assert_eq!(args, vec!["-l".to_string()]);
    }

    #[tokio::test]
    async fn vm_target_requires_profile() {
        let state = AppState::default();
        let err = build_command(&state, None, &TerminalTarget::Vm).await.unwrap_err();
        assert!(err.contains("profile is required"));
    }

    #[tokio::test]
    async fn vm_target_builds_colima_ssh() {
        let state = AppState::default();
        let (program, args) = build_command(&state, Some("default"), &TerminalTarget::Vm).await.unwrap();
        assert_eq!(program, "colima");
        assert_eq!(args, vec!["ssh", "-p", "default"]);
    }

    #[tokio::test]
    async fn container_target_requires_profile() {
        let state = AppState::default();
        let target = TerminalTarget::Container { id: "abc123".to_string() };
        let err = build_command(&state, None, &target).await.unwrap_err();
        assert!(err.contains("profile is required"));
    }

    #[tokio::test]
    async fn container_target_builds_docker_exec_with_shell_fallback() {
        let state = AppState::default();
        state.cache_docker_socket("default", "unix:///tmp/docker.sock".to_string());
        let target = TerminalTarget::Container { id: "abc123".to_string() };
        let (program, args) = build_command(&state, Some("default"), &target).await.unwrap();
        assert_eq!(program, "docker");
        assert_eq!(
            args,
            vec!["-H", "unix:///tmp/docker.sock", "exec", "-it", "abc123", "sh", "-c", SHELL_FALLBACK]
        );
    }

    #[tokio::test]
    async fn pod_target_requires_profile() {
        let state = AppState::default();
        let target = TerminalTarget::Pod {
            namespace: "ns".to_string(),
            pod: "pod-1".to_string(),
            container: None,
        };
        let err = build_command(&state, None, &target).await.unwrap_err();
        assert!(err.contains("profile is required"));
    }

    #[tokio::test]
    async fn pod_target_builds_kubectl_exec_with_context_and_shell_fallback() {
        let state = AppState::default();
        let target = TerminalTarget::Pod {
            namespace: "ns".to_string(),
            pod: "pod-1".to_string(),
            container: Some("app".to_string()),
        };
        let (program, args) = build_command(&state, Some("default"), &target).await.unwrap();
        assert_eq!(program, "kubectl");
        assert_eq!(
            args,
            vec![
                "--context", "colima", "exec", "-it", "-n", "ns", "pod-1", "-c", "app", "--", "sh", "-c",
                SHELL_FALLBACK,
            ]
        );
    }

    #[test]
    fn host_shell_falls_back_when_shell_env_missing_file() {
        // SAFETY-ish: this mutates a process-global env var for the test;
        // acceptable in a single-threaded-per-test cargo test run since we
        // restore it immediately after reading the result.
        let prev = std::env::var("SHELL").ok();
        std::env::set_var("SHELL", "/nonexistent/definitely-not-a-shell");
        let shell = host_shell();
        assert!(shell == "/bin/zsh" || shell == "/bin/bash" || shell == "/bin/sh");
        match prev {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }

    #[test]
    fn host_shell_uses_shell_env_when_it_exists() {
        let prev = std::env::var("SHELL").ok();
        // /bin/sh exists on every macOS/Linux system.
        std::env::set_var("SHELL", "/bin/sh");
        assert_eq!(host_shell(), "/bin/sh");
        match prev {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }
}
