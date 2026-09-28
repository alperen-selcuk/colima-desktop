//! Docker Compose support (§6.7, docs/SPEC.md). Resolves whether the
//! installed docker provides the `compose` plugin (`docker -H <socket>
//! compose ...`) or only the standalone `docker-compose` binary (run with
//! `DOCKER_HOST=<socket>` in its env, per §2.2's socket rule), caches that
//! resolution per profile in [`AppState`], and exposes `compose_info`,
//! `compose_projects`, `compose_preview`, `compose_up` and `compose_action`.
//!
//! All compose files passed by the frontend must be absolute, exist, and
//! end in `.yml`/`.yaml`; project names are validated like Compose itself
//! (`^[a-z0-9][a-z0-9_-]*$`). `compose_up`/`compose_action` use a busy lock
//! keyed `compose:<project>` (via [`AppState::try_lock_profile`], which is
//! just a generic named-lock set) and stream output the same way lifecycle
//! ops do, then emit `profiles-changed` so the containers query (and any
//! compose-project list) invalidates.

use crate::colima::resolve_docker_socket;
use crate::exec;
use crate::state::AppState;
use crate::validate::validate_profile_name;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComposeMode {
    Plugin,
    Standalone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeInfo {
    pub available: bool,
    pub version: Option<String>,
    pub mode: Option<ComposeMode>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProject {
    pub name: String,
    pub status: String,
    pub config_files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawComposeLsEntry {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "ConfigFiles", default)]
    config_files: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposePreviewService {
    pub name: String,
    pub image: Option<String>,
    pub build: bool,
    pub ports: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposePreview {
    pub project_name: String,
    pub services: Vec<ComposePreviewService>,
    pub warnings: Vec<String>,
}

/// One entry of `compose ... config --format json`'s `services.<name>`
/// object; only the fields we surface.
#[derive(Debug, Clone, Deserialize, Default)]
struct RawComposeConfigService {
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    build: Option<serde_json::Value>,
    #[serde(default)]
    ports: Vec<RawComposePort>,
}

/// Compose's "long form" port mapping object (see `compose config --format
/// json`), e.g. `{"mode":"ingress","target":80,"published":"8080","protocol":"tcp"}`.
#[derive(Debug, Clone, Deserialize, Default)]
struct RawComposePort {
    #[serde(default)]
    published: Option<serde_json::Value>,
    #[serde(default)]
    target: Option<serde_json::Value>,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    host_ip: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct RawComposeConfig {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    services: std::collections::BTreeMap<String, RawComposeConfigService>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComposeUpOptions {
    pub build: bool,
    pub pull: String, // "missing" | "always"
    pub force_recreate: bool,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/// Validate a compose file argument: must be an absolute path, exist, and
/// end in `.yml`/`.yaml` (case-insensitive). Pure except for the existence
/// check, which is the whole point of validating a file path.
pub fn validate_compose_file(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("compose file must be an absolute path: {path}"));
    }
    let ext_ok = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("yml") || e.eq_ignore_ascii_case("yaml"))
        .unwrap_or(false);
    if !ext_ok {
        return Err(format!("compose file must end in .yml or .yaml: {path}"));
    }
    if !p.exists() {
        return Err(format!("compose file not found: {path}"));
    }
    Ok(())
}

/// Validate every file in `files` (non-empty, each individually valid).
pub fn validate_compose_files(files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Err("at least one compose file is required".to_string());
    }
    for f in files {
        validate_compose_file(f)?;
    }
    Ok(())
}

/// Validate a compose project name against Compose's own rule:
/// `^[a-z0-9][a-z0-9_-]*$`.
pub fn is_valid_project_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

pub fn validate_project_name(name: &str) -> Result<(), String> {
    if is_valid_project_name(name) {
        Ok(())
    } else {
        Err(format!(
            "invalid compose project name: {name:?} (must match ^[a-z0-9][a-z0-9_-]*$)"
        ))
    }
}

/// Default project name from a directory name: lowercased and sanitised the
/// way Compose derives it from the working directory basename — non
/// `[a-z0-9_-]` characters dropped/replaced, leading non-alphanumerics
/// stripped, falling back to `"project"` if nothing usable remains.
pub fn default_project_name_from_dir(dir_name: &str) -> String {
    let lower = dir_name.to_ascii_lowercase();
    let cleaned: String = lower
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_start_matches(|c: char| !c.is_ascii_alphanumeric());
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The directory a compose invocation should run in / derive its default
/// project name from: the parent directory of the first file.
fn working_dir_of(files: &[String]) -> Option<&Path> {
    files.first().and_then(|f| Path::new(f).parent())
}

/// Build the `docker ... compose <sub...>` (plugin) or `docker-compose
/// <sub...>` (standalone) argv, WITHOUT the leading binary — that's chosen
/// by the caller based on [`ComposeMode`]. `socket` is only used by the
/// plugin mode (`-H <socket>` goes right after `docker`); standalone mode
/// gets the socket via `DOCKER_HOST` env instead (see [`compose_command`]).
fn compose_base_args(mode: ComposeMode, socket: &str) -> Vec<String> {
    match mode {
        ComposeMode::Plugin => vec!["-H".to_string(), socket.to_string(), "compose".to_string()],
        ComposeMode::Standalone => Vec::new(),
    }
}

/// Append `-f <file>` for each file and `-p <project>` if given, to an
/// existing arg list (shared by every compose subcommand).
fn push_files_and_project(args: &mut Vec<String>, files: &[String], project: Option<&str>) {
    for f in files {
        args.push("-f".to_string());
        args.push(f.clone());
    }
    if let Some(p) = project {
        args.push("-p".to_string());
        args.push(p.to_string());
    }
}

/// Build the full argv (bin + args) for `compose ... config --format json`.
pub fn build_preview_args(mode: ComposeMode, socket: &str, files: &[String], project: Option<&str>) -> (String, Vec<String>) {
    let bin = match mode {
        ComposeMode::Plugin => "docker".to_string(),
        ComposeMode::Standalone => "docker-compose".to_string(),
    };
    let mut args = compose_base_args(mode, socket);
    push_files_and_project(&mut args, files, project);
    args.push("config".to_string());
    args.push("--format".to_string());
    args.push("json".to_string());
    (bin, args)
}

/// Build the full argv (bin + args) for `compose ... up -d [--build]
/// --pull <p> [--force-recreate]`.
pub fn build_up_args(
    mode: ComposeMode,
    socket: &str,
    files: &[String],
    project: Option<&str>,
    opts: &ComposeUpOptions,
) -> (String, Vec<String>) {
    let bin = match mode {
        ComposeMode::Plugin => "docker".to_string(),
        ComposeMode::Standalone => "docker-compose".to_string(),
    };
    let mut args = compose_base_args(mode, socket);
    push_files_and_project(&mut args, files, project);
    args.push("up".to_string());
    args.push("-d".to_string());
    if opts.build {
        args.push("--build".to_string());
    }
    let pull = if opts.pull == "always" { "always" } else { "missing" };
    args.push("--pull".to_string());
    args.push(pull.to_string());
    if opts.force_recreate {
        args.push("--force-recreate".to_string());
    }
    (bin, args)
}

/// Build the full argv (bin + args) for `compose -p <project> [-f files]
/// <action>`. `down` adds `--remove-orphans` and, when `remove_volumes`,
/// `-v`.
pub fn build_action_args(
    mode: ComposeMode,
    socket: &str,
    project: &str,
    action: &str,
    config_files: &[String],
    remove_volumes: bool,
) -> Result<(String, Vec<String>), String> {
    let bin = match mode {
        ComposeMode::Plugin => "docker".to_string(),
        ComposeMode::Standalone => "docker-compose".to_string(),
    };
    let mut args = compose_base_args(mode, socket);
    push_files_and_project(&mut args, config_files, Some(project));
    match action {
        "stop" | "start" | "restart" | "pull" => args.push(action.to_string()),
        "down" => {
            args.push("down".to_string());
            args.push("--remove-orphans".to_string());
            if remove_volumes {
                args.push("-v".to_string());
            }
        }
        other => return Err(format!("invalid compose action: {other}")),
    }
    Ok((bin, args))
}

/// Build the argv for `compose logs -f --tail N --no-color -p <project>
/// [-f files]` used by the log-streaming target `{kind:"compose"}` (see
/// `logs.rs`).
pub fn build_logs_args(mode: ComposeMode, socket: &str, project: &str, config_files: &[String], tail: u32) -> (String, Vec<String>) {
    let bin = match mode {
        ComposeMode::Plugin => "docker".to_string(),
        ComposeMode::Standalone => "docker-compose".to_string(),
    };
    let mut args = compose_base_args(mode, socket);
    push_files_and_project(&mut args, config_files, Some(project));
    args.push("logs".to_string());
    args.push("-f".to_string());
    args.push("--tail".to_string());
    args.push(tail.to_string());
    args.push("--no-color".to_string());
    (bin, args)
}

/// Format one compose "long form" port object into a display string, e.g.
/// `"8080:80/tcp"` or `"80/tcp"` when unpublished, `"127.0.0.1:8080:80/tcp"`
/// when a host IP is set.
fn format_compose_port(p: &RawComposePort) -> Option<String> {
    let target = p.target.as_ref().map(json_value_as_display_string)?;
    let protocol = p.protocol.clone().unwrap_or_else(|| "tcp".to_string());
    let published = p.published.as_ref().and_then(|v| {
        let s = json_value_as_display_string(v);
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    });
    Some(match (published, &p.host_ip) {
        (Some(published), Some(ip)) if !ip.is_empty() => format!("{ip}:{published}:{target}/{protocol}"),
        (Some(published), _) => format!("{published}:{target}/{protocol}"),
        (None, _) => format!("{target}/{protocol}"),
    })
}

/// Compose's JSON port fields (`target`, `published`) can be either a
/// string or a number depending on version/context; render either as plain
/// text without quotes.
fn json_value_as_display_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Parse `compose ... config --format json` stdout into a [`ComposePreview`].
/// `fallback_project` is used when the config's own `name` is absent (older
/// compose versions may omit it).
pub fn parse_compose_preview(stdout: &str, fallback_project: &str) -> Result<ComposePreview, String> {
    let cfg: RawComposeConfig =
        serde_json::from_str(stdout).map_err(|e| format!("failed to parse compose config: {e}"))?;

    let mut warnings = Vec::new();
    let services = cfg
        .services
        .into_iter()
        .map(|(name, s)| {
            let ports: Vec<String> = s.ports.iter().filter_map(format_compose_port).collect();
            let build = matches!(&s.build, Some(v) if !v.is_null());
            if s.image.is_none() && !build {
                warnings.push(format!("service {name:?} has neither an image nor a build context"));
            }
            ComposePreviewService {
                name,
                image: s.image,
                build,
                ports,
            }
        })
        .collect();

    Ok(ComposePreview {
        project_name: cfg.name.unwrap_or_else(|| fallback_project.to_string()),
        services,
        warnings,
    })
}

/// Parse `compose version`/`docker compose version` stdout for a short
/// version string, e.g. `"Docker Compose version v2.36.2"` -> `"v2.36.2"`,
/// `"docker-compose version 1.29.2, build ..."` -> `"1.29.2"`.
pub fn parse_compose_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    // Plugin: "Docker Compose version v2.36.2"
    if let Some(v) = line.strip_prefix("Docker Compose version ") {
        return Some(v.trim().to_string());
    }
    // Standalone: "docker-compose version 1.29.2, build 5becea4c"
    if let Some(rest) = line.strip_prefix("docker-compose version ") {
        return Some(rest.split(',').next().unwrap_or(rest).trim().to_string());
    }
    // Fallback: last whitespace-separated token that looks like a version.
    line.split_whitespace()
        .find(|tok| tok.starts_with('v') || tok.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|s| s.trim_end_matches(',').to_string())
}

/// Parse `compose ls -a --format json` stdout into [`ComposeProject`]s.
pub fn parse_compose_projects(stdout: &str) -> Result<Vec<ComposeProject>, String> {
    let raw: Vec<RawComposeLsEntry> = exec::parse_json_lines_or_array(stdout)?;
    Ok(raw
        .into_iter()
        .map(|r| ComposeProject {
            name: r.name,
            status: r.status,
            config_files: r
                .config_files
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Mode resolution (I/O)
// ---------------------------------------------------------------------------

const INSTALL_HINT: &str = "Docker Compose is not available. Install it with `brew install docker-compose` \
(macOS) or your distro's package for `docker-compose-plugin` (Linux). If installed as a CLI plugin outside \
Docker's default plugin directory, make sure it's on `cliPluginsExtraDirs` — see `brew info docker-compose`.";

/// Probe the plugin (`docker -H <socket> compose version`) then the
/// standalone binary (`docker-compose version` with `DOCKER_HOST=<socket>`),
/// returning whichever succeeds first.
async fn probe_compose_mode(socket: &str) -> ComposeInfo {
    let plugin_out = exec::run("docker", &["-H", socket, "compose", "version"]).await;
    if let Ok(stdout) = plugin_out {
        return ComposeInfo {
            available: true,
            version: parse_compose_version(&stdout),
            mode: Some(ComposeMode::Plugin),
            hint: None,
        };
    }

    let standalone_out = exec::run_with_env("docker-compose", &["version"], &[("DOCKER_HOST", socket)]).await;
    if let Ok(stdout) = standalone_out {
        return ComposeInfo {
            available: true,
            version: parse_compose_version(&stdout),
            mode: Some(ComposeMode::Standalone),
            hint: None,
        };
    }

    ComposeInfo {
        available: false,
        version: None,
        mode: None,
        hint: Some(INSTALL_HINT.to_string()),
    }
}

/// Resolve (and cache per profile, per §6.7) whether compose is available
/// and which mode to use. `pub(crate)` so `logs.rs` can resolve the mode
/// for a `{kind:"compose"}` log stream target.
pub(crate) async fn resolve_compose_info(state: &AppState, profile: &str, socket: &str) -> ComposeInfo {
    if let Some(cached) = state.cached_compose_info(profile) {
        return cached;
    }
    let info = probe_compose_mode(socket).await;
    state.cache_compose_info(profile, info.clone());
    info
}

/// Build the bin+args for any compose subcommand, choosing the docker
/// subcommand form (plugin) or the standalone binary based on the resolved
/// mode, and return the environment overrides the caller must apply
/// (standalone mode needs `DOCKER_HOST`; plugin mode needs none since the
/// socket is passed via `-H`).
fn env_for_mode(mode: ComposeMode, socket: &str) -> Vec<(String, String)> {
    match mode {
        ComposeMode::Plugin => Vec::new(),
        ComposeMode::Standalone => vec![("DOCKER_HOST".to_string(), socket.to_string())],
    }
}

async fn require_available(app: &AppHandle, state: &AppState, profile: &str, socket: &str) -> Result<ComposeMode, String> {
    let _ = app;
    let info = resolve_compose_info(state, profile, socket).await;
    info.mode.ok_or_else(|| info.hint.unwrap_or_else(|| INSTALL_HINT.to_string()))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn compose_info(app: AppHandle, state: State<'_, AppState>, profile: String) -> Result<ComposeInfo, String> {
    let _ = &app;
    validate_profile_name(&profile)?;
    let socket = resolve_docker_socket(&state, &profile).await;
    Ok(resolve_compose_info(&state, &profile, &socket).await)
}

#[tauri::command]
pub async fn compose_projects(app: AppHandle, state: State<'_, AppState>, profile: String) -> Result<Vec<ComposeProject>, String> {
    validate_profile_name(&profile)?;
    let socket = resolve_docker_socket(&state, &profile).await;
    let mode = require_available(&app, &state, &profile, &socket).await?;

    let (bin, args) = {
        let mut args = compose_base_args(mode, &socket);
        args.push("ls".to_string());
        args.push("-a".to_string());
        args.push("--format".to_string());
        args.push("json".to_string());
        let bin = match mode {
            ComposeMode::Plugin => "docker".to_string(),
            ComposeMode::Standalone => "docker-compose".to_string(),
        };
        (bin, args)
    };

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = match mode {
        ComposeMode::Plugin => exec::run(&bin, &arg_refs).await?,
        ComposeMode::Standalone => exec::run_with_env(&bin, &arg_refs, &[("DOCKER_HOST", &socket)]).await?,
    };
    parse_compose_projects(&stdout)
}

#[tauri::command]
pub async fn compose_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    files: Vec<String>,
    project_name: Option<String>,
) -> Result<ComposePreview, String> {
    validate_profile_name(&profile)?;
    validate_compose_files(&files)?;
    if let Some(p) = &project_name {
        validate_project_name(p)?;
    }
    let socket = resolve_docker_socket(&state, &profile).await;
    let mode = require_available(&app, &state, &profile, &socket).await?;

    let fallback_project = project_name.clone().unwrap_or_else(|| {
        working_dir_of(&files)
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .map(default_project_name_from_dir)
            .unwrap_or_else(|| "project".to_string())
    });

    let (bin, args) = build_preview_args(mode, &socket, &files, project_name.as_deref());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = match mode {
        ComposeMode::Plugin => exec::run(&bin, &arg_refs).await?,
        ComposeMode::Standalone => exec::run_with_env(&bin, &arg_refs, &[("DOCKER_HOST", &socket)]).await?,
    };
    parse_compose_preview(&stdout, &fallback_project)
}

fn emit_profiles_changed(app: &AppHandle) {
    let _ = app.emit("profiles-changed", ());
}

/// The 6 conceptual args here (plus `app`/`state`) mirror the IPC contract
/// (§6.7's `compose_up` row) exactly, one Rust param per camelCase JS arg —
/// bundling them into a struct would break that 1:1 mapping for the
/// frontend, which Tauri requires to invoke this command by name.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn compose_up(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    files: Vec<String>,
    project_name: Option<String>,
    build: bool,
    pull: String,
    force_recreate: bool,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    validate_compose_files(&files)?;
    if let Some(p) = &project_name {
        validate_project_name(p)?;
    }
    let socket = resolve_docker_socket(&state, &profile).await;
    let mode = require_available(&app, &state, &profile, &socket).await?;

    let project = project_name.clone().unwrap_or_else(|| {
        working_dir_of(&files)
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .map(default_project_name_from_dir)
            .unwrap_or_else(|| "project".to_string())
    });
    let lock_key = format!("compose:{project}");
    let _guard = state.try_lock_profile(&lock_key)?;

    let opts = ComposeUpOptions {
        build,
        pull,
        force_recreate,
    };
    let (bin, args) = build_up_args(mode, &socket, &files, project_name.as_deref(), &opts);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let env = env_for_mode(mode, &socket);
    let env_refs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

    let cwd = working_dir_of(&files);
    let result = exec::run_streaming_with_env(&app, &bin, &arg_refs, &profile, "compose-up", &env_refs, cwd).await;

    emit_profiles_changed(&app);
    result
}

#[tauri::command]
pub async fn compose_action(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    project: String,
    action: String,
    config_files: Vec<String>,
    remove_volumes: bool,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    validate_project_name(&project)?;
    if !config_files.is_empty() {
        validate_compose_files(&config_files)?;
    }
    let socket = resolve_docker_socket(&state, &profile).await;
    let mode = require_available(&app, &state, &profile, &socket).await?;

    let lock_key = format!("compose:{project}");
    let _guard = state.try_lock_profile(&lock_key)?;

    let (bin, args) = build_action_args(mode, &socket, &project, &action, &config_files, remove_volumes)?;
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let env = env_for_mode(mode, &socket);
    let env_refs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let cwd = working_dir_of(&config_files);
    let op = format!("compose-{action}");

    let result = exec::run_streaming_with_env(&app, &bin, &arg_refs, &profile, &op, &env_refs, cwd).await;

    emit_profiles_changed(&app);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- file / project validation --

    #[test]
    fn validate_compose_file_rejects_relative_path() {
        let err = validate_compose_file("relative/docker-compose.yml").unwrap_err();
        assert!(err.contains("absolute"));
    }

    #[test]
    fn validate_compose_file_rejects_bad_extension() {
        let err = validate_compose_file("/tmp/not-yaml.txt").unwrap_err();
        assert!(err.contains(".yml or .yaml"));
    }

    #[test]
    fn validate_compose_file_rejects_missing_file() {
        let err = validate_compose_file("/tmp/definitely-does-not-exist-cd-livetest-probe.yml").unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn validate_compose_file_accepts_existing_absolute_yaml() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("cd-test-{}.yml", uuid::Uuid::new_v4()));
        std::fs::write(&path, "services: {}\n").unwrap();
        let result = validate_compose_file(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_compose_files_requires_nonempty() {
        assert!(validate_compose_files(&[]).is_err());
    }

    #[test]
    fn project_name_validation() {
        assert!(is_valid_project_name("myapp"));
        assert!(is_valid_project_name("my-app_1"));
        assert!(is_valid_project_name("1app"));
        assert!(!is_valid_project_name(""));
        assert!(!is_valid_project_name("MyApp"));
        assert!(!is_valid_project_name("-leading-dash"));
        assert!(!is_valid_project_name("has space"));
        assert!(!is_valid_project_name("has/slash"));
    }

    #[test]
    fn default_project_name_lowercases_and_sanitises() {
        assert_eq!(default_project_name_from_dir("MyApp"), "myapp");
        assert_eq!(default_project_name_from_dir("my app"), "my_app");
        assert_eq!(default_project_name_from_dir("compose-probe"), "compose-probe");
        assert_eq!(default_project_name_from_dir("_leading"), "leading");
        assert_eq!(default_project_name_from_dir("---"), "project");
        assert_eq!(default_project_name_from_dir(""), "project");
    }

    // -- arg building --

    #[test]
    fn build_preview_args_plugin_mode() {
        let (bin, args) = build_preview_args(
            ComposeMode::Plugin,
            "unix:///tmp/docker.sock",
            &["/a/docker-compose.yml".to_string()],
            Some("myapp"),
        );
        assert_eq!(bin, "docker");
        assert_eq!(
            args,
            vec![
                "-H", "unix:///tmp/docker.sock", "compose", "-f", "/a/docker-compose.yml", "-p", "myapp", "config", "--format", "json"
            ]
        );
    }

    #[test]
    fn build_preview_args_standalone_mode_has_no_dash_h() {
        let (bin, args) = build_preview_args(ComposeMode::Standalone, "unix:///tmp/docker.sock", &["/a/docker-compose.yml".to_string()], None);
        assert_eq!(bin, "docker-compose");
        assert_eq!(args, vec!["-f", "/a/docker-compose.yml", "config", "--format", "json"]);
        assert!(!args.iter().any(|a| a == "-H"));
    }

    #[test]
    fn build_up_args_plugin_with_all_options() {
        let (bin, args) = build_up_args(
            ComposeMode::Plugin,
            "unix:///tmp/docker.sock",
            &["/a/docker-compose.yml".to_string()],
            Some("myapp"),
            &ComposeUpOptions {
                build: true,
                pull: "always".to_string(),
                force_recreate: true,
            },
        );
        assert_eq!(bin, "docker");
        assert_eq!(
            args,
            vec![
                "-H",
                "unix:///tmp/docker.sock",
                "compose",
                "-f",
                "/a/docker-compose.yml",
                "-p",
                "myapp",
                "up",
                "-d",
                "--build",
                "--pull",
                "always",
                "--force-recreate"
            ]
        );
    }

    #[test]
    fn build_up_args_defaults_pull_to_missing() {
        let (_, args) = build_up_args(
            ComposeMode::Standalone,
            "unix:///tmp/docker.sock",
            &["/a/docker-compose.yml".to_string()],
            None,
            &ComposeUpOptions {
                build: false,
                pull: "bogus".to_string(),
                force_recreate: false,
            },
        );
        assert!(args.windows(2).any(|w| w == ["--pull", "missing"]));
        assert!(!args.contains(&"--build".to_string()));
        assert!(!args.contains(&"--force-recreate".to_string()));
    }

    #[test]
    fn build_action_args_down_with_remove_volumes() {
        let (bin, args) = build_action_args(
            ComposeMode::Plugin,
            "unix:///tmp/docker.sock",
            "myapp",
            "down",
            &["/a/docker-compose.yml".to_string()],
            true,
        )
        .unwrap();
        assert_eq!(bin, "docker");
        assert_eq!(
            args,
            vec![
                "-H",
                "unix:///tmp/docker.sock",
                "compose",
                "-f",
                "/a/docker-compose.yml",
                "-p",
                "myapp",
                "down",
                "--remove-orphans",
                "-v"
            ]
        );
    }

    #[test]
    fn build_action_args_down_without_remove_volumes_omits_dash_v() {
        let (_, args) = build_action_args(ComposeMode::Plugin, "unix:///tmp/docker.sock", "myapp", "down", &[], false).unwrap();
        assert!(args.contains(&"--remove-orphans".to_string()));
        assert!(!args.contains(&"-v".to_string()));
    }

    #[test]
    fn build_action_args_stop_start_restart_pull() {
        for action in ["stop", "start", "restart", "pull"] {
            let (_, args) = build_action_args(ComposeMode::Plugin, "unix:///tmp/docker.sock", "myapp", action, &[], false).unwrap();
            assert!(args.contains(&action.to_string()));
            assert!(!args.contains(&"--remove-orphans".to_string()));
        }
    }

    #[test]
    fn build_action_args_rejects_invalid_action() {
        assert!(build_action_args(ComposeMode::Plugin, "unix:///tmp/docker.sock", "myapp", "nuke", &[], false).is_err());
    }

    #[test]
    fn build_logs_args_standalone() {
        let (bin, args) = build_logs_args(ComposeMode::Standalone, "unix:///tmp/docker.sock", "myapp", &["/a/docker-compose.yml".to_string()], 200);
        assert_eq!(bin, "docker-compose");
        assert_eq!(
            args,
            vec!["-f", "/a/docker-compose.yml", "-p", "myapp", "logs", "-f", "--tail", "200", "--no-color"]
        );
    }

    // -- preview JSON parsing --

    #[test]
    fn parse_compose_preview_realistic_two_file_output() {
        // Captured live: `docker compose -f docker-compose.yml -f
        // docker-compose.override.yml -p probeproj config --format json`.
        let json = r#"{
            "name": "probeproj",
            "services": {
                "web": {
                    "image": "nginx:alpine",
                    "ports": [
                        {"mode": "ingress", "target": 80, "published": "18081", "protocol": "tcp"}
                    ]
                }
            }
        }"#;
        let preview = parse_compose_preview(json, "fallback").unwrap();
        assert_eq!(preview.project_name, "probeproj");
        assert_eq!(preview.services.len(), 1);
        let web = &preview.services[0];
        assert_eq!(web.name, "web");
        assert_eq!(web.image.as_deref(), Some("nginx:alpine"));
        assert!(!web.build);
        assert_eq!(web.ports, vec!["18081:80/tcp".to_string()]);
        assert!(preview.warnings.is_empty());
    }

    #[test]
    fn parse_compose_preview_uses_fallback_project_when_name_missing() {
        let json = r#"{"services": {"web": {"image": "nginx"}}}"#;
        let preview = parse_compose_preview(json, "myfallback").unwrap();
        assert_eq!(preview.project_name, "myfallback");
    }

    #[test]
    fn parse_compose_preview_build_service_no_image_no_warning() {
        let json = r#"{"name":"p","services":{"web":{"build":{"context":"."}}}}"#;
        let preview = parse_compose_preview(json, "p").unwrap();
        assert!(preview.services[0].build);
        assert!(preview.warnings.is_empty());
    }

    #[test]
    fn parse_compose_preview_warns_when_neither_image_nor_build() {
        let json = r#"{"name":"p","services":{"broken":{}}}"#;
        let preview = parse_compose_preview(json, "p").unwrap();
        assert_eq!(preview.warnings.len(), 1);
        assert!(preview.warnings[0].contains("broken"));
    }

    #[test]
    fn parse_compose_preview_multiple_ports_and_unpublished() {
        let json = r#"{
            "name": "p",
            "services": {
                "web": {
                    "image": "nginx",
                    "ports": [
                        {"target": 80, "published": "8080", "protocol": "tcp"},
                        {"target": 443, "protocol": "tcp"}
                    ]
                }
            }
        }"#;
        let preview = parse_compose_preview(json, "p").unwrap();
        assert_eq!(preview.services[0].ports, vec!["8080:80/tcp".to_string(), "443/tcp".to_string()]);
    }

    #[test]
    fn parse_compose_preview_invalid_json_errors() {
        assert!(parse_compose_preview("not json", "p").is_err());
    }

    // -- version parsing --

    #[test]
    fn parse_compose_version_plugin_format() {
        assert_eq!(parse_compose_version("Docker Compose version v2.36.2\n"), Some("v2.36.2".to_string()));
    }

    #[test]
    fn parse_compose_version_standalone_format() {
        assert_eq!(
            parse_compose_version("docker-compose version 1.29.2, build 5becea4c\n"),
            Some("1.29.2".to_string())
        );
    }

    // -- `compose ls` parsing --

    #[test]
    fn parse_compose_projects_realistic_output() {
        // Captured live from `docker compose ls -a --format json` after
        // bringing up a two-file project.
        let json = r#"[{"Name":"probeproj","Status":"running(1)","ConfigFiles":"/a/docker-compose.yml,/a/docker-compose.override.yml"}]"#;
        let projects = parse_compose_projects(json).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "probeproj");
        assert_eq!(projects[0].status, "running(1)");
        assert_eq!(
            projects[0].config_files,
            vec!["/a/docker-compose.yml".to_string(), "/a/docker-compose.override.yml".to_string()]
        );
    }

    #[test]
    fn parse_compose_projects_empty_array() {
        assert!(parse_compose_projects("[]").unwrap().is_empty());
    }

    #[test]
    fn parse_compose_projects_single_config_file() {
        let json = r#"[{"Name":"app","Status":"exited(1)","ConfigFiles":"/a/docker-compose.yml"}]"#;
        let projects = parse_compose_projects(json).unwrap();
        assert_eq!(projects[0].config_files, vec!["/a/docker-compose.yml".to_string()]);
    }

    /// Live end-to-end diagnostic against this machine's running colima
    /// (profile `default`, docker runtime). Exercises the exact same
    /// pipeline the `#[tauri::command]`s use (mode probing, arg building,
    /// preview parsing) but calls the underlying async helpers/`exec::run*`
    /// directly rather than through the Tauri command wrappers, since this
    /// crate has no `AppHandle`/`State` mock harness (same approach as
    /// `k8s::tests::live_colima_k8s_listing`).
    ///
    /// ONLY ever touches a project named `cd-livetest`; never removes any
    /// other container/image/volume. Ignored by default; run with
    /// `cargo test live_compose_up_and_down -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_compose_up_and_down() {
        let profile = "default";
        let state = AppState::default();
        let socket = resolve_docker_socket(&state, profile).await;
        println!("docker socket: {socket}");

        // (1) List containers, print total vs kubernetes-labelled counts.
        let raw_ps = exec::run("docker", &["-H", &socket, "ps", "-a", "--no-trunc", "--format", "{{json .}}"])
            .await
            .expect("docker ps should succeed against the running colima VM");
        let ids: Vec<String> = raw_ps
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter_map(|v| v.get("ID").and_then(|id| id.as_str()).map(str::to_string))
            .collect();
        let total = ids.len();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let labels_by_id = crate::docker::labels_via_inspect(&socket, &id_refs).await;
        let k8s_count = labels_by_id.values().filter(|l| l.contains_key("io.kubernetes.pod.namespace")).count();
        println!("containers: total={total} kubernetes-labelled={k8s_count}");
        assert!(total > 0, "expected at least one container on this machine");

        // (2) compose_info equivalent.
        let info = resolve_compose_info(&state, profile, &socket).await;
        println!("compose info: {info:?}");
        assert!(info.available, "docker compose (plugin or standalone) should be available on this machine");
        let mode = info.mode.expect("mode must be set when available");

        // (3) Create a tiny compose file for project `cd-livetest`.
        let scratch_dir = std::env::temp_dir().join(format!(
            "colima-desktop-live-compose-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&scratch_dir).unwrap();
        let compose_file = scratch_dir.join("docker-compose.yml");
        std::fs::write(
            &compose_file,
            "services:\n  web:\n    image: nginx:alpine\n    ports:\n      - \"18080:80\"\n",
        )
        .unwrap();
        let file_str = compose_file.to_str().unwrap().to_string();
        let files = vec![file_str.clone()];
        let project = "cd-livetest".to_string();
        validate_compose_file(&file_str).expect("the file we just wrote should validate");
        validate_project_name(&project).expect("cd-livetest should be a valid project name");

        // Ensure a clean slate in case a previous run left this project up.
        let (down_bin, down_args) = build_action_args(mode, &socket, &project, "down", &[], true).unwrap();
        let down_arg_refs: Vec<&str> = down_args.iter().map(String::as_str).collect();
        let _ = run_compose_owned(mode, &socket, &down_bin, &down_arg_refs).await;

        // (3) compose_preview.
        let (bin, args) = build_preview_args(mode, &socket, &files, Some(&project));
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let preview_stdout = run_compose_owned(mode, &socket, &bin, &arg_refs).await.expect("compose preview should succeed");
        let preview = parse_compose_preview(&preview_stdout, &project).expect("preview JSON should parse");
        println!("preview: {preview:?}");
        assert_eq!(preview.services.len(), 1);
        assert_eq!(preview.services[0].name, "web");
        assert_eq!(preview.services[0].ports, vec!["18080:80/tcp".to_string()]);

        // (4) compose_up.
        let opts = ComposeUpOptions {
            build: false,
            pull: "missing".to_string(),
            force_recreate: false,
        };
        let (bin, args) = build_up_args(mode, &socket, &files, Some(&project), &opts);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_compose_owned(mode, &socket, &bin, &arg_refs).await.expect("compose up should succeed");

        // (5) Verify the container appears with compose labels, via the
        // same batched-inspect path `list_containers` uses.
        let raw_ps_after = exec::run(
            "docker",
            &["-H", &socket, "ps", "-a", "--no-trunc", "--filter", "label=com.docker.compose.project=cd-livetest", "--format", "{{json .}}"],
        )
        .await
        .expect("docker ps should succeed");
        let after_ids: Vec<String> = raw_ps_after
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter_map(|v| v.get("ID").and_then(|id| id.as_str()).map(str::to_string))
            .collect();
        assert_eq!(after_ids.len(), 1, "expected exactly one cd-livetest container");
        let after_refs: Vec<&str> = after_ids.iter().map(String::as_str).collect();
        let after_labels = crate::docker::labels_via_inspect(&socket, &after_refs).await;
        let container_labels = after_labels.values().next().expect("should have labels for the one container");
        assert_eq!(container_labels.get("com.docker.compose.project").map(String::as_str), Some("cd-livetest"));
        assert_eq!(container_labels.get("com.docker.compose.service").map(String::as_str), Some("web"));
        println!("compose labels on container: project={:?} service={:?}", container_labels.get("com.docker.compose.project"), container_labels.get("com.docker.compose.service"));

        // (6) curl http://localhost:18080 expecting 200. Give nginx a
        // moment to come up.
        let mut status = None;
        for _ in 0..20 {
            let out = tokio::process::Command::new("curl")
                .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:18080"])
                .output()
                .await
                .expect("curl should be runnable");
            let code = String::from_utf8_lossy(&out.stdout).to_string();
            if code == "200" {
                status = Some(code);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        assert_eq!(status.as_deref(), Some("200"), "expected nginx to respond 200 on http://localhost:18080");
        println!("curl http://localhost:18080 -> 200 OK");

        // (7) compose_action down with removeVolumes=true.
        let (bin, args) = build_action_args(mode, &socket, &project, "down", &files, true).unwrap();
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_compose_owned(mode, &socket, &bin, &arg_refs).await.expect("compose down should succeed");

        // Assert it's gone.
        let raw_ps_final = exec::run(
            "docker",
            &["-H", &socket, "ps", "-a", "--no-trunc", "--filter", "label=com.docker.compose.project=cd-livetest", "--format", "{{json .}}"],
        )
        .await
        .expect("docker ps should succeed");
        assert!(raw_ps_final.trim().is_empty(), "expected no cd-livetest containers after down");
        println!("cd-livetest container removed after compose down");

        let _ = std::fs::remove_dir_all(&scratch_dir);
    }

    /// Run a compose subcommand (already-built bin+args) and return trimmed
    /// stdout, using the right env for the resolved mode. Test-only helper
    /// mirroring what `compose_preview`/`compose_up`/`compose_action` do
    /// inline.
    async fn run_compose_owned(mode: ComposeMode, socket: &str, bin: &str, args: &[&str]) -> Result<String, String> {
        match mode {
            ComposeMode::Plugin => exec::run(bin, args).await,
            ComposeMode::Standalone => exec::run_with_env(bin, args, &[("DOCKER_HOST", socket)]).await,
        }
    }

}
