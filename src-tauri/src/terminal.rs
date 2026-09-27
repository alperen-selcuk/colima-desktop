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
/// `host`. `ensure_fresh_kubeconfig` is called for the `pod` target only, to
/// guarantee the app-managed kubeconfig is fresh before spawning (§2.1a) —
/// PTY sessions can't route through [`crate::kubeconfig::kubectl`]'s
/// retry-on-auth-error path the way one-shot commands do, so freshness must
/// be guaranteed up front instead. Taking it as an injected async closure
/// (rather than a concrete `AppHandle`) keeps this function unit-testable
/// without spinning up a mock Tauri app.
pub async fn build_command<F, Fut>(
    state: &AppState,
    profile: Option<&str>,
    target: &TerminalTarget,
    ensure_fresh_kubeconfig: F,
) -> Result<(String, Vec<String>), String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<std::path::PathBuf, String>>,
{
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
            let kubeconfig_path = ensure_fresh_kubeconfig(profile.to_string()).await?;
            let ctx = crate::validate::kube_context(profile);
            let mut args = vec![
                "--kubeconfig".to_string(),
                kubeconfig_path.to_string_lossy().to_string(),
                "--context".to_string(),
                ctx,
            ];
            args.extend(exec_pod_args(namespace, pod, container.as_deref()));
            Ok(("kubectl".to_string(), args))
        }
    }
}

fn require_profile(profile: Option<&str>) -> Result<&str, String> {
    profile.ok_or_else(|| "profile is required for this terminal target".to_string())
}

/// Pick the host login shell: `shell_env` if it exists on disk (per
/// `is_file`), else the first of `/bin/zsh`, `/bin/bash`, `/bin/sh` that
/// exists. Pure function so tests can inject values instead of mutating the
/// process-global `SHELL` env var.
fn pick_shell(shell_env: Option<&str>, is_file: impl Fn(&str) -> bool) -> String {
    if let Some(shell) = shell_env {
        if !shell.is_empty() && is_file(shell) {
            return shell.to_string();
        }
    }
    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if is_file(candidate) {
            return candidate.to_string();
        }
    }
    // Last resort: `sh` is required by POSIX to exist, even if somehow not
    // found above (e.g. a nonstandard filesystem layout).
    "/bin/sh".to_string()
}

/// Pick the host login shell: `$SHELL` if it exists on disk, else the
/// first of `/bin/zsh`, `/bin/bash`, `/bin/sh` that exists.
pub fn host_shell() -> String {
    pick_shell(std::env::var("SHELL").ok().as_deref(), |p| std::path::Path::new(p).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stub `ensure_fresh_kubeconfig` for tests: never actually touches
    /// colima/kubectl, just returns a fixed fake path so `pod` target tests
    /// can assert on the resulting argv.
    fn stub_ensure_fresh(profile: String) -> std::future::Ready<Result<std::path::PathBuf, String>> {
        std::future::ready(Ok(std::path::PathBuf::from(format!("/fake/kube/{profile}.yaml"))))
    }

    #[tokio::test]
    async fn host_target_ignores_profile_and_runs_login_shell() {
        let state = AppState::default();
        let (program, args) = build_command(&state, None, &TerminalTarget::Host, stub_ensure_fresh).await.unwrap();
        assert_eq!(program, host_shell());
        assert_eq!(args, vec!["-l".to_string()]);
    }

    #[tokio::test]
    async fn vm_target_requires_profile() {
        let state = AppState::default();
        let err = build_command(&state, None, &TerminalTarget::Vm, stub_ensure_fresh).await.unwrap_err();
        assert!(err.contains("profile is required"));
    }

    #[tokio::test]
    async fn vm_target_builds_colima_ssh() {
        let state = AppState::default();
        let (program, args) =
            build_command(&state, Some("default"), &TerminalTarget::Vm, stub_ensure_fresh).await.unwrap();
        assert_eq!(program, "colima");
        assert_eq!(args, vec!["ssh", "-p", "default"]);
    }

    #[tokio::test]
    async fn container_target_requires_profile() {
        let state = AppState::default();
        let target = TerminalTarget::Container { id: "abc123".to_string() };
        let err = build_command(&state, None, &target, stub_ensure_fresh).await.unwrap_err();
        assert!(err.contains("profile is required"));
    }

    #[tokio::test]
    async fn container_target_builds_docker_exec_with_shell_fallback() {
        let state = AppState::default();
        state.cache_docker_socket("default", "unix:///tmp/docker.sock".to_string());
        let target = TerminalTarget::Container { id: "abc123".to_string() };
        let (program, args) = build_command(&state, Some("default"), &target, stub_ensure_fresh).await.unwrap();
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
        let err = build_command(&state, None, &target, stub_ensure_fresh).await.unwrap_err();
        assert!(err.contains("profile is required"));
    }

    #[tokio::test]
    async fn pod_target_builds_kubectl_exec_with_kubeconfig_context_and_shell_fallback() {
        let state = AppState::default();
        let target = TerminalTarget::Pod {
            namespace: "ns".to_string(),
            pod: "pod-1".to_string(),
            container: Some("app".to_string()),
        };
        let (program, args) =
            build_command(&state, Some("default"), &target, stub_ensure_fresh).await.unwrap();
        assert_eq!(program, "kubectl");
        assert_eq!(
            args,
            vec![
                "--kubeconfig", "/fake/kube/default.yaml", "--context", "colima", "exec", "-it", "-n", "ns",
                "pod-1", "-c", "app", "--", "sh", "-c", SHELL_FALLBACK,
            ]
        );
    }

    #[test]
    fn pick_shell_uses_shell_env_when_it_exists() {
        assert_eq!(pick_shell(Some("/bin/sh"), |p| p == "/bin/sh"), "/bin/sh");
    }

    #[test]
    fn pick_shell_falls_back_to_zsh_when_shell_env_missing_file() {
        let shell = pick_shell(Some("/nonexistent/definitely-not-a-shell"), |p| p == "/bin/zsh");
        assert_eq!(shell, "/bin/zsh");
    }

    #[test]
    fn pick_shell_falls_back_to_bash_when_zsh_missing() {
        let shell = pick_shell(Some("/nonexistent/definitely-not-a-shell"), |p| p == "/bin/bash");
        assert_eq!(shell, "/bin/bash");
    }

    #[test]
    fn pick_shell_falls_back_to_sh_when_nothing_exists() {
        let shell = pick_shell(Some("/nonexistent/definitely-not-a-shell"), |_| false);
        assert_eq!(shell, "/bin/sh");
    }

    #[test]
    fn pick_shell_ignores_empty_shell_env() {
        let shell = pick_shell(Some(""), |p| p == "/bin/bash");
        assert_eq!(shell, "/bin/bash");
    }

    #[test]
    fn pick_shell_falls_back_when_shell_env_absent() {
        let shell = pick_shell(None, |p| p == "/bin/bash");
        assert_eq!(shell, "/bin/bash");
    }
}
