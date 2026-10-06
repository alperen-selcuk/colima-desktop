//! App-managed kubeconfig (§2.1a, docs/SPEC.md). kubectl never reads the
//! user's `~/.kube/config` for colima clusters: instead we fetch
//! `/etc/rancher/k3s/k3s.yaml` from inside the VM via `colima ssh`, rewrite
//! it (rename `default` -> the kube context id, rewrite the server IP when
//! colima reports a non-127.0.0.1 address), and write it atomically with
//! mode 0600 to `<app_data_dir>/kube/<profile>.yaml`. Every kubectl call in
//! the app routes through [`kubectl`] here, which prepends `--kubeconfig
//! <file> --context <ctx>`, strips `KUBECONFIG` from the child env, and
//! retries once (after refreshing the file) on an auth/cert error.
//!
//! Also implements the *host* kubeconfig health check / repair
//! (`host_kubeconfig_health` / `repair_host_kubeconfig`), which touches the
//! user's real `~/.kube/config` — but ONLY the `users.<ctx>` /
//! `clusters.<ctx>` entries for the colima context, via `kubectl config
//! set`, after writing a timestamped backup. Never touches any other
//! user/cluster/context or current-context.

use crate::validate::kube_context;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tokio::process::Command as TokioCommand;

/// Subdirectory of the app data dir holding the app-managed kubeconfig
/// files, one per profile: `<app_data_dir>/kube/<profile>.yaml`.
const KUBE_SUBDIR: &str = "kube";

// ---------------------------------------------------------------------------
// Pure helpers: renaming, IP rewriting, error classification, stderr
// cleanup. Kept free of I/O so they're unit-testable without a VM/Tauri app.
// ---------------------------------------------------------------------------

/// Rewrite a fetched `/etc/rancher/k3s/k3s.yaml` (whose cluster/context/user
/// are all named `default`) so every `default` name becomes `ctx` — mirrors
/// what colima itself does when it writes `~/.kube/config` entries. Assumes
/// the standard k3s.yaml shape: one cluster, one context, one user, all
/// literally named `default`. Falls back to leaving the document as-is if it
/// doesn't parse as YAML (the caller treats that as an error separately).
pub fn rename_default_context(yaml: &str, ctx: &str) -> Result<String, String> {
    let mut doc: serde_yaml::Value =
        serde_yaml::from_str(yaml).map_err(|e| format!("failed to parse fetched kubeconfig: {e}"))?;

    rename_name_in_list(&mut doc, "clusters", "default", ctx);
    rename_name_in_list(&mut doc, "contexts", "default", ctx);
    rename_name_in_list(&mut doc, "users", "default", ctx);

    if let Some(mapping) = doc.as_mapping_mut() {
        // Rewrite the context's cluster/user refs and current-context too.
        if let Some(serde_yaml::Value::Sequence(contexts)) =
            mapping.get_mut(serde_yaml::Value::String("contexts".to_string()))
        {
            for c in contexts {
                if let Some(context_map) = c
                    .get_mut(serde_yaml::Value::String("context".to_string()))
                    .and_then(|v| v.as_mapping_mut())
                {
                    for key in ["cluster", "user"] {
                        if let Some(v) = context_map.get_mut(serde_yaml::Value::String(key.to_string())) {
                            if v.as_str() == Some("default") {
                                *v = serde_yaml::Value::String(ctx.to_string());
                            }
                        }
                    }
                }
            }
        }
        mapping.insert(
            serde_yaml::Value::String("current-context".to_string()),
            serde_yaml::Value::String(ctx.to_string()),
        );
    }

    serde_yaml::to_string(&doc).map_err(|e| format!("failed to serialize rewritten kubeconfig: {e}"))
}

/// Rename `name` -> `new_name` in every entry of `doc.<list_key>[].name`.
fn rename_name_in_list(doc: &mut serde_yaml::Value, list_key: &str, name: &str, new_name: &str) {
    let Some(mapping) = doc.as_mapping_mut() else { return };
    let Some(serde_yaml::Value::Sequence(items)) =
        mapping.get_mut(serde_yaml::Value::String(list_key.to_string()))
    else {
        return;
    };
    for item in items {
        if let Some(item_map) = item.as_mapping_mut() {
            if let Some(v) = item_map.get_mut(serde_yaml::Value::String("name".to_string())) {
                if v.as_str() == Some(name) {
                    *v = serde_yaml::Value::String(new_name.to_string());
                }
            }
        }
    }
}

/// Rewrite `https://127.0.0.1:<port>` -> `https://<ip>:<port>` in `yaml`'s
/// `clusters[].cluster.server` fields, when `ip` is non-empty and not itself
/// `127.0.0.1` (per §2.1a: colima only ever needs this when `colima status`
/// reports a real routable VM address; otherwise the VM's own k3s.yaml
/// already correctly points at 127.0.0.1 via the forwarded port and must be
/// left alone). Pure string replacement (not full YAML surgery) since the
/// value is always exactly `https://127.0.0.1:<port>`.
pub fn rewrite_server_ip(yaml: &str, ip: &str) -> String {
    if ip.is_empty() || ip == "127.0.0.1" {
        return yaml.to_string();
    }
    yaml.replace("https://127.0.0.1:", &format!("https://{ip}:"))
}

/// Whether `stderr`/error text looks like an auth/cert failure that a
/// refreshed kubeconfig might fix, per §2.1a's list: "provide credentials",
/// "Unauthorized", "x509", "certificate".
pub fn is_auth_error(text: &str) -> bool {
    let needles = ["provide credentials", "Unauthorized", "x509", "certificate"];
    needles.iter().any(|n| text.contains(n))
}

/// Strip kubectl/client-go stderr noise lines (e.g. `E0927 12:34:56.789012
/// 12345 memcache.go:123] ...`) from a multi-line error message, keeping the
/// remaining meaningful line(s). If stripping would remove everything, the
/// original text is returned unchanged so no error message ever goes empty.
pub fn strip_kubectl_noise(text: &str) -> String {
    fn is_noise_line(line: &str) -> bool {
        let mut chars = line.trim_start().chars();
        let Some(level) = chars.next() else { return false };
        if !matches!(level, 'E' | 'W' | 'I') {
            return false;
        }
        // Next 4 chars must be digits (MMDD).
        let rest: String = chars.by_ref().take(4).collect();
        if rest.len() != 4 || !rest.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        // Somewhere later in the line, a "<file>.go:<line>]" marker.
        line.contains(".go:") && line.contains(']')
    }

    let kept: Vec<&str> = text.lines().filter(|l| !is_noise_line(l)).collect();
    let joined = kept.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        text.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Friendly wrapper for "Kubernetes is not reachable: <reason>" errors used
/// when the app-managed kubeconfig can't be produced/found (§2.1a).
pub fn not_reachable(reason: impl std::fmt::Display) -> String {
    format!("Kubernetes is not reachable: {reason}")
}

// ---------------------------------------------------------------------------
// App-managed kubeconfig: fetch, write, path resolution.
// ---------------------------------------------------------------------------

/// `<app_data_dir>/kube/<profile>.yaml`.
pub fn kube_file_path(app_data_dir: &Path, profile: &str) -> PathBuf {
    app_data_dir.join(KUBE_SUBDIR).join(format!("{profile}.yaml"))
}

/// Parse `colima status --json -p <profile>`'s `ip_address` field, used to
/// decide whether the server URL needs rewriting. Returns `""` on any
/// failure (missing binary, non-running profile, parse error) — callers
/// treat that the same as "no rewrite needed", matching `rewrite_server_ip`.
async fn colima_ip_address(profile: &str) -> String {
    let Ok(stdout) = crate::exec::run("colima", &["status", "--json", "-p", profile]).await else {
        return String::new();
    };
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .and_then(|v| v["ip_address"].as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Fetch `/etc/rancher/k3s/k3s.yaml` from inside the VM via `colima ssh -p
/// <profile> -- sudo cat /etc/rancher/k3s/k3s.yaml`.
async fn fetch_k3s_yaml(profile: &str) -> Result<String, String> {
    crate::exec::run("colima", &["ssh", "-p", profile, "--", "sudo", "cat", "/etc/rancher/k3s/k3s.yaml"]).await
}

/// Write `content` atomically (temp file in the same directory + rename)
/// with mode 0600, creating parent directories as needed.
fn write_atomic_0600(path: &Path, content: &str) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "invalid kubeconfig path".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("failed to create kube directory: {e}"))?;

    let file_name = path
        .file_name()
        .ok_or_else(|| "invalid kubeconfig path".to_string())?
        .to_string_lossy();
    let tmp_path = dir.join(format!(".{file_name}.tmp-{}", std::process::id()));

    let result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp_path).map_err(|e| format!("failed to write kubeconfig: {e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("failed to write kubeconfig: {e}"))?;
        file.sync_all().map_err(|e| format!("failed to write kubeconfig: {e}"))?;
        let mut perms = file
            .metadata()
            .map_err(|e| format!("failed to write kubeconfig: {e}"))?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&tmp_path, perms).map_err(|e| format!("failed to write kubeconfig: {e}"))?;
        Ok(())
    })();

    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    std::fs::rename(&tmp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("failed to write kubeconfig: {e}")
    })
}

/// Fetch + rewrite + write the app-managed kubeconfig for `profile` at
/// `app_data_dir`. This is the single entry point the live test can call
/// directly (no Tauri `AppHandle` needed), and what [`refresh`] wraps for
/// command use.
pub async fn fetch_and_write(app_data_dir: &Path, profile: &str) -> Result<PathBuf, String> {
    let raw = fetch_k3s_yaml(profile)
        .await
        .map_err(|e| not_reachable(strip_kubectl_noise(&e)))?;
    let ctx = kube_context(profile);
    let renamed = rename_default_context(&raw, &ctx)?;
    let ip = colima_ip_address(profile).await;
    let rewritten = rewrite_server_ip(&renamed, &ip);

    let path = kube_file_path(app_data_dir, profile);
    write_atomic_0600(&path, &rewritten)?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Per-session "fresh" flags + the shared `kubectl` helper.
// ---------------------------------------------------------------------------

/// Tracks, per profile, whether the app-managed kubeconfig file has been
/// (re)fetched at least once this session. Lives in [`crate::state::AppState`].
#[derive(Default)]
pub struct KubeconfigState {
    fresh: Mutex<std::collections::HashSet<String>>,
}

impl KubeconfigState {
    pub fn is_fresh(&self, profile: &str) -> bool {
        self.fresh.lock().unwrap().contains(profile)
    }

    pub fn mark_fresh(&self, profile: &str) {
        self.fresh.lock().unwrap().insert(profile.to_string());
    }

    /// Invalidate the fresh flag for `profile`, forcing the next [`kubectl`]
    /// call to refetch before running. Called after `kubernetes_action` and
    /// lifecycle ops (start/stop/restart/delete), per §2.1a.
    pub fn invalidate(&self, profile: &str) {
        self.fresh.lock().unwrap().remove(profile);
    }
}

/// Ensure the app-managed kubeconfig file exists and is marked fresh for
/// `profile` this session, fetching it if needed. Returns the file path.
pub async fn ensure_fresh(app: &AppHandle, profile: &str) -> Result<PathBuf, String> {
    let state = app.state::<crate::state::AppState>();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| not_reachable(format!("cannot resolve app data directory: {e}")))?;
    let path = kube_file_path(&app_data_dir, profile);

    if state.kubeconfig.is_fresh(profile) && path.is_file() {
        return Ok(path);
    }

    let written = fetch_and_write(&app_data_dir, profile).await?;
    state.kubeconfig.mark_fresh(profile);
    Ok(written)
}

/// Force a refetch of the app-managed kubeconfig for `profile`, regardless
/// of the fresh flag (used by the retry-once path on an auth error).
async fn force_refresh(app: &AppHandle, profile: &str) -> Result<PathBuf, String> {
    let state = app.state::<crate::state::AppState>();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| not_reachable(format!("cannot resolve app data directory: {e}")))?;
    let written = fetch_and_write(&app_data_dir, profile).await?;
    state.kubeconfig.mark_fresh(profile);
    Ok(written)
}

/// Build a clean `kubectl` child command: `--kubeconfig <file> --context
/// <ctx>` prepended to `args`, `KUBECONFIG` removed from the env so nothing
/// can override the explicit flag. `stdin_mode` lets callers that need to
/// pipe content in (e.g. `kubectl replace -f -`) request a piped stdin
/// instead of the default `Stdio::null()`.
fn build_kubectl_command_with_stdin(
    kubeconfig_path: &Path,
    ctx: &str,
    args: &[String],
    stdin_mode: Stdio,
) -> TokioCommand {
    let mut cmd = TokioCommand::new("kubectl");
    cmd.arg("--kubeconfig").arg(kubeconfig_path);
    cmd.arg("--context").arg(ctx);
    cmd.args(args);
    cmd.env_remove("KUBECONFIG");
    cmd.stdin(stdin_mode);
    cmd
}

fn build_kubectl_command(kubeconfig_path: &Path, ctx: &str, args: &[String]) -> TokioCommand {
    build_kubectl_command_with_stdin(kubeconfig_path, ctx, args, Stdio::null())
}

pub(crate) async fn run_kubectl_once(kubeconfig_path: &Path, ctx: &str, args: &[String]) -> Result<String, String> {
    let output = build_kubectl_command(kubeconfig_path, ctx, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "kubectl not found in PATH".to_string()
            } else {
                e.to_string()
            }
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        let raw = if !stderr.trim().is_empty() { stderr } else { stdout };
        Err(strip_kubectl_noise(raw.trim()))
    }
}

/// Same as [`run_kubectl_once`] but writes `stdin_content` to the child's
/// stdin instead of closing it. Used for `kubectl ... -f -` calls (e.g.
/// `k8s_apply_yaml`) so secret-bearing YAML never touches disk as a temp
/// file — it's piped directly into the kubectl child process.
pub(crate) async fn run_kubectl_once_with_stdin(
    kubeconfig_path: &Path,
    ctx: &str,
    args: &[String],
    stdin_content: &str,
) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let mut child = build_kubectl_command_with_stdin(kubeconfig_path, ctx, args, Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "kubectl not found in PATH".to_string()
            } else {
                e.to_string()
            }
        })?;

    // Write stdin then drop it (closing the pipe) before awaiting output, so
    // kubectl sees EOF and doesn't block waiting for more input.
    if let Some(mut stdin) = child.stdin.take() {
        let content = stdin_content.to_string();
        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|e| format!("failed to write to kubectl stdin: {e}"))?;
        drop(stdin);
    }

    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        let raw = if !stderr.trim().is_empty() { stderr } else { stdout };
        Err(strip_kubectl_noise(raw.trim()))
    }
}

/// The single helper every kubectl call in the app routes through (§2.1a):
/// ensures the app-managed kubeconfig for `profile` is fresh, runs `kubectl
/// --kubeconfig <file> --context <ctx> <args...>` with `KUBECONFIG` removed
/// from the child env, and — on an auth/cert error — refreshes the file and
/// retries exactly once.
pub async fn kubectl(app: &AppHandle, profile: &str, args: &[String]) -> Result<String, String> {
    let ctx = kube_context(profile);
    let path = ensure_fresh(app, profile).await?;

    match run_kubectl_once(&path, &ctx, args).await {
        Ok(out) => Ok(out),
        Err(e) if is_auth_error(&e) => {
            let refreshed_path = force_refresh(app, profile).await?;
            run_kubectl_once(&refreshed_path, &ctx, args).await
        }
        Err(e) => Err(e),
    }
}

/// Same as [`kubectl`] but pipes `stdin_content` into the child's stdin
/// (never writes it to a temp file), for calls like `kubectl replace -f -`.
/// Keeps the same fresh-kubeconfig + retry-once-on-auth-error semantics.
pub async fn kubectl_with_stdin(
    app: &AppHandle,
    profile: &str,
    args: &[String],
    stdin_content: &str,
) -> Result<String, String> {
    let ctx = kube_context(profile);
    let path = ensure_fresh(app, profile).await?;

    match run_kubectl_once_with_stdin(&path, &ctx, args, stdin_content).await {
        Ok(out) => Ok(out),
        Err(e) if is_auth_error(&e) => {
            let refreshed_path = force_refresh(app, profile).await?;
            run_kubectl_once_with_stdin(&refreshed_path, &ctx, args, stdin_content).await
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Host kubeconfig health check + repair (§2.1a).
// ---------------------------------------------------------------------------

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKubeconfigHealth {
    pub context_exists: bool,
    pub credentials_match: bool,
    pub detail: String,
}

/// SHA-256 hex digest of `data`, used to compare base64 cert blobs without
/// ever printing/logging the actual bytes.
fn sha256_hex(data: &[u8]) -> String {
    // Minimal, dependency-free SHA-256 (no external crate pulled in just for
    // a health-check hash). Implementation below is a standard, unoptimized
    // reference implementation.
    sha256::hex(data)
}

/// Resolve the user's kubeconfig path: first path of `KUBECONFIG` (from the
/// login-shell-captured env var, see [`crate::env`]), else `~/.kube/config`.
pub fn resolve_user_kubeconfig_path(kubeconfig_env: Option<&str>, home_env: Option<&str>) -> PathBuf {
    if let Some(kc) = kubeconfig_env {
        if !kc.is_empty() {
            if let Some(first) = kc.split(':').next() {
                if !first.is_empty() {
                    return PathBuf::from(first);
                }
            }
        }
    }
    let home = home_env.unwrap_or(".");
    PathBuf::from(home).join(".kube").join("config")
}

/// Extract `users.<ctx>.client-certificate-data` and
/// `clusters.<ctx>.certificate-authority-data` (base64 strings, as stored)
/// from a parsed kubeconfig YAML document. Returns `(user_cert, ca_cert)`,
/// each `None` if the named entry or field is missing.
fn extract_colima_entries(doc: &serde_yaml::Value, ctx: &str) -> (Option<String>, Option<String>) {
    let user_cert = find_named(doc, "users", ctx)
        .and_then(|u| u.get("user"))
        .and_then(|u| u.get("client-certificate-data"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let ca_cert = find_named(doc, "clusters", ctx)
        .and_then(|c| c.get("cluster"))
        .and_then(|c| c.get("certificate-authority-data"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    (user_cert, ca_cert)
}

fn find_named<'a>(doc: &'a serde_yaml::Value, list_key: &str, name: &str) -> Option<&'a serde_yaml::Value> {
    doc.get(list_key)?.as_sequence()?.iter().find(|item| item.get("name").and_then(|n| n.as_str()) == Some(name))
}

/// Pure comparison: given the parsed user kubeconfig doc and the parsed
/// app-managed kubeconfig doc (both already YAML), decide whether `ctx`
/// exists in the user's file and whether its client-cert/CA hashes match the
/// app-managed file's.
pub fn compare_kubeconfigs(user_doc: &serde_yaml::Value, app_doc: &serde_yaml::Value, ctx: &str) -> HostKubeconfigHealth {
    let (user_cert, user_ca) = extract_colima_entries(user_doc, ctx);
    let (app_cert, app_ca) = extract_colima_entries(app_doc, ctx);

    let context_exists = user_cert.is_some() && user_ca.is_some();
    if !context_exists {
        return HostKubeconfigHealth {
            context_exists: false,
            credentials_match: false,
            detail: format!("no `{ctx}` user/cluster entry found in your kubeconfig"),
        };
    }

    let (Some(app_cert), Some(app_ca)) = (app_cert, app_ca) else {
        return HostKubeconfigHealth {
            context_exists: true,
            credentials_match: false,
            detail: "app-managed kubeconfig is missing expected fields".to_string(),
        };
    };

    let cert_match = user_cert.as_deref().map(|c| hashes_match(c, &app_cert)).unwrap_or(false);
    let ca_match = user_ca.as_deref().map(|c| hashes_match(c, &app_ca)).unwrap_or(false);
    let credentials_match = cert_match && ca_match;

    let detail = if credentials_match {
        format!("`{ctx}` credentials in your kubeconfig match the running cluster")
    } else if !ca_match {
        format!("`{ctx}` cluster CA in your kubeconfig doesn't match the running cluster (cluster was likely recreated)")
    } else {
        format!("`{ctx}` client credentials in your kubeconfig are stale (k3s rotated its certificate)")
    };

    HostKubeconfigHealth { context_exists: true, credentials_match, detail }
}

fn hashes_match(a_b64: &str, b_b64: &str) -> bool {
    sha256_hex(a_b64.as_bytes()) == sha256_hex(b_b64.as_bytes())
}

#[tauri::command]
pub async fn host_kubeconfig_health(app: AppHandle, profile: String) -> Result<HostKubeconfigHealth, String> {
    crate::validate::validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);

    let app_kube_path = ensure_fresh(&app, &profile).await?;

    let app_content = std::fs::read_to_string(&app_kube_path)
        .map_err(|e| not_reachable(format!("cannot read app-managed kubeconfig: {e}")))?;
    let app_doc: serde_yaml::Value =
        serde_yaml::from_str(&app_content).map_err(|e| format!("failed to parse app-managed kubeconfig: {e}"))?;

    let kubeconfig_env = std::env::var("KUBECONFIG").ok();
    let home_env = std::env::var("HOME").ok();
    let user_path = resolve_user_kubeconfig_path(kubeconfig_env.as_deref(), home_env.as_deref());

    let user_content = match std::fs::read_to_string(&user_path) {
        Ok(c) => c,
        Err(e) => {
            return Ok(HostKubeconfigHealth {
                context_exists: false,
                credentials_match: false,
                detail: format!("cannot read {}: {e}", user_path.display()),
            })
        }
    };
    let user_doc: serde_yaml::Value = serde_yaml::from_str(&user_content)
        .map_err(|e| format!("failed to parse {}: {e}", user_path.display()))?;

    Ok(compare_kubeconfigs(&user_doc, &app_doc, &ctx))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    pub backup_path: String,
}

/// Update ONLY `users.<ctx>` client-certificate-data/client-key-data and
/// `clusters.<ctx>` certificate-authority-data/server in the user's
/// kubeconfig at `user_path`, copying those fields from the app-managed
/// kubeconfig at `app_path`. Writes a timestamped backup first. Never
/// touches any other user/cluster/context or current-context.
async fn repair_at(user_path: &Path, app_path: &Path, ctx: &str) -> Result<RepairResult, String> {
    let app_content = std::fs::read_to_string(app_path)
        .map_err(|e| not_reachable(format!("cannot read app-managed kubeconfig: {e}")))?;
    let app_doc: serde_yaml::Value =
        serde_yaml::from_str(&app_content).map_err(|e| format!("failed to parse app-managed kubeconfig: {e}"))?;

    let user_cluster = find_named(&app_doc, "clusters", ctx)
        .and_then(|c| c.get("cluster"))
        .ok_or_else(|| format!("app-managed kubeconfig has no `{ctx}` cluster entry"))?;
    let server = user_cluster
        .get("server")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "app-managed kubeconfig cluster entry has no server".to_string())?
        .to_string();
    let ca_data = user_cluster
        .get("certificate-authority-data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "app-managed kubeconfig cluster entry has no CA data".to_string())?
        .to_string();

    let user_user = find_named(&app_doc, "users", ctx)
        .and_then(|u| u.get("user"))
        .ok_or_else(|| format!("app-managed kubeconfig has no `{ctx}` user entry"))?;
    let cert_data = user_user
        .get("client-certificate-data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "app-managed kubeconfig user entry has no client certificate".to_string())?
        .to_string();
    let key_data = user_user
        .get("client-key-data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "app-managed kubeconfig user entry has no client key".to_string())?
        .to_string();

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // The file may not exist yet (first-time merge): nothing to back up then.
    let backup_path = if user_path.is_file() {
        let bp = format!("{}.colima-desktop-bak-{ts}", user_path.display());
        std::fs::copy(user_path, &bp).map_err(|e| format!("failed to back up kubeconfig: {e}"))?;
        bp
    } else {
        String::new()
    };

    let user_path_str = user_path.to_string_lossy().to_string();
    let sets: [(String, String); 4] = [
        (format!("clusters.{ctx}.certificate-authority-data"), ca_data),
        (format!("clusters.{ctx}.server"), server),
        (format!("users.{ctx}.client-certificate-data"), cert_data),
        (format!("users.{ctx}.client-key-data"), key_data),
    ];

    for (path_key, value) in &sets {
        let args = [
            "config".to_string(),
            "set".to_string(),
            path_key.clone(),
            value.clone(),
            "--kubeconfig".to_string(),
            user_path_str.clone(),
            "--set-raw-bytes=false".to_string(),
        ];
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::exec::run("kubectl", &arg_refs)
            .await
            .map_err(|e| format!("failed to update {path_key}: {e}"))?;
    }

    // Add the context itself when it doesn't exist yet (merge case). An
    // existing context is left alone; current-context is never touched.
    let has_context = std::fs::read_to_string(user_path)
        .ok()
        .and_then(|c| serde_yaml::from_str::<serde_yaml::Value>(&c).ok())
        .map(|d| find_named(&d, "contexts", ctx).is_some())
        .unwrap_or(false);
    if !has_context {
        for (key, value) in [(format!("contexts.{ctx}.cluster"), ctx), (format!("contexts.{ctx}.user"), ctx)] {
            let args = [
                "config",
                "set",
                key.as_str(),
                value,
                "--kubeconfig",
                user_path_str.as_str(),
            ];
            crate::exec::run("kubectl", &args)
                .await
                .map_err(|e| format!("failed to update {key}: {e}"))?;
        }
    }

    Ok(RepairResult { backup_path })
}

#[tauri::command]
pub async fn repair_host_kubeconfig(app: AppHandle, profile: String) -> Result<RepairResult, String> {
    crate::validate::validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);

    let app_kube_path = force_refresh(&app, &profile).await?;

    let kubeconfig_env = std::env::var("KUBECONFIG").ok();
    let home_env = std::env::var("HOME").ok();
    let user_path = resolve_user_kubeconfig_path(kubeconfig_env.as_deref(), home_env.as_deref());

    repair_at(&user_path, &app_kube_path, &ctx).await
}

// ---------------------------------------------------------------------------
// Kubernetes "Connect" panel (v0.2.3): read / export / merge the kubeconfig.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigInfo {
    pub path: String,
    pub context: String,
    pub server: String,
    pub content: String,
}

/// API server URL of cluster `ctx` in a kubeconfig document ("" if absent).
pub fn server_of(content: &str, ctx: &str) -> String {
    serde_yaml::from_str::<serde_yaml::Value>(content)
        .ok()
        .and_then(|d| {
            find_named(&d, "clusters", ctx)
                .and_then(|c| c.get("cluster"))
                .and_then(|c| c.get("server"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// Validate a user-chosen export destination: must be absolute, must not be
/// the user's own kubeconfig (`user_cfg`) nor a directory.
pub fn validate_export_path(path: &str, user_cfg: &Path) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if path.trim().is_empty() || !p.is_absolute() {
        return Err("choose an absolute file path".to_string());
    }
    if p.is_dir() {
        return Err("that path is a directory".to_string());
    }
    let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    };
    // A not-yet-existing target can't be canonicalized; compare its parent too.
    let parent_same = p
        .parent()
        .zip(user_cfg.parent())
        .map(|(a, b)| same(a, b) && p.file_name() == user_cfg.file_name())
        .unwrap_or(false);
    if same(&p, user_cfg) || parent_same {
        return Err("refusing to overwrite your own kubeconfig — use \"Merge into ~/.kube/config\" instead".to_string());
    }
    Ok(p)
}

fn user_kubeconfig_path() -> PathBuf {
    let kubeconfig_env = std::env::var("KUBECONFIG").ok();
    let home_env = std::env::var("HOME").ok();
    resolve_user_kubeconfig_path(kubeconfig_env.as_deref(), home_env.as_deref())
}

/// App-managed kubeconfig for `profile` (refreshed first): path, context
/// name, API server and the file content.
#[tauri::command]
pub async fn k8s_kubeconfig(app: AppHandle, profile: String) -> Result<KubeconfigInfo, String> {
    crate::validate::validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let path = ensure_fresh(&app, &profile).await?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| not_reachable(format!("cannot read app-managed kubeconfig: {e}")))?;
    Ok(KubeconfigInfo {
        path: path.to_string_lossy().to_string(),
        server: server_of(&content, &ctx),
        context: ctx,
        content,
    })
}

/// Write the app-managed kubeconfig to `path` (mode 0600). Rejects the
/// user's own kubeconfig as a destination. Returns the written path.
#[tauri::command]
pub async fn k8s_export_kubeconfig(app: AppHandle, profile: String, path: String) -> Result<String, String> {
    crate::validate::validate_profile_name(&profile)?;
    let target = validate_export_path(&path, &user_kubeconfig_path())?;
    let src = ensure_fresh(&app, &profile).await?;
    let content = std::fs::read_to_string(&src)
        .map_err(|e| not_reachable(format!("cannot read app-managed kubeconfig: {e}")))?;
    write_atomic_0600(&target, &content)?;
    Ok(target.to_string_lossy().to_string())
}

/// Merge the colima user/cluster/context entries into the user's kubeconfig
/// (backup first when the file exists; never changes current-context).
#[tauri::command]
pub async fn k8s_merge_kubeconfig(app: AppHandle, profile: String) -> Result<RepairResult, String> {
    repair_host_kubeconfig(app, profile).await
}

/// Minimal, dependency-free SHA-256 implementation (FIPS 180-4), used only
/// to compare base64 cert blobs for equality without printing them.
mod sha256 {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
        0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
        0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
        0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    pub fn hex(data: &[u8]) -> String {
        digest(data).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn digest(data: &[u8]) -> [u8; 32] {
        let mut h: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ];

        let bit_len = (data.len() as u64) * 8;
        let mut msg = data.to_vec();
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bit_len.to_be_bytes());

        for chunk in msg.chunks(64) {
            let mut w = [0u32; 64];
            for i in 0..16 {
                w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
            }

            let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
                (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);

            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let ch = (e & f) ^ ((!e) & g);
                let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let maj = (a & b) ^ (a & c) ^ (b & c);
                let temp2 = s0.wrapping_add(maj);

                hh = g;
                g = f;
                f = e;
                e = d.wrapping_add(temp1);
                d = c;
                c = b;
                b = a;
                a = temp1.wrapping_add(temp2);
            }

            h[0] = h[0].wrapping_add(a);
            h[1] = h[1].wrapping_add(b);
            h[2] = h[2].wrapping_add(c);
            h[3] = h[3].wrapping_add(d);
            h[4] = h[4].wrapping_add(e);
            h[5] = h[5].wrapping_add(f);
            h[6] = h[6].wrapping_add(g);
            h[7] = h[7].wrapping_add(hh);
        }

        let mut out = [0u8; 32];
        for (i, word) in h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn empty_string_known_vector() {
            assert_eq!(hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        }

        #[test]
        fn abc_known_vector() {
            assert_eq!(hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- rename_default_context ---------------------------------------------

    const SAMPLE_K3S_YAML: &str = r#"
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: Y2E=
    server: https://127.0.0.1:6443
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
preferences: {}
users:
- name: default
  user:
    client-certificate-data: Y2VydA==
    client-key-data: a2V5
"#;

    #[test]
    fn rename_default_context_renames_all_three_names() {
        let out = rename_default_context(SAMPLE_K3S_YAML, "colima").unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(doc["clusters"][0]["name"].as_str(), Some("colima"));
        assert_eq!(doc["contexts"][0]["name"].as_str(), Some("colima"));
        assert_eq!(doc["users"][0]["name"].as_str(), Some("colima"));
        assert_eq!(doc["contexts"][0]["context"]["cluster"].as_str(), Some("colima"));
        assert_eq!(doc["contexts"][0]["context"]["user"].as_str(), Some("colima"));
        assert_eq!(doc["current-context"].as_str(), Some("colima"));
    }

    #[test]
    fn rename_default_context_preserves_cert_data() {
        let out = rename_default_context(SAMPLE_K3S_YAML, "colima-rosetta").unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(doc["users"][0]["user"]["client-certificate-data"].as_str(), Some("Y2VydA=="));
        assert_eq!(doc["clusters"][0]["cluster"]["certificate-authority-data"].as_str(), Some("Y2E="));
    }

    #[test]
    fn rename_default_context_rejects_invalid_yaml() {
        let err = rename_default_context("not: [valid yaml", "colima").unwrap_err();
        assert!(err.contains("failed to parse"));
    }

    // --- rewrite_server_ip ---------------------------------------------------

    #[test]
    fn rewrite_server_ip_replaces_127_when_ip_given() {
        let yaml = "server: https://127.0.0.1:6443\n";
        let out = rewrite_server_ip(yaml, "192.168.5.2");
        assert_eq!(out, "server: https://192.168.5.2:6443\n");
    }

    #[test]
    fn rewrite_server_ip_noop_when_ip_empty() {
        let yaml = "server: https://127.0.0.1:6443\n";
        assert_eq!(rewrite_server_ip(yaml, ""), yaml);
    }

    #[test]
    fn rewrite_server_ip_noop_when_ip_is_localhost() {
        let yaml = "server: https://127.0.0.1:6443\n";
        assert_eq!(rewrite_server_ip(yaml, "127.0.0.1"), yaml);
    }

    #[test]
    fn rewrite_server_ip_preserves_port() {
        let yaml = "server: https://127.0.0.1:50614\n";
        let out = rewrite_server_ip(yaml, "10.0.0.5");
        assert_eq!(out, "server: https://10.0.0.5:50614\n");
    }

    // --- is_auth_error --------------------------------------------------------

    #[test]
    fn detects_provide_credentials_error() {
        assert!(is_auth_error(
            "error: You must be logged in to the server (the server has asked for the client to provide credentials)"
        ));
    }

    #[test]
    fn detects_unauthorized_error() {
        assert!(is_auth_error("Error from server (Unauthorized): pods is forbidden"));
    }

    #[test]
    fn detects_x509_error() {
        assert!(is_auth_error("Unable to connect to the server: x509: certificate signed by unknown authority"));
    }

    #[test]
    fn detects_certificate_error() {
        assert!(is_auth_error("tls: failed to verify certificate: x509: certificate has expired or is not yet valid"));
    }

    #[test]
    fn does_not_flag_unrelated_errors() {
        assert!(!is_auth_error("Error from server (NotFound): pods \"foo\" not found"));
        assert!(!is_auth_error("connection refused"));
    }

    // --- strip_kubectl_noise ---------------------------------------------------

    #[test]
    fn strips_memcache_noise_line() {
        let text = "E0927 12:34:56.789012   12345 memcache.go:265] couldn't get resource list\nerror: You must be logged in to the server";
        let out = strip_kubectl_noise(text);
        assert_eq!(out, "error: You must be logged in to the server");
    }

    #[test]
    fn strips_multiple_noise_lines_keeps_meaningful() {
        let text = "W0927 10:00:00.000000   1 foo.go:10] warning one\nE0927 10:00:01.000000   1 bar.go:20] warning two\nreal error here";
        let out = strip_kubectl_noise(text);
        assert_eq!(out, "real error here");
    }

    #[test]
    fn returns_original_when_all_lines_are_noise() {
        let text = "E0927 12:34:56.789012   12345 memcache.go:265] only noise";
        let out = strip_kubectl_noise(text);
        assert_eq!(out, text);
    }

    #[test]
    fn leaves_clean_text_unchanged() {
        let text = "error: pods \"foo\" not found";
        assert_eq!(strip_kubectl_noise(text), text);
    }

    #[test]
    fn does_not_strip_lines_without_go_file_marker() {
        let text = "Error message that happens to start with E0927 but isn't noise";
        // No ".go:" marker and no ']' -> not stripped.
        assert_eq!(strip_kubectl_noise(text), text);
    }

    // --- kube_file_path ---------------------------------------------------

    #[test]
    fn kube_file_path_is_scoped_per_profile() {
        let dir = Path::new("/tmp/app-data");
        assert_eq!(kube_file_path(dir, "default"), PathBuf::from("/tmp/app-data/kube/default.yaml"));
        assert_eq!(kube_file_path(dir, "rosetta"), PathBuf::from("/tmp/app-data/kube/rosetta.yaml"));
    }

    // --- resolve_user_kubeconfig_path ---------------------------------------

    #[test]
    fn resolve_user_kubeconfig_prefers_kubeconfig_env() {
        let p = resolve_user_kubeconfig_path(Some("/custom/config"), Some("/Users/x"));
        assert_eq!(p, PathBuf::from("/custom/config"));
    }

    #[test]
    fn resolve_user_kubeconfig_takes_first_path_entry() {
        let p = resolve_user_kubeconfig_path(Some("/a/config:/b/config"), Some("/Users/x"));
        assert_eq!(p, PathBuf::from("/a/config"));
    }

    #[test]
    fn resolve_user_kubeconfig_falls_back_to_home_dot_kube() {
        let p = resolve_user_kubeconfig_path(None, Some("/Users/x"));
        assert_eq!(p, PathBuf::from("/Users/x/.kube/config"));
    }

    #[test]
    fn resolve_user_kubeconfig_ignores_empty_env() {
        let p = resolve_user_kubeconfig_path(Some(""), Some("/Users/x"));
        assert_eq!(p, PathBuf::from("/Users/x/.kube/config"));
    }

    // --- compare_kubeconfigs ---------------------------------------------------

    fn doc(yaml: &str) -> serde_yaml::Value {
        serde_yaml::from_str(yaml).unwrap()
    }

    const APP_DOC_YAML: &str = r#"
clusters:
- name: colima
  cluster:
    certificate-authority-data: Y2FfYQ==
    server: https://127.0.0.1:6443
users:
- name: colima
  user:
    client-certificate-data: Y2VydF9h
    client-key-data: a2V5X2E=
"#;

    #[test]
    fn compare_reports_missing_context() {
        let user = doc("clusters: []\nusers: []\n");
        let app = doc(APP_DOC_YAML);
        let health = compare_kubeconfigs(&user, &app, "colima");
        assert!(!health.context_exists);
        assert!(!health.credentials_match);
    }

    #[test]
    fn compare_reports_match_when_certs_identical() {
        let user = doc(APP_DOC_YAML);
        let app = doc(APP_DOC_YAML);
        let health = compare_kubeconfigs(&user, &app, "colima");
        assert!(health.context_exists);
        assert!(health.credentials_match);
    }

    #[test]
    fn compare_reports_mismatch_when_client_cert_differs() {
        let user_yaml = APP_DOC_YAML.replace("Y2VydF9h", "RElGRkVSRU5U");
        let user = doc(&user_yaml);
        let app = doc(APP_DOC_YAML);
        let health = compare_kubeconfigs(&user, &app, "colima");
        assert!(health.context_exists);
        assert!(!health.credentials_match);
        assert!(health.detail.contains("stale"));
    }

    #[test]
    fn compare_reports_mismatch_when_ca_differs() {
        let user_yaml = APP_DOC_YAML.replace("Y2FfYQ==", "RElGRkVSRU5U");
        let user = doc(&user_yaml);
        let app = doc(APP_DOC_YAML);
        let health = compare_kubeconfigs(&user, &app, "colima");
        assert!(!health.credentials_match);
        assert!(health.detail.contains("recreated"));
    }

    // --- KubeconfigState -----------------------------------------------------

    #[test]
    fn server_of_reads_cluster_server() {
        let y = "clusters:\n- name: colima\n  cluster:\n    server: https://127.0.0.1:6443\n";
        assert_eq!(server_of(y, "colima"), "https://127.0.0.1:6443");
        assert_eq!(server_of(y, "other"), "");
        assert_eq!(server_of("not: [valid", "colima"), "");
    }

    #[test]
    fn export_path_rejects_relative_empty_and_user_kubeconfig() {
        let user = Path::new("/nonexistent-home/.kube/config");
        assert!(validate_export_path("", user).is_err());
        assert!(validate_export_path("kubeconfig.yaml", user).is_err());
        let e = validate_export_path("/nonexistent-home/.kube/config", user).unwrap_err();
        assert!(e.contains("refusing"));
        assert_eq!(
            validate_export_path("/tmp/colima-kubeconfig.yaml", user).unwrap(),
            PathBuf::from("/tmp/colima-kubeconfig.yaml")
        );
    }

    #[test]
    fn export_path_rejects_directory() {
        assert!(validate_export_path("/tmp", Path::new("/nonexistent/.kube/config")).is_err());
    }

    #[test]
    fn kubeconfig_state_tracks_freshness_per_profile() {
        let state = KubeconfigState::default();
        assert!(!state.is_fresh("default"));
        state.mark_fresh("default");
        assert!(state.is_fresh("default"));
        assert!(!state.is_fresh("rosetta"));
        state.invalidate("default");
        assert!(!state.is_fresh("default"));
    }

    // --- live, read-only smoke test -----------------------------------------

    /// Live, read-only diagnostic reproducing exactly what
    /// `host_kubeconfig_health` does internally for profile `default` on
    /// this machine, without a Tauri `AppHandle`: fetches the app-managed
    /// kubeconfig into a scratch dir (same as `live_colima_k8s_listing` in
    /// `k8s.rs`), reads the real user kubeconfig (from `$KUBECONFIG`/
    /// `~/.kube/config`, never written to), and runs [`compare_kubeconfigs`].
    /// Never writes to the real kubeconfig. Ignored by default; run with
    /// `cargo test -- --ignored kubeconfig::tests::live_host_kubeconfig_health`.
    /// Live check of [`repair_at`] on a scratch COPY of the real kubeconfig
    /// (the real file is only read): after repair the `colima` context must
    /// work, every other user/cluster/context and current-context must be
    /// byte-identical, and a backup must exist. Copies hold credentials and are
    /// deleted at the end. Ignored by default; run with
    /// `cargo test live_repair_on_scratch_copy -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_repair_on_scratch_copy() {
        let profile = "default";
        let ctx = kube_context(profile);
        let scratch = std::env::temp_dir().join(format!("colima-desktop-repair-test-{}", std::process::id()));
        std::fs::create_dir_all(&scratch).unwrap();

        let real = resolve_user_kubeconfig_path(std::env::var("KUBECONFIG").ok().as_deref(), std::env::var("HOME").ok().as_deref());
        let copy = scratch.join("config");
        std::fs::copy(&real, &copy).unwrap();
        let app_kube_path = fetch_and_write(&scratch, profile).await.expect("fetch app kubeconfig");

        // Everything except the colima user/cluster, as kubectl normalises it.
        let others = |path: &Path| -> serde_json::Value {
            let out = std::process::Command::new("kubectl")
                .args(["config", "view", "--raw", "-o", "json", "--kubeconfig"])
                .arg(path)
                .env_remove("KUBECONFIG")
                .output()
                .unwrap();
            let mut v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            for key in ["users", "clusters"] {
                if let Some(list) = v[key].as_array_mut() {
                    list.retain(|e| e["name"].as_str() != Some(ctx.as_str()));
                }
            }
            v
        };
        let before = others(&copy);
        let can_list = |path: &Path| {
            std::process::Command::new("kubectl")
                .args(["--context", ctx.as_str(), "get", "ns", "--request-timeout=10s", "--kubeconfig"])
                .arg(path)
                .env_remove("KUBECONFIG")
                .output()
                .unwrap()
                .status
                .success()
        };
        println!("colima context works before repair: {}", can_list(&copy));

        let result = repair_at(&copy, &app_kube_path, &ctx).await.expect("repair_at");
        let after = others(&copy);

        let backup_exists = Path::new(&result.backup_path).is_file();
        let works_after = can_list(&copy);
        let others_unchanged = before == after;
        println!("backup written: {backup_exists}; colima works after: {works_after}; other entries unchanged: {others_unchanged}");

        let _ = std::fs::remove_dir_all(&scratch);
        assert!(backup_exists && works_after && others_unchanged);
    }

    #[tokio::test]
    #[ignore]
    async fn live_host_kubeconfig_health() {
        let profile = "default";
        let ctx = kube_context(profile);
        let scratch_dir = std::env::temp_dir().join(format!(
            "colima-desktop-live-health-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&scratch_dir).unwrap();

        let app_kube_path = fetch_and_write(&scratch_dir, profile)
            .await
            .expect("fetch_and_write should succeed against a running colima k3s VM");
        let app_content = std::fs::read_to_string(&app_kube_path).unwrap();
        let app_doc: serde_yaml::Value = serde_yaml::from_str(&app_content).unwrap();

        let kubeconfig_env = std::env::var("KUBECONFIG").ok();
        let home_env = std::env::var("HOME").ok();
        let user_path = resolve_user_kubeconfig_path(kubeconfig_env.as_deref(), home_env.as_deref());
        println!("resolved user kubeconfig path: {}", user_path.display());

        let user_content = std::fs::read_to_string(&user_path).expect("should be able to read the real kubeconfig (read-only)");
        let user_doc: serde_yaml::Value = serde_yaml::from_str(&user_content).unwrap();

        let health = compare_kubeconfigs(&user_doc, &app_doc, &ctx);
        println!(
            "host_kubeconfig_health(profile=\"{profile}\") => contextExists={} credentialsMatch={} detail={:?}",
            health.context_exists, health.credentials_match, health.detail
        );

        let _ = std::fs::remove_dir_all(&scratch_dir);
    }
}
