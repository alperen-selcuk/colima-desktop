//! Machine configuration editor backend (§6.4): reads and writes a
//! profile's raw `colima.yaml` text so the frontend can edit it with a form
//! while preserving comments and unknown keys (the actual YAML parsing for
//! that purpose lives in the frontend's `colimaConfig.ts`, which uses a
//! comment-preserving YAML document model; this module only deals with
//! finding the right file, validating it parses as a mapping, and writing
//! it back safely).

use crate::colima::colima_home;
use crate::validate::validate_profile_name;
use serde::Serialize;
use std::io::Write;
use std::net::IpAddr;
use std::path::PathBuf;
use std::str::FromStr;

/// Upstream Colima's default `colima.yaml`, fully commented, embedded as the
/// last-resort fallback source when neither a profile's own config nor a
/// user template exist yet. See `resources/colima-default.yaml` for
/// attribution.
const BUILTIN_DEFAULT_YAML: &str = include_str!("../resources/colima-default.yaml");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigSource {
    Profile,
    Template,
    Builtin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConfigRaw {
    pub content: String,
    pub source: ConfigSource,
    pub path: String,
    pub exists: bool,
}

/// The profile's own config file path: `<home>/<profile>/colima.yaml`.
fn profile_config_path_at(home: &std::path::Path, profile: &str) -> PathBuf {
    home.join(profile).join("colima.yaml")
}

/// The user template path: `<home>/_templates/default.yaml` (what `colima
/// template` edits).
fn template_path_at(home: &std::path::Path) -> PathBuf {
    home.join("_templates").join("default.yaml")
}

/// New-machine defaults for template/builtin seeds (comment-preserving line
/// edits of the top-level keys): `arch: host`, and `vmType: vz` on macOS
/// (upstream's template says `qemu`, which needs a separate QEMU install).
fn new_machine_defaults(content: &str, macos: bool) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in content.lines() {
        if line.starts_with("arch:") {
            out.push("arch: host".to_string());
        } else if macos && line.starts_with("vmType:") {
            out.push("vmType: vz".to_string());
        } else {
            out.push(line.to_string());
        }
    }
    let mut s = out.join("\n");
    if content.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// `profile_config_raw`: return the raw YAML text to seed the configuration
/// editor with, per the precedence in §6.4: the profile's own file, else the
/// user template, else the embedded upstream default. `path` is always the
/// profile's own file path (i.e. where a save will land), and `exists`
/// reflects whether that profile file currently exists on disk.
fn profile_config_raw_at(home: &std::path::Path, profile: &str) -> Result<ProfileConfigRaw, String> {
    validate_profile_name(profile)?;
    let path = profile_config_path_at(home, profile);

    if let Ok(content) = std::fs::read_to_string(&path) {
        return Ok(ProfileConfigRaw {
            content,
            source: ConfigSource::Profile,
            path: path.display().to_string(),
            exists: true,
        });
    }

    if let Ok(content) = std::fs::read_to_string(template_path_at(home)) {
        if !content.trim().is_empty() {
            return Ok(ProfileConfigRaw {
                content: new_machine_defaults(&content, cfg!(target_os = "macos")),
                source: ConfigSource::Template,
                path: path.display().to_string(),
                exists: false,
            });
        }
    }

    Ok(ProfileConfigRaw {
        content: new_machine_defaults(BUILTIN_DEFAULT_YAML, cfg!(target_os = "macos")),
        source: ConfigSource::Builtin,
        path: path.display().to_string(),
        exists: false,
    })
}

#[tauri::command]
pub async fn profile_config_raw(profile: String) -> Result<ProfileConfigRaw, String> {
    profile_config_raw_at(&colima_home(), &profile)
}

/// Validate that `content` parses as YAML and that the top-level value is a
/// mapping (object), which is what colima.yaml must be.
fn validate_yaml_mapping(content: &str) -> Result<(), String> {
    let value: serde_yaml::Value =
        serde_yaml::from_str(content).map_err(|e| format!("invalid YAML: {e}"))?;
    match value {
        serde_yaml::Value::Mapping(_) => Ok(()),
        serde_yaml::Value::Null => Ok(()), // empty file: treated as an empty mapping
        _ => Err("invalid YAML: top-level document must be a mapping".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Typed validation mirroring colima's `config.Config` (colima/config/config.go).
//
// Colima's own config loader (`cmd/start.go` prepareConfig -> config/configmanager)
// does not surface unmarshal errors to the user: if `colima.yaml` fails to
// unmarshal into `config.Config` (wrong type for a field, a malformed IP,
// etc.) it only logs a warning and silently reverts to hardcoded defaults,
// ignoring the user's file entirely. We validate ahead of time so `Save`
// rejects anything that would trigger that silent fallback, and the UI can
// show the same issues live while editing.
//
// Semantics mirrored from yaml.v3 (used by colima) as closely as `serde_yaml`
// allows:
//   - `int` fields reject floats and strings (must be a whole number).
//   - `float32` fields accept ints or floats, reject strings/bools.
//   - `bool` fields must be an actual YAML bool (`true`/`false`); a string
//     like `"yes"` is a string in both yaml.v3's and serde_yaml's core
//     schema resolution, not a bool, so it is rejected.
//   - `net.IP` fields must be a string that parses as an IPv4/IPv6 address,
//     or explicitly `null` where colima's zero-value tolerates that.
//   - `map[string]string` fields (env, dnsHosts) must have string keys and
//     scalar (string/number/bool) values, not nested maps/lists.
//   - `docker` is `map[string]any`: any value type is fine, only the
//     top-level shape (a mapping) is checked.
//   - Enum-like string fields (runtime, vmType, arch, mountType,
//     network.mode, portForwarder, modelRunner, provision[].mode) are NOT
//     rejected by colima's unmarshal step at all -- an unrecognized value is
//     still a valid string field value, and colima only fails later at
//     runtime (or not at all). So these are reported as `severity: warning`
//     and never block saving.
//
// Unknown top-level or nested keys are always allowed (colima's own
// unmarshal ignores them), so we simply don't look at any key we don't
// recognize.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigIssue {
    pub path: String,
    pub message: String,
    pub severity: IssueSeverity,
}

impl ConfigIssue {
    fn error(path: impl Into<String>, message: impl Into<String>) -> Self {
        ConfigIssue { path: path.into(), message: message.into(), severity: IssueSeverity::Error }
    }

    fn warning(path: impl Into<String>, message: impl Into<String>) -> Self {
        ConfigIssue { path: path.into(), message: message.into(), severity: IssueSeverity::Warning }
    }
}

/// Look up `key` in a YAML mapping, returning `None` if the mapping doesn't
/// have that key at all (as opposed to having it set to `null`).
fn mapping_get<'a>(mapping: &'a serde_yaml::Mapping, key: &str) -> Option<&'a serde_yaml::Value> {
    mapping.get(serde_yaml::Value::String(key.to_string()))
}

/// Whether a value is YAML `null` (colima tolerates this for several
/// optional fields, e.g. `hostname: null`, `network.nat66Prefix: null`).
fn is_null(value: &serde_yaml::Value) -> bool {
    matches!(value, serde_yaml::Value::Null)
}

/// Check an `int`-typed field: must be a whole number, not a float or string.
fn check_int(mapping: &serde_yaml::Mapping, key: &str, path: &str, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, key) else { return };
    if is_null(value) {
        return;
    }
    match value {
        serde_yaml::Value::Number(n) if n.is_i64() || n.is_u64() => {}
        serde_yaml::Value::Number(_) => {
            issues.push(ConfigIssue::error(path, "must be a whole number, not a decimal"));
        }
        _ => issues.push(ConfigIssue::error(path, "must be a whole number")),
    }
}

/// Check a `float32`-typed field: ints or floats both fine, strings/bools not.
fn check_float(mapping: &serde_yaml::Mapping, key: &str, path: &str, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, key) else { return };
    if is_null(value) {
        return;
    }
    match value {
        serde_yaml::Value::Number(_) => {}
        _ => issues.push(ConfigIssue::error(path, "must be a number")),
    }
}

/// Check a `bool`-typed field: must be an actual YAML bool.
fn check_bool(mapping: &serde_yaml::Mapping, key: &str, path: &str, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, key) else { return };
    if is_null(value) {
        return;
    }
    if !matches!(value, serde_yaml::Value::Bool(_)) {
        issues.push(ConfigIssue::error(path, "must be true or false"));
    }
}

/// Check a plain `string`-typed field: must be a YAML string scalar (not a
/// number/bool/mapping/sequence -- yaml.v3 would refuse those too).
fn check_string(mapping: &serde_yaml::Mapping, key: &str, path: &str, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, key) else { return };
    if is_null(value) {
        return;
    }
    if !matches!(value, serde_yaml::Value::String(_)) {
        issues.push(ConfigIssue::error(path, "must be a string"));
    }
}

/// Check a `net.IP`-typed field: must be a string that parses as an IPv4 or
/// IPv6 address, or absent/null (colima tolerates a nil IP for these).
fn check_ip(mapping: &serde_yaml::Mapping, key: &str, path: &str, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, key) else { return };
    if is_null(value) {
        return;
    }
    match value {
        serde_yaml::Value::String(s) if IpAddr::from_str(s).is_ok() => {}
        serde_yaml::Value::String(s) => {
            issues.push(ConfigIssue::error(path, format!("\"{s}\" is not a valid IP address")));
        }
        _ => issues.push(ConfigIssue::error(path, "must be a string containing an IP address")),
    }
}

/// Check a `[]net.IP`-typed field (e.g. `network.dns`): must be a sequence,
/// each element a valid IP string.
fn check_ip_list(mapping: &serde_yaml::Mapping, key: &str, path: &str, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, key) else { return };
    if is_null(value) {
        return;
    }
    let serde_yaml::Value::Sequence(items) = value else {
        issues.push(ConfigIssue::error(path, "must be a list"));
        return;
    };
    for (i, item) in items.iter().enumerate() {
        let item_path = format!("{path}[{i}]");
        match item {
            serde_yaml::Value::String(s) if IpAddr::from_str(s).is_ok() => {}
            serde_yaml::Value::String(s) => {
                issues.push(ConfigIssue::error(&item_path, format!("\"{s}\" is not a valid IP address")));
            }
            _ => issues.push(ConfigIssue::error(&item_path, "must be a string containing an IP address")),
        }
    }
}

/// Check a `map[string]string`-typed field (e.g. `env`, `network.dnsHosts`):
/// must be a mapping whose values are scalars (colima's `map[string]string`
/// unmarshal fails on a nested map/list value).
fn check_string_map(mapping: &serde_yaml::Mapping, key: &str, path: &str, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, key) else { return };
    if is_null(value) {
        return;
    }
    let serde_yaml::Value::Mapping(entries) = value else {
        issues.push(ConfigIssue::error(path, "must be a map of key: value pairs"));
        return;
    };
    for (k, v) in entries {
        let key_label = k.as_str().map(str::to_string).unwrap_or_else(|| format!("{k:?}"));
        let entry_path = format!("{path}.{key_label}");
        match v {
            serde_yaml::Value::Mapping(_) | serde_yaml::Value::Sequence(_) => {
                issues.push(ConfigIssue::error(&entry_path, "value must be a plain string, not a nested structure"));
            }
            _ => {}
        }
    }
}

/// Check an enum-like string field: colima's unmarshal step never rejects an
/// unrecognized value here (it's just a string field), so mismatches are
/// warnings, not errors, and never block saving.
fn check_enum_warning(
    mapping: &serde_yaml::Mapping,
    key: &str,
    path: &str,
    allowed: &[&str],
    issues: &mut Vec<ConfigIssue>,
) {
    let Some(value) = mapping_get(mapping, key) else { return };
    if is_null(value) {
        return;
    }
    // Empty string means "use colima's default".
    if matches!(value, serde_yaml::Value::String(s) if s.is_empty()) {
        return;
    }
    let serde_yaml::Value::String(s) = value else {
        // Wrong type entirely is still just a string field to colima's
        // unmarshal step at this key, but a non-scalar can't round-trip as
        // a string; treat as a warning too since colima wouldn't error here
        // either (it stores whatever scalar-ish value gets coerced), while
        // still surfacing something so the user notices.
        issues.push(ConfigIssue::warning(path, "must be a string"));
        return;
    };
    if !allowed.contains(&s.as_str()) {
        issues.push(ConfigIssue::warning(
            path,
            format!("\"{s}\" is not one of the values colima documents: {}", allowed.join(", ")),
        ));
    }
}

/// Validate `mounts`: a list of objects with a required `location` (string,
/// non-empty), optional `mountPoint` (string) and `writable` (bool).
fn check_mounts(mapping: &serde_yaml::Mapping, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, "mounts") else { return };
    if is_null(value) {
        return;
    }
    let serde_yaml::Value::Sequence(items) = value else {
        issues.push(ConfigIssue::error("mounts", "must be a list"));
        return;
    };
    for (i, item) in items.iter().enumerate() {
        let item_path = format!("mounts[{i}]");
        let serde_yaml::Value::Mapping(row) = item else {
            issues.push(ConfigIssue::error(&item_path, "must be a mapping with a `location` key"));
            continue;
        };
        match mapping_get(row, "location") {
            None => issues.push(ConfigIssue::error(format!("{item_path}.location"), "is required")),
            Some(serde_yaml::Value::String(s)) if !s.trim().is_empty() => {}
            Some(serde_yaml::Value::String(_)) => {
                issues.push(ConfigIssue::error(format!("{item_path}.location"), "must not be empty"))
            }
            Some(_) => issues.push(ConfigIssue::error(format!("{item_path}.location"), "must be a string")),
        }
        check_string(row, "mountPoint", &format!("{item_path}.mountPoint"), issues);
        check_bool(row, "writable", &format!("{item_path}.writable"), issues);
    }
}

/// Validate `provision`: a list of objects with `mode` (enum warning:
/// system|user|after-boot|ready) and `script` (string).
fn check_provision(mapping: &serde_yaml::Mapping, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, "provision") else { return };
    if is_null(value) {
        return;
    }
    let serde_yaml::Value::Sequence(items) = value else {
        issues.push(ConfigIssue::error("provision", "must be a list"));
        return;
    };
    for (i, item) in items.iter().enumerate() {
        let item_path = format!("provision[{i}]");
        let serde_yaml::Value::Mapping(row) = item else {
            issues.push(ConfigIssue::error(&item_path, "must be a mapping"));
            continue;
        };
        check_enum_warning(
            row,
            "mode",
            &format!("{item_path}.mode"),
            &["system", "user", "after-boot", "ready"],
            issues,
        );
        check_string(row, "script", &format!("{item_path}.script"), issues);
    }
}

/// Validate `kubernetes`: `enabled` (bool), `version` (string), `k3sArgs`
/// (list of strings), `port` (int).
fn check_kubernetes(mapping: &serde_yaml::Mapping, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, "kubernetes") else { return };
    if is_null(value) {
        return;
    }
    let serde_yaml::Value::Mapping(k8s) = value else {
        issues.push(ConfigIssue::error("kubernetes", "must be a mapping"));
        return;
    };
    check_bool(k8s, "enabled", "kubernetes.enabled", issues);
    check_string(k8s, "version", "kubernetes.version", issues);
    // A well-formed-but-unknown version is only a frontend warning (the
    // K3sVersionPicker checks it against the fetched/builtin list); a
    // malformed version string is an error here because colima would fail to
    // even download it (`--kubernetes-version` must match
    // `^v\d+\.\d+\.\d+\+k3s\d+$`), unlike the enum-like fields above which
    // colima's unmarshal step never rejects.
    if let Some(serde_yaml::Value::String(s)) = mapping_get(k8s, "version") {
        if !s.is_empty() && !crate::k3s::is_valid_k3s_version_format(s) {
            issues.push(ConfigIssue::error(
                "kubernetes.version",
                format!("\"{s}\" is not a valid k3s version format (expected vX.Y.Z+k3sN)"),
            ));
        }
    }
    check_int(k8s, "port", "kubernetes.port", issues);
    if let Some(args) = mapping_get(k8s, "k3sArgs") {
        if !is_null(args) {
            match args {
                serde_yaml::Value::Sequence(items) => {
                    for (i, item) in items.iter().enumerate() {
                        if !matches!(item, serde_yaml::Value::String(_)) {
                            issues.push(ConfigIssue::error(format!("kubernetes.k3sArgs[{i}]"), "must be a string"));
                        }
                    }
                }
                _ => issues.push(ConfigIssue::error("kubernetes.k3sArgs", "must be a list of strings")),
            }
        }
    }
}

/// Validate `network`: bools, an enum-warning `mode`, a string
/// `interface`/`subnet`, IPs (`gatewayAddress`, `nat66Prefix`), an IP list
/// (`dns`) and a string map (`dnsHosts`).
fn check_network(mapping: &serde_yaml::Mapping, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, "network") else { return };
    if is_null(value) {
        return;
    }
    let serde_yaml::Value::Mapping(net) = value else {
        issues.push(ConfigIssue::error("network", "must be a mapping"));
        return;
    };
    check_bool(net, "address", "network.address", issues);
    check_enum_warning(net, "mode", "network.mode", &["shared", "bridged"], issues);
    check_string(net, "interface", "network.interface", issues);
    check_string(net, "subnet", "network.subnet", issues);
    check_bool(net, "preferredRoute", "network.preferredRoute", issues);
    check_bool(net, "hostAddresses", "network.hostAddresses", issues);
    check_ip(net, "gatewayAddress", "network.gatewayAddress", issues);
    check_ip(net, "nat66Prefix", "network.nat66Prefix", issues);
    check_ip_list(net, "dns", "network.dns", issues);
    check_string_map(net, "dnsHosts", "network.dnsHosts", issues);
}

/// Validate `docker`: `map[string]any` in colima -- any value shape is
/// fine, we only require the top-level value itself to be a mapping.
fn check_docker(mapping: &serde_yaml::Mapping, issues: &mut Vec<ConfigIssue>) {
    let Some(value) = mapping_get(mapping, "docker") else { return };
    if is_null(value) {
        return;
    }
    if !matches!(value, serde_yaml::Value::Mapping(_)) {
        issues.push(ConfigIssue::error("docker", "must be a mapping"));
    }
}

/// Validate `content`'s top-level value against the type shape of colima's
/// `config.Config` (see module docs above for the exact semantics mirrored).
/// Returns one issue per problem found; an empty vec means colima's own
/// `yaml.Unmarshal` of this content would succeed (modulo enum values, which
/// never block unmarshal and are reported as warnings only).
pub fn validate_colima_config(value: &serde_yaml::Value) -> Vec<ConfigIssue> {
    let mut issues = Vec::new();

    let mapping = match value {
        serde_yaml::Value::Mapping(m) => m,
        serde_yaml::Value::Null => return issues, // empty file: nothing to check
        _ => {
            issues.push(ConfigIssue::error("", "top-level document must be a mapping"));
            return issues;
        }
    };

    // Resources
    check_int(mapping, "cpu", "cpu", &mut issues);
    check_int(mapping, "disk", "disk", &mut issues);
    check_int(mapping, "rootDisk", "rootDisk", &mut issues);
    check_float(mapping, "memory", "memory", &mut issues);
    check_enum_warning(mapping, "arch", "arch", &["host", "aarch64", "x86_64"], &mut issues);
    check_string(mapping, "cpuType", "cpuType", &mut issues);
    check_string_map(mapping, "env", "env", &mut issues);
    check_string(mapping, "hostname", "hostname", &mut issues);

    // SSH
    check_int(mapping, "sshPort", "sshPort", &mut issues);
    check_bool(mapping, "forwardAgent", "forwardAgent", &mut issues);
    check_bool(mapping, "sshConfig", "sshConfig", &mut issues);

    // VM
    check_enum_warning(mapping, "vmType", "vmType", &["vz", "qemu", "krunkit"], &mut issues);
    check_bool(mapping, "rosetta", "rosetta", &mut issues);
    check_bool(mapping, "binfmt", "binfmt", &mut issues);
    check_bool(mapping, "nestedVirtualization", "nestedVirtualization", &mut issues);
    check_string(mapping, "diskImage", "diskImage", &mut issues);
    check_string(mapping, "diskImageMirror", "diskImageMirror", &mut issues);
    check_bool(mapping, "forceDiskImage", "forceDiskImage", &mut issues);
    check_enum_warning(mapping, "portForwarder", "portForwarder", &["ssh", "grpc", "none"], &mut issues);

    // Mounts
    check_mounts(mapping, &mut issues);
    check_enum_warning(mapping, "mountType", "mountType", &["sshfs", "9p", "virtiofs"], &mut issues);
    check_bool(mapping, "mountInotify", "mountInotify", &mut issues);

    // Runtime
    check_enum_warning(mapping, "runtime", "runtime", &["docker", "containerd", "incus"], &mut issues);
    check_bool(mapping, "autoActivate", "autoActivate", &mut issues);
    check_enum_warning(mapping, "modelRunner", "modelRunner", &["docker", "ramalama"], &mut issues);

    // Kubernetes
    check_kubernetes(mapping, &mut issues);

    // Docker
    check_docker(mapping, &mut issues);

    // Provision
    check_provision(mapping, &mut issues);

    // Network
    check_network(mapping, &mut issues);

    issues
}

/// Validate `content` as a colima.yaml: a YAML mapping that passes the typed
/// checks (errors only; warnings never block).
pub(crate) fn validate_config_content(content: &str) -> Result<(), String> {
    validate_yaml_mapping(content)?;

    let value: serde_yaml::Value =
        serde_yaml::from_str(content).map_err(|e| format!("invalid YAML: {e}"))?;
    let issues = validate_colima_config(&value);
    let errors: Vec<&ConfigIssue> = issues.iter().filter(|i| i.severity == IssueSeverity::Error).collect();
    if !errors.is_empty() {
        let mut message = String::from(
            "colima would silently ignore this file and start with defaults instead. Fix these before saving:\n",
        );
        for issue in &errors {
            if issue.path.is_empty() {
                message.push_str(&format!("- {}\n", issue.message));
            } else {
                message.push_str(&format!("- {}: {}\n", issue.path, issue.message));
            }
        }
        return Err(message.trim_end().to_string());
    }

    Ok(())
}

/// `save_profile_config_raw`: validate `content`, back up the existing file
/// (if any) to `colima.yaml.bak`, and write the new content atomically
/// (temp file in the same directory, then rename).
pub(crate) fn save_profile_config_raw_at(home: &std::path::Path, profile: &str, content: &str) -> Result<(), String> {
    validate_profile_name(profile)?;
    validate_config_content(content)?;

    let path = profile_config_path_at(home, profile);
    let dir = path
        .parent()
        .ok_or_else(|| "invalid profile path".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("failed to create profile directory: {e}"))?;

    if path.exists() {
        let backup = dir.join("colima.yaml.bak");
        std::fs::copy(&path, &backup).map_err(|e| format!("failed to back up existing config: {e}"))?;
    }

    write_atomically(&path, content)
}

#[tauri::command]
pub async fn save_profile_config_raw(profile: String, content: String) -> Result<(), String> {
    save_profile_config_raw_at(&colima_home(), &profile, &content)
}

/// `validate_profile_config_raw`: parse `content` and run it through
/// `validate_colima_config`, returning every issue found (empty on a clean
/// file) so the UI can show live feedback while editing, without writing
/// anything. Unlike `save_profile_config_raw`, a YAML parse error here is
/// reported as a single issue rather than an `Err`, so the UI has one
/// consistent shape to render regardless of what's wrong.
#[tauri::command]
pub async fn validate_profile_config_raw(content: String) -> Result<Vec<ConfigIssue>, String> {
    let value: serde_yaml::Value = match serde_yaml::from_str(&content) {
        Ok(v) => v,
        Err(e) => return Ok(vec![ConfigIssue::error("", format!("invalid YAML: {e}"))]),
    };
    if !matches!(value, serde_yaml::Value::Mapping(_) | serde_yaml::Value::Null) {
        return Ok(vec![ConfigIssue::error("", "top-level document must be a mapping")]);
    }
    Ok(validate_colima_config(&value))
}

/// Write `content` to `path` atomically: write to a temp file in the same
/// directory, flush+sync, then rename over the destination. Leaves no temp
/// file behind on success, and cleans it up on failure too.
fn write_atomically(path: &std::path::Path, content: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "invalid profile path".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "invalid profile path".to_string())?
        .to_string_lossy();
    let tmp_path = dir.join(format!(".{file_name}.tmp-{}", std::process::id()));

    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("failed to write config: {e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("failed to write config: {e}"))?;
        file.sync_all().map_err(|e| format!("failed to write config: {e}"))?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to write config: {e}"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A private temp directory used directly as the injected `home` for the
    /// `_at` functions under test. No process env var is ever touched, so
    /// these tests can run concurrently with anything else in the suite
    /// (including other modules' tests) without any locking.
    struct TempDir {
        dir: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "colima-desktop-test-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir { dir }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn source_precedence_prefers_profile_file() {
        let home = TempDir::new("precedence-profile");
        let profile_dir = home.dir.join("default");
        std::fs::create_dir_all(&profile_dir).unwrap();
        std::fs::write(profile_dir.join("colima.yaml"), "cpu: 9\n").unwrap();
        std::fs::create_dir_all(home.dir.join("_templates")).unwrap();
        std::fs::write(home.dir.join("_templates").join("default.yaml"), "cpu: 5\n").unwrap();

        let result = profile_config_raw_at(&home.dir, "default").unwrap();
        assert_eq!(result.source, ConfigSource::Profile);
        assert!(result.exists);
        assert!(result.content.contains("cpu: 9"));
    }

    #[test]
    fn source_precedence_falls_back_to_template() {
        let home = TempDir::new("precedence-template");
        std::fs::create_dir_all(home.dir.join("_templates")).unwrap();
        std::fs::write(home.dir.join("_templates").join("default.yaml"), "cpu: 5\n").unwrap();

        let result = profile_config_raw_at(&home.dir, "default").unwrap();
        assert_eq!(result.source, ConfigSource::Template);
        assert!(!result.exists);
        assert!(result.content.contains("cpu: 5"));
    }

    #[test]
    fn new_machine_defaults_set_vz_and_host() {
        let src = "# c\narch: aarch64\nvmType: qemu # x\nmountType: sshfs\n  vmType: keep\n";
        let m = new_machine_defaults(src, true);
        assert_eq!(m, "# c\narch: host\nvmType: vz\nmountType: sshfs\n  vmType: keep\n");
        let l = new_machine_defaults(src, false);
        assert!(l.contains("vmType: qemu # x") && l.contains("arch: host"));
    }

    #[test]
    fn source_precedence_falls_back_to_builtin() {
        let home = TempDir::new("precedence-builtin");

        let result = profile_config_raw_at(&home.dir, "default").unwrap();
        assert_eq!(result.source, ConfigSource::Builtin);
        assert!(!result.exists);
        assert!(result.content.contains("Colima is Copyright"));
        assert!(result.content.contains("cpu: 2"));
    }

    #[test]
    fn source_precedence_ignores_empty_template() {
        let home = TempDir::new("precedence-empty-template");
        std::fs::create_dir_all(home.dir.join("_templates")).unwrap();
        std::fs::write(home.dir.join("_templates").join("default.yaml"), "").unwrap();

        let result = profile_config_raw_at(&home.dir, "default").unwrap();
        assert_eq!(result.source, ConfigSource::Builtin);
    }

    #[test]
    fn save_rejects_invalid_profile_name() {
        let home = TempDir::new("invalid-profile-name");
        let result = save_profile_config_raw_at(&home.dir, "../evil", "cpu: 2\n");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid profile name"));
    }

    #[test]
    fn save_rejects_invalid_yaml() {
        let home = TempDir::new("invalid-yaml");
        let result = save_profile_config_raw_at(&home.dir, "default", "cpu: [1, 2\n");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid YAML"));
    }

    #[test]
    fn save_rejects_non_mapping_yaml() {
        let home = TempDir::new("non-mapping-yaml");
        let result = save_profile_config_raw_at(&home.dir, "default", "- 1\n- 2\n");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("mapping"));
    }

    #[test]
    fn save_creates_backup_of_existing_file() {
        let home = TempDir::new("backup");
        let profile_dir = home.dir.join("default");
        std::fs::create_dir_all(&profile_dir).unwrap();
        std::fs::write(profile_dir.join("colima.yaml"), "cpu: 1\n").unwrap();

        save_profile_config_raw_at(&home.dir, "default", "cpu: 2\n").unwrap();

        let backup = std::fs::read_to_string(profile_dir.join("colima.yaml.bak")).unwrap();
        assert_eq!(backup, "cpu: 1\n");
        let current = std::fs::read_to_string(profile_dir.join("colima.yaml")).unwrap();
        assert_eq!(current, "cpu: 2\n");
    }

    #[test]
    fn save_creates_profile_dir_if_missing() {
        let home = TempDir::new("create-dir");
        save_profile_config_raw_at(&home.dir, "brandnew", "cpu: 4\n").unwrap();
        let content = std::fs::read_to_string(home.dir.join("brandnew").join("colima.yaml")).unwrap();
        assert_eq!(content, "cpu: 4\n");
    }

    #[test]
    fn save_is_atomic_and_leaves_no_temp_file() {
        let home = TempDir::new("atomic");
        let profile_dir = home.dir.join("default");
        std::fs::create_dir_all(&profile_dir).unwrap();

        save_profile_config_raw_at(&home.dir, "default", "cpu: 7\n").unwrap();

        let entries: Vec<_> = std::fs::read_dir(&profile_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["colima.yaml".to_string()]);
    }

    #[test]
    fn validate_yaml_mapping_accepts_mapping_and_empty() {
        assert!(validate_yaml_mapping("cpu: 2\n").is_ok());
        assert!(validate_yaml_mapping("").is_ok());
    }

    #[test]
    fn validate_yaml_mapping_rejects_scalar_and_sequence() {
        assert!(validate_yaml_mapping("just a string").is_err());
        assert!(validate_yaml_mapping("- 1\n- 2\n").is_err());
    }

    /// Real read-only smoke test against this machine's actual `~/.colima`
    /// files (colima 0.8.1, profile `default`). Ignored by default: run
    /// explicitly with `cargo test -- --ignored config_file::tests::smoke`.
    /// Never writes to `~/.colima` and never starts/stops colima.
    #[tokio::test]
    #[ignore]
    async fn smoke_reads_real_colima_home() {
        let result = profile_config_raw("default".to_string()).await.unwrap();
        assert!(result.exists, "expected ~/.colima/default/colima.yaml to exist on this machine");
        assert_eq!(result.source, ConfigSource::Profile);
        assert!(result.path.ends_with("default/colima.yaml"));
        // Must parse as a mapping, same rule enforced on save.
        validate_yaml_mapping(&result.content).expect("real colima.yaml should be a valid mapping");
        println!("real profile_config_raw: source={:?} path={} exists={} len={}",
            result.source, result.path, result.exists, result.content.len());
    }

    /// Every real config colima has written on this machine (all profiles + the
    /// user template) must pass typed validation with zero errors — otherwise
    /// existing machines could not be saved from the editor.
    #[test]
    #[ignore]
    fn smoke_real_configs_pass_typed_validation() {
        let home = colima_home();
        let mut files = vec![template_path_at(&home)];
        for entry in std::fs::read_dir(&home).expect("read colima home").flatten() {
            let candidate = entry.path().join("colima.yaml");
            if candidate.is_file() {
                files.push(candidate);
            }
        }
        let mut checked = 0;
        for file in files.iter().filter(|f| f.is_file()) {
            let content = std::fs::read_to_string(file).unwrap();
            let value: serde_yaml::Value = serde_yaml::from_str(&content).unwrap();
            let issues = validate_colima_config(&value);
            for issue in &issues {
                println!("{}: {:?} {} — {}", file.display(), issue.severity, issue.path, issue.message);
            }
            assert!(
                issues.iter().all(|i| i.severity != IssueSeverity::Error),
                "{} has validation errors",
                file.display()
            );
            checked += 1;
        }
        println!("validated {checked} real config files");
        assert!(checked > 0, "no real colima config files found");
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    fn issues_for(yaml: &str) -> Vec<ConfigIssue> {
        let value: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        validate_colima_config(&value)
    }

    fn errors_for(yaml: &str) -> Vec<ConfigIssue> {
        issues_for(yaml).into_iter().filter(|i| i.severity == IssueSeverity::Error).collect()
    }

    fn warnings_for(yaml: &str) -> Vec<ConfigIssue> {
        issues_for(yaml).into_iter().filter(|i| i.severity == IssueSeverity::Warning).collect()
    }

    #[test]
    fn enum_fields_accept_empty_and_null() {
        let yaml = "runtime: \"\"\nvmType: \"\"\narch: \"\"\nmountType: \"\"\nportForwarder: \"\"\nmodelRunner: \"\"\nnetwork:\n  mode: \"\"\n";
        assert!(warnings_for(yaml).is_empty());
        let yaml = "runtime:\nvmType: null\narch: ~\nmountType:\nportForwarder:\nmodelRunner:\nnetwork:\n  mode:\n";
        assert!(warnings_for(yaml).is_empty());
        assert_eq!(warnings_for("vmType: bogus\n").len(), 1);
    }

    // --- int fields ---------------------------------------------------

    #[test]
    fn int_field_rejects_float() {
        let errors = errors_for("memory: 2\ncpu: 2.5\n");
        assert!(errors.iter().any(|i| i.path == "cpu"), "{errors:?}");
    }

    #[test]
    fn int_field_rejects_string() {
        let errors = errors_for("cpu: \"2\"\n");
        assert!(errors.iter().any(|i| i.path == "cpu"), "{errors:?}");
    }

    #[test]
    fn int_field_accepts_whole_number() {
        let errors = errors_for("cpu: 4\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    // --- float32 fields -------------------------------------------------

    #[test]
    fn float_field_accepts_int_and_float() {
        assert!(errors_for("memory: 2\n").is_empty());
        assert!(errors_for("memory: 2.5\n").is_empty());
    }

    #[test]
    fn float_field_rejects_string() {
        let errors = errors_for("memory: \"abc\"\n");
        assert!(errors.iter().any(|i| i.path == "memory"), "{errors:?}");
    }

    #[test]
    fn float_field_rejects_bool() {
        let errors = errors_for("memory: true\n");
        assert!(errors.iter().any(|i| i.path == "memory"), "{errors:?}");
    }

    // --- bool fields ------------------------------------------------------

    #[test]
    fn bool_field_rejects_yes_string() {
        // yaml.v3 (YAML 1.2 core schema) resolves bare `yes` as a *string*,
        // not a bool, so assigning it to a bool field is a real unmarshal
        // error in colima, not merely unconventional YAML.
        let errors = errors_for("forwardAgent: yes\n");
        assert!(errors.iter().any(|i| i.path == "forwardAgent"), "{errors:?}");
    }

    #[test]
    fn bool_field_accepts_true_false() {
        assert!(errors_for("forwardAgent: true\n").is_empty());
        assert!(errors_for("forwardAgent: false\n").is_empty());
    }

    #[test]
    fn bool_field_rejects_number() {
        let errors = errors_for("forwardAgent: 1\n");
        assert!(errors.iter().any(|i| i.path == "forwardAgent"), "{errors:?}");
    }

    // --- net.IP fields ------------------------------------------------

    #[test]
    fn ip_field_rejects_invalid_address() {
        let errors = errors_for("network:\n  gatewayAddress: not-an-ip\n");
        assert!(errors.iter().any(|i| i.path == "network.gatewayAddress"), "{errors:?}");
    }

    #[test]
    fn ip_field_accepts_valid_ipv4() {
        let errors = errors_for("network:\n  gatewayAddress: 192.168.5.2\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn ip_field_accepts_null() {
        // colima's default template ships `nat66Prefix: null`.
        let errors = errors_for("network:\n  nat66Prefix: null\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn ip_list_rejects_invalid_entry() {
        let errors = errors_for("network:\n  dns: [8.8.8.8, notanip]\n");
        assert!(errors.iter().any(|i| i.path == "network.dns[1]"), "{errors:?}");
    }

    #[test]
    fn ip_list_accepts_valid_entries() {
        let errors = errors_for("network:\n  dns: [8.8.8.8, 1.1.1.1]\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    // --- string maps (env, dnsHosts) --------------------------------------

    #[test]
    fn string_map_accepts_string_values() {
        let errors = errors_for("env:\n  KEY: value\n  OTHER: \"1\"\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn string_map_rejects_nested_value() {
        let errors = errors_for("env:\n  KEY:\n    nested: true\n");
        assert!(errors.iter().any(|i| i.path == "env.KEY"), "{errors:?}");
    }

    #[test]
    fn dns_hosts_rejects_list_value() {
        let errors = errors_for("network:\n  dnsHosts:\n    example.com: [1, 2]\n");
        assert!(errors.iter().any(|i| i.path == "network.dnsHosts.example.com"), "{errors:?}");
    }

    // --- docker: map[string]any -------------------------------------------

    #[test]
    fn docker_accepts_any_nested_shape() {
        let errors = errors_for("docker:\n  insecure-registries:\n    - myregistry.com:5000\n  features:\n    buildkit: false\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn docker_rejects_non_mapping() {
        let errors = errors_for("docker: not-a-map\n");
        assert!(errors.iter().any(|i| i.path == "docker"), "{errors:?}");
    }

    // --- mounts: list of objects with required `location` -----------------

    #[test]
    fn mounts_requires_location() {
        let errors = errors_for("mounts:\n  - writable: true\n");
        assert!(errors.iter().any(|i| i.path == "mounts[0].location"), "{errors:?}");
    }

    #[test]
    fn mounts_accepts_valid_row() {
        let errors = errors_for("mounts:\n  - location: ~/projects\n    writable: true\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn mounts_rejects_non_bool_writable() {
        let errors = errors_for("mounts:\n  - location: ~/projects\n    writable: yes\n");
        assert!(errors.iter().any(|i| i.path == "mounts[0].writable"), "{errors:?}");
    }

    // --- provision mode enum (warning only, system|user) -------------------

    #[test]
    fn provision_mode_unknown_value_is_warning_not_error() {
        let issues = issues_for("provision:\n  - mode: root\n    script: echo hi\n");
        assert!(
            issues.iter().any(|i| i.path == "provision[0].mode" && i.severity == IssueSeverity::Warning),
            "{issues:?}"
        );
        assert!(errors_for("provision:\n  - mode: root\n    script: echo hi\n").is_empty());
    }

    #[test]
    fn provision_mode_system_and_user_are_clean() {
        let warnings = warnings_for("provision:\n  - mode: system\n    script: echo hi\n  - mode: user\n    script: echo hi\n");
        assert!(warnings.iter().all(|w| w.path != "provision[0].mode" && w.path != "provision[1].mode"), "{warnings:?}");
    }

    // --- nested kubernetes.port int ----------------------------------------

    #[test]
    fn kubernetes_port_rejects_float() {
        let errors = errors_for("kubernetes:\n  port: 6443.5\n");
        assert!(errors.iter().any(|i| i.path == "kubernetes.port"), "{errors:?}");
    }

    #[test]
    fn enabling_kubernetes_with_any_settings_has_no_errors() {
        let yaml = "disk: 10\nkubernetes:\n  enabled: true\n  version: v1.35.0+k3s1\n  port: 0\n  k3sArgs: [--disable=traefik]\n";
        assert!(errors_for(yaml).is_empty());
        assert!(errors_for("kubernetes:\n  enabled: true\n").is_empty());
    }

    #[test]
    fn kubernetes_port_accepts_int() {
        let errors = errors_for("kubernetes:\n  port: 6443\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    // --- kubernetes.version format (error, not warning: colima would fail
    // --- to download a malformed version) -----------------------------------

    #[test]
    fn kubernetes_version_rejects_malformed_string() {
        let errors = errors_for("kubernetes:\n  version: v1.30.0\n");
        assert!(errors.iter().any(|i| i.path == "kubernetes.version"), "{errors:?}");
    }

    #[test]
    fn kubernetes_version_accepts_wellformed_string() {
        let errors = errors_for("kubernetes:\n  version: v1.30.0+k3s1\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn kubernetes_version_accepts_empty_string() {
        // Empty means "use colima's own default" -- not malformed.
        let errors = errors_for("kubernetes:\n  version: \"\"\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn kubernetes_version_rejects_garbage() {
        let errors = errors_for("kubernetes:\n  version: not-a-version\n");
        assert!(errors.iter().any(|i| i.path == "kubernetes.version"), "{errors:?}");
    }

    // --- enums are warnings only, never block saving -----------------------

    #[test]
    fn enum_fields_are_warnings_only() {
        let yaml = "runtime: podman\nvmType: hyperv\narch: sparc\nmountType: nfs\nportForwarder: carrier-pigeon\nmodelRunner: ollama\nnetwork:\n  mode: nat\n";
        assert!(errors_for(yaml).is_empty(), "enum mismatches must never be errors");
        let warnings = warnings_for(yaml);
        for path in ["runtime", "vmType", "arch", "mountType", "portForwarder", "modelRunner", "network.mode"] {
            assert!(warnings.iter().any(|w| w.path == path), "expected warning for {path}: {warnings:?}");
        }
    }

    // --- unknown keys are always allowed ------------------------------------

    #[test]
    fn unknown_top_level_keys_are_ignored() {
        let errors = errors_for("cpu: 2\ntotallyMadeUpKey: 123\nanother:\n  nested: value\n");
        assert!(errors.is_empty(), "{errors:?}");
    }

    // --- null is allowed where colima tolerates it --------------------------

    #[test]
    fn hostname_null_is_allowed() {
        assert!(errors_for("hostname: null\n").is_empty());
    }

    // --- whole-document acceptance tests ------------------------------------

    #[test]
    fn valid_upstream_default_template_passes_with_no_errors() {
        let errors = errors_for(BUILTIN_DEFAULT_YAML);
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn zero_eight_one_style_template_pattern_passes() {
        // Mirrors the shape of a real ~/.colima/_templates/default.yaml from
        // colima 0.8.1: a handful of top-level scalars, nested kubernetes/
        // network mappings, empty docker/provision/mounts, explicit nulls.
        let yaml = r#"
cpu: 2
disk: 60
memory: 4
arch: host
runtime: docker
modelRunner: docker
hostname: null
kubernetes:
  enabled: false
  version: v1.30.0+k3s1
  k3sArgs: [--disable=traefik]
  port: 0
autoActivate: true
network:
  address: false
  mode: shared
  subnet: ""
  nat66Prefix: null
  interface: en0
  preferredRoute: false
  dns: []
  dnsHosts:
    host.docker.internal: host.lima.internal
  hostAddresses: false
  gatewayAddress: 192.168.5.2
forwardAgent: false
docker: {}
vmType: qemu
portForwarder: ssh
rosetta: false
binfmt: true
nestedVirtualization: false
mountType: sshfs
mountInotify: false
cpuType: host
provision: []
sshConfig: true
sshPort: 0
mounts: []
diskImage: ""
diskImageMirror: ""
forceDiskImage: false
rootDisk: 20
env: {}
"#;
        let errors = errors_for(yaml);
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn realistic_broken_config_reports_all_issues() {
        // The exact motivating case: memory as a non-numeric string, a
        // fractional cpu, and an invalid DNS entry -- each individually
        // enough to make colima's real unmarshal fail and silently fall
        // back to defaults.
        let errors = errors_for("memory: \"abc\"\ncpu: 2.5\nnetwork:\n  dns: [notanip]\n");
        assert!(errors.iter().any(|i| i.path == "memory"), "{errors:?}");
        assert!(errors.iter().any(|i| i.path == "cpu"), "{errors:?}");
        assert!(errors.iter().any(|i| i.path == "network.dns[0]"), "{errors:?}");
        assert_eq!(errors.len(), 3, "{errors:?}");
    }

    // --- save_profile_config_raw_at rejects with a readable multi-line error -

    #[test]
    fn save_rejects_typed_validation_errors_with_readable_message() {
        let home = std::env::temp_dir().join(format!(
            "colima-desktop-test-typed-validation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();

        let result = save_profile_config_raw_at(&home, "default", "memory: \"abc\"\ncpu: 2.5\n");
        assert!(result.is_err());
        let message = result.unwrap_err();
        assert!(message.contains("memory"), "{message}");
        assert!(message.contains("cpu"), "{message}");

        let _ = std::fs::remove_dir_all(&home);
    }

    // --- validate_profile_config_raw command ---------------------------------

    #[tokio::test]
    async fn validate_profile_config_raw_reports_issues_without_writing() {
        let issues = validate_profile_config_raw("cpu: 2.5\n".to_string()).await.unwrap();
        assert!(issues.iter().any(|i| i.path == "cpu" && i.severity == IssueSeverity::Error), "{issues:?}");
    }

    #[tokio::test]
    async fn validate_profile_config_raw_reports_parse_errors_as_an_issue_not_an_err() {
        let result = validate_profile_config_raw("cpu: [1, 2\n".to_string()).await;
        assert!(result.is_ok());
        let issues = result.unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, IssueSeverity::Error);
    }

    #[tokio::test]
    async fn validate_profile_config_raw_returns_empty_for_clean_config() {
        let issues = validate_profile_config_raw("cpu: 2\nmemory: 2\n".to_string()).await.unwrap();
        assert!(issues.is_empty(), "{issues:?}");
    }
}
