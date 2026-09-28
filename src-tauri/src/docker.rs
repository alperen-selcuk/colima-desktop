//! Container/image/volume commands. Every `docker` invocation passes an
//! explicit `-H <socket>` (§2.2) resolved via [`crate::colima::resolve_docker_socket`].

use crate::colima::resolve_docker_socket;
use crate::exec;
use crate::state::AppState;
use crate::validate::validate_profile_name;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, State};

/// One parsed host<->container port mapping (tcp, host-bound only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortLink {
    pub host_port: u16,
    pub container_port: u16,
    pub protocol: String,
    pub url: String,
}

/// Parse a docker `Ports` string, e.g.
/// `0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp`, into deduped
/// host-bound tcp port links. Entries without a host binding (no `->`) are
/// ignored, as are non-tcp protocols. `0.0.0.0` and `:::` (ipv6 wildcard)
/// bindings for the same host/container port pair are deduplicated to one
/// entry.
pub fn parse_port_links(raw: &str) -> Vec<PortLink> {
    let mut seen = HashSet::new();
    let mut links = Vec::new();

    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some((host_side, container_side)) = part.split_once("->") else {
            continue; // not host-bound
        };
        // host_side: "0.0.0.0:8080" or ":::8080"
        let Some(host_port_str) = host_side.rsplit(':').next() else {
            continue;
        };
        let Ok(host_port) = host_port_str.parse::<u16>() else {
            continue;
        };
        // container_side: "80/tcp"
        let (container_port_str, protocol) = match container_side.split_once('/') {
            Some((p, proto)) => (p, proto),
            None => (container_side, "tcp"),
        };
        if !protocol.eq_ignore_ascii_case("tcp") {
            continue;
        }
        let Ok(container_port) = container_port_str.parse::<u16>() else {
            continue;
        };

        let key = (host_port, container_port);
        if !seen.insert(key) {
            continue;
        }
        links.push(PortLink {
            host_port,
            container_port,
            protocol: "tcp".to_string(),
            url: format!("http://localhost:{host_port}"),
        });
    }

    links
}

/// Parse a docker `Labels` string (comma-separated `k=v` pairs) into a map.
///
/// **Caveat (verified live against a colima/k3s docker socket):** `docker ps
/// --format '{{json .}}'`'s `Labels` field is itself one comma-joined
/// `"k=v,k=v,..."` string, but some label *values* legitimately contain
/// commas — e.g. `com.docker.compose.project.config_files` when `-f` was
/// given more than one file (`"/a/docker-compose.yml,/a/override.yml"`), or
/// k3s's `annotation.io.kubernetes.container.ports` (a JSON array). Naively
/// splitting the whole blob on `,` shreds those values into bogus
/// pseudo-labels. This helper is therefore only correct for labels whose
/// values are guaranteed comma-free (kept for simple cases and as a unit
/// test fixture); anything that needs `config_files` or other
/// possibly-comma-bearing values MUST come from a real per-container JSON
/// object instead — see [`labels_via_inspect`], which uses `docker inspect
/// --format '{{json .Config.Labels}}'` (a real JSON map, not a flattened
/// string) for that reason.
pub fn parse_labels(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((k, v)) = part.split_once('=') {
            map.insert(k.to_string(), v.to_string());
        } else if !part.is_empty() {
            map.insert(part.to_string(), String::new());
        }
    }
    map
}

/// Labels derived from `io.kubernetes.*` (see [`Container::kubernetes`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerKubernetesInfo {
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
}

/// Derive compose/kubernetes info from a container's real label map (as
/// parsed from `docker inspect --format '{{json .Config.Labels}}'`, never
/// from the flattened `docker ps` `Labels` string — see [`parse_labels`]).
fn kubernetes_info_from_labels(labels: &HashMap<String, String>) -> Option<ContainerKubernetesInfo> {
    let namespace = labels.get("io.kubernetes.pod.namespace")?.clone();
    let pod = labels.get("io.kubernetes.pod.name")?.clone();
    let container = labels.get("io.kubernetes.container.name").cloned();
    Some(ContainerKubernetesInfo {
        namespace,
        pod,
        container,
    })
}

/// Split a `com.docker.compose.project.config_files` label value on commas
/// (its own internal separator when `-f` was passed more than once),
/// trimming whitespace and dropping empty entries.
fn split_config_files(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Batch-resolve every container id's real label map via one `docker
/// inspect --format '{{json .Config.Labels}}' <id...>` call (mirrors
/// [`in_use_image_refs`]'s batching of `.Image`). `docker inspect` prints
/// one JSON line per id it can still find, in the order given, and exits
/// non-zero (with "No such object" on stderr) if any id has since
/// disappeared — but still writes the successful lines to stdout first, so
/// this reads stdout directly rather than going through [`exec::run`]
/// (which would discard it on a non-zero exit). Best-effort: parse failures
/// or a fully empty result yield an empty map rather than propagating an
/// error, matching the "in use" lookup's best-effort contract.
pub(crate) async fn labels_via_inspect(socket: &str, ids: &[&str]) -> HashMap<String, HashMap<String, String>> {
    if ids.is_empty() {
        return HashMap::new();
    }

    let mut args = vec!["-H", socket, "inspect", "--format", "{{.Id}}\t{{json .Config.Labels}}"];
    args.extend(ids.iter().copied());
    let stdout = exec::run_capture_stdout("docker", &args).await;
    parse_inspect_labels_output(&stdout)
}

/// Parse the `<id>\t<json-labels-map>` lines produced by `docker inspect
/// --format '{{.Id}}\t{{json .Config.Labels}}'`. Lines that don't parse
/// (partial output, ids that disappeared mid-inspect) are skipped rather
/// than failing the whole batch.
fn parse_inspect_labels_output(stdout: &str) -> HashMap<String, HashMap<String, String>> {
    let mut map = HashMap::new();
    for line in stdout.lines() {
        let Some((id, json)) = line.split_once('\t') else {
            continue;
        };
        if let Ok(labels) = serde_json::from_str::<Option<HashMap<String, String>>>(json) {
            map.insert(id.to_string(), labels.unwrap_or_default());
        }
    }
    map
}

/// Raw shape of one `docker ps -a --no-trunc --format '{{json .}}'` line.
#[derive(Debug, Clone, Deserialize)]
struct RawContainer {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names")]
    names: String,
    #[serde(rename = "Image")]
    image: String,
    #[serde(rename = "Command")]
    command: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: String,
    #[serde(rename = "CreatedAt", default)]
    created_at: String,
    #[serde(rename = "RunningFor", default)]
    running_for: String,
    #[serde(rename = "Labels", default)]
    labels: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub names: String,
    pub image: String,
    pub command: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub port_links: Vec<PortLink>,
    pub created_at: String,
    pub running_for: String,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    pub compose_working_dir: Option<String>,
    pub compose_config_files: Vec<String>,
    pub kubernetes: Option<ContainerKubernetesInfo>,
}

impl From<RawContainer> for Container {
    fn from(r: RawContainer) -> Self {
        // Labels from `docker ps`'s flattened `Labels` string are safe here
        // only for `compose.project`/`compose.service`, whose values never
        // contain commas in practice; `config_files`/kubernetes enrichment
        // is filled in afterwards from a real per-container label map (see
        // `enrich_with_inspect_labels`) because `docker ps`'s Labels string
        // cannot be split correctly when a value itself contains a comma
        // (verified live: `com.docker.compose.project.config_files` with
        // multiple `-f` files, and k3s's `annotation.io.kubernetes.
        // container.ports` JSON array).
        let labels = parse_labels(&r.labels);
        Container {
            port_links: parse_port_links(&r.ports),
            compose_project: labels.get("com.docker.compose.project").cloned(),
            compose_service: labels.get("com.docker.compose.service").cloned(),
            compose_working_dir: None,
            compose_config_files: Vec::new(),
            kubernetes: None,
            id: r.id,
            names: r.names,
            image: r.image,
            command: r.command,
            state: r.state,
            status: r.status,
            ports: r.ports,
            created_at: r.created_at,
            running_for: r.running_for,
        }
    }
}

/// Fill in `kubernetes`, `composeWorkingDir` and `composeConfigFiles` (and
/// re-derive `composeProject`/`composeService`, which are safe from `docker
/// ps` but re-derived here too for consistency) on every container from a
/// batched `docker inspect` label lookup, since those fields' values can
/// contain commas that the `docker ps` `Labels` string cannot represent
/// unambiguously. Best-effort: a container missing from the inspect result
/// (e.g. removed between `ps` and `inspect`) keeps whatever `docker
/// ps`-derived compose project/service it already had and gets no
/// kubernetes/config-files/working-dir info.
async fn enrich_with_inspect_labels(socket: &str, containers: &mut [Container]) {
    if containers.is_empty() {
        return;
    }
    let ids: Vec<&str> = containers.iter().map(|c| c.id.as_str()).collect();
    let by_id = labels_via_inspect(socket, &ids).await;

    for c in containers.iter_mut() {
        let Some(labels) = by_id.get(&c.id) else {
            continue;
        };
        c.kubernetes = kubernetes_info_from_labels(labels);
        c.compose_project = labels.get("com.docker.compose.project").cloned().or_else(|| c.compose_project.clone());
        c.compose_service = labels.get("com.docker.compose.service").cloned().or_else(|| c.compose_service.clone());
        c.compose_working_dir = labels.get("com.docker.compose.project.working_dir").cloned();
        c.compose_config_files = labels
            .get("com.docker.compose.project.config_files")
            .map(|s| split_config_files(s))
            .unwrap_or_default();
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RawStats {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "CPUPerc")]
    cpu_perc: String,
    #[serde(rename = "MemUsage")]
    mem_usage: String,
    #[serde(rename = "MemPerc")]
    mem_perc: String,
    #[serde(rename = "NetIO")]
    net_io: String,
    #[serde(rename = "BlockIO")]
    block_io: String,
    #[serde(rename = "PIDs")]
    pids: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    pub id: String,
    pub name: String,
    pub cpu_perc: String,
    pub mem_usage: String,
    pub mem_perc: String,
    pub net_io: String,
    pub block_io: String,
    pub pids: String,
}

impl From<RawStats> for ContainerStats {
    fn from(r: RawStats) -> Self {
        ContainerStats {
            id: r.id,
            name: r.name,
            cpu_perc: r.cpu_perc,
            mem_usage: r.mem_usage,
            mem_perc: r.mem_perc,
            net_io: r.net_io,
            block_io: r.block_io,
            pids: r.pids,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RawImage {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Repository")]
    repository: String,
    #[serde(rename = "Tag")]
    tag: String,
    #[serde(rename = "Size")]
    size: String,
    #[serde(rename = "CreatedSince")]
    created_since: String,
    #[serde(rename = "CreatedAt")]
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created_since: String,
    pub created_at: String,
    pub in_use: bool,
}

/// Build the set of match keys (resolved `sha256:...`-stripped image ids,
/// plus `repository:tag` references) that a container is using, from:
/// - `docker inspect --format '{{.Image}}'` lines (one per container id, in
///   the same order the ids were given) — the resolved image id.
/// - the `Image` field of each container's `docker ps -a --format
///   '{{json .}}'` entry — the human-readable reference (e.g.
///   `alpine:latest`), which is what a `docker run <ref>` was invoked with.
///
/// Both are needed: `docker ps`'s own `.Image`/JSON `Image` field is a
/// reference, not an id, and (verified against the installed docker client
/// v28 / server v27, the version colima 0.8.1 ships) `ps` has no `.ImageID`
/// template field at all — `docker inspect` is the only reliable source of
/// the resolved image id.
pub fn parse_in_use_images(inspect_ids_stdout: &str, container_image_refs: &[&str]) -> HashSet<String> {
    let mut refs = HashSet::new();
    for line in inspect_ids_stdout.lines() {
        let id = line.trim().trim_start_matches("sha256:");
        if !id.is_empty() {
            refs.insert(id.to_string());
        }
    }
    for r in container_image_refs {
        let r = r.trim();
        if !r.is_empty() {
            refs.insert(r.to_string());
        }
    }
    refs
}

/// List every container (any state), then batch-`docker inspect` their ids
/// for the resolved image id, and combine with each container's own
/// `Image` reference string. Best-effort: any failure yields an empty set
/// rather than propagating an error, since "in use" is purely informational.
///
/// Uses [`exec::run_capture_stdout`], not [`exec::run`], for the inspect
/// call: if a container id has disappeared between `ps` and `inspect` (a
/// real race — verified live on a busy k3s-managed docker socket, where
/// containers get recreated frequently), `docker inspect id1 id2 id3` still
/// prints `{{.Image}}` for every id it *could* still find before exiting
/// non-zero overall with "No such object: <id>" on stderr. `exec::run`
/// would discard all of that successful output because it treats any
/// non-zero exit as `Err` (dropping stdout); `run_capture_stdout` keeps
/// stdout regardless of exit status, so `parse_in_use_images` still gets
/// the ids that did resolve instead of an empty set for the whole batch.
async fn in_use_image_refs(socket: &str) -> HashSet<String> {
    let containers: Vec<RawContainer> = exec::run_json_lines(
        "docker",
        &["-H", socket, "ps", "-a", "--no-trunc", "--format", "{{json .}}"],
    )
    .await
    .unwrap_or_default();
    if containers.is_empty() {
        return HashSet::new();
    }

    let ids: Vec<&str> = containers.iter().map(|c| c.id.as_str()).collect();
    let mut args = vec!["-H", socket, "inspect", "--format", "{{.Image}}"];
    args.extend(ids.iter().copied());
    let inspect_stdout = exec::run_capture_stdout("docker", &args).await;

    let image_refs: Vec<&str> = containers.iter().map(|c| c.image.as_str()).collect();
    parse_in_use_images(&inspect_stdout, &image_refs)
}

fn image_in_use(img: &RawImage, in_use_refs: &HashSet<String>) -> bool {
    let repo_tag = format!("{}:{}", img.repository, img.tag);
    let short_id = img.id.trim_start_matches("sha256:");
    in_use_refs.contains(&repo_tag)
        || in_use_refs.contains(&img.id)
        || in_use_refs.contains(short_id)
        || in_use_refs
            .iter()
            .any(|r| r.trim_start_matches("sha256:").starts_with(short_id) && !short_id.is_empty())
}

#[derive(Debug, Clone, Deserialize)]
struct RawVolume {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Driver")]
    driver: String,
    #[serde(rename = "Mountpoint")]
    mountpoint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub size: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawSystemDfVolume {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Size")]
    size: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
    pub image: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ports: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<Vec<String>>,
    #[serde(default)]
    pub volumes: Option<Vec<String>>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub restart: Option<String>,
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default)]
    pub auto_remove: Option<bool>,
}

/// Split `s` on whitespace, honoring simple single/double quoting
/// (shell-words style): quoted spans (either `'...'` or `"..."`) are kept
/// together as one token with the quotes stripped; no escape-sequence
/// processing beyond that.
pub fn split_command(s: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_content = false;

    for c in s.chars() {
        match c {
            '\'' if !in_double => {
                in_single = !in_single;
                has_content = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_content = true;
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if has_content {
                    tokens.push(std::mem::take(&mut current));
                    has_content = false;
                }
            }
            c => {
                current.push(c);
                has_content = true;
            }
        }
    }
    if has_content {
        tokens.push(current);
    }
    tokens
}

async fn docker_socket(app: &AppHandle, state: &AppState, profile: &str) -> Result<String, String> {
    let _ = app;
    validate_profile_name(profile)?;
    Ok(resolve_docker_socket(state, profile).await)
}

#[tauri::command]
pub async fn list_containers(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
) -> Result<Vec<Container>, String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let raw: Vec<RawContainer> = exec::run_json_lines(
        "docker",
        &["-H", &socket, "ps", "-a", "--no-trunc", "--format", "{{json .}}"],
    )
    .await?;
    let mut containers: Vec<Container> = raw.into_iter().map(Container::from).collect();
    enrich_with_inspect_labels(&socket, &mut containers).await;
    Ok(containers)
}

#[tauri::command]
pub async fn container_action(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    id: String,
    action: String,
) -> Result<(), String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let (subcmd, extra): (&str, &[&str]) = match action.as_str() {
        "start" => ("start", &[]),
        "stop" => ("stop", &[]),
        "restart" => ("restart", &[]),
        "pause" => ("pause", &[]),
        "unpause" => ("unpause", &[]),
        "kill" => ("kill", &[]),
        "remove" => ("rm", &["-f"]),
        other => return Err(format!("invalid container action: {other}")),
    };
    let mut args = vec!["-H", &socket, subcmd];
    args.extend_from_slice(extra);
    args.push(&id);
    exec::run("docker", &args).await.map(|_| ())
}

#[tauri::command]
pub async fn container_inspect(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    id: String,
) -> Result<serde_json::Value, String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let stdout = exec::run("docker", &["-H", &socket, "inspect", &id]).await?;
    let mut arr: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).map_err(|e| format!("failed to parse inspect output: {e}"))?;
    if arr.is_empty() {
        return Err(format!("no inspect data for {id}"));
    }
    Ok(arr.remove(0))
}

#[tauri::command]
pub async fn container_stats(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
) -> Result<Vec<ContainerStats>, String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let raw: Vec<RawStats> = exec::run_json_lines(
        "docker",
        &["-H", &socket, "stats", "--no-stream", "--format", "{{json .}}"],
    )
    .await?;
    Ok(raw.into_iter().map(ContainerStats::from).collect())
}

#[tauri::command]
pub async fn run_container(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    options: RunOptions,
) -> Result<String, String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let mut args: Vec<String> = vec!["-H".into(), socket, "run".into(), "-d".into()];

    if let Some(name) = &options.name {
        args.push("--name".into());
        args.push(name.clone());
    }
    for p in options.ports.iter().flatten() {
        args.push("-p".into());
        args.push(p.clone());
    }
    for e in options.env.iter().flatten() {
        args.push("-e".into());
        args.push(e.clone());
    }
    for v in options.volumes.iter().flatten() {
        args.push("-v".into());
        args.push(v.clone());
    }
    if let Some(restart) = &options.restart {
        args.push("--restart".into());
        args.push(restart.clone());
    }
    if let Some(network) = &options.network {
        args.push("--network".into());
        args.push(network.clone());
    }
    if options.auto_remove.unwrap_or(false) {
        args.push("--rm".into());
    }
    args.push(options.image.clone());
    if let Some(command) = &options.command {
        args.extend(split_command(command));
    }

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run("docker", &arg_refs).await
}

#[tauri::command]
pub async fn list_images(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
) -> Result<Vec<Image>, String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let raw: Vec<RawImage> = exec::run_json_lines(
        "docker",
        &["-H", &socket, "images", "--format", "{{json .}}"],
    )
    .await?;

    let in_use_refs = in_use_image_refs(&socket).await;

    Ok(raw
        .into_iter()
        .map(|img| {
            let in_use = image_in_use(&img, &in_use_refs);
            Image {
                id: img.id,
                repository: img.repository,
                tag: img.tag,
                size: img.size,
                created_since: img.created_since,
                created_at: img.created_at,
                in_use,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn remove_image(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    id: String,
    force: bool,
) -> Result<(), String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let mut args = vec!["-H", &socket, "rmi"];
    if force {
        args.push("-f");
    }
    args.push(&id);
    exec::run("docker", &args).await.map(|_| ())
}

#[tauri::command]
pub async fn pull_image(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    reference: String,
) -> Result<(), String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let args = ["-H", &socket, "pull", &reference];
    exec::run_streaming(&app, "docker", &args, &profile, "pull").await
}

#[tauri::command]
pub async fn list_volumes(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
) -> Result<Vec<Volume>, String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let raw: Vec<RawVolume> = exec::run_json_lines(
        "docker",
        &["-H", &socket, "volume", "ls", "--format", "{{json .}}"],
    )
    .await?;

    // best-effort size lookup; on any failure every volume's size is None.
    let sizes: HashMap<String, String> = exec::run_json_lines::<RawSystemDfVolume>(
        "docker",
        &["-H", &socket, "system", "df", "-v", "--format", "{{json .}}"],
    )
    .await
    .unwrap_or_default()
    .into_iter()
    .filter_map(|v| v.size.map(|s| (v.name, s)))
    .collect();

    Ok(raw
        .into_iter()
        .map(|v| Volume {
            size: sizes.get(&v.name).cloned(),
            name: v.name,
            driver: v.driver,
            mountpoint: v.mountpoint,
        })
        .collect())
}

#[tauri::command]
pub async fn remove_volume(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    name: String,
) -> Result<(), String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    exec::run("docker", &["-H", &socket, "volume", "rm", &name])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn prune(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    what: String,
) -> Result<String, String> {
    let socket = docker_socket(&app, &state, &profile).await?;
    let args: Vec<&str> = match what.as_str() {
        "containers" => vec!["-H", &socket, "container", "prune", "-f"],
        "images" => vec!["-H", &socket, "image", "prune", "-a", "-f"],
        "volumes" => vec!["-H", &socket, "volume", "prune", "-f"],
        "system" => vec!["-H", &socket, "system", "prune", "-f"],
        other => return Err(format!("invalid prune target: {other}")),
    };
    exec::run("docker", &args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_port_links_dedupes_ipv4_ipv6_and_ignores_non_tcp() {
        let raw = "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp";
        let links = parse_port_links(raw);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].host_port, 8080);
        assert_eq!(links[0].container_port, 80);
        assert_eq!(links[0].protocol, "tcp");
        assert_eq!(links[0].url, "http://localhost:8080");
    }

    #[test]
    fn parse_port_links_multiple_distinct_ports() {
        let raw = "0.0.0.0:8080->80/tcp, 0.0.0.0:8443->443/tcp";
        let links = parse_port_links(raw);
        assert_eq!(links.len(), 2);
    }

    #[test]
    fn parse_port_links_udp_ignored() {
        let raw = "0.0.0.0:53->53/udp";
        assert!(parse_port_links(raw).is_empty());
    }

    #[test]
    fn parse_port_links_empty_string() {
        assert!(parse_port_links("").is_empty());
    }

    #[test]
    fn parse_labels_basic() {
        let raw = "com.docker.compose.project=myapp,com.docker.compose.service=web,other=1";
        let labels = parse_labels(raw);
        assert_eq!(labels.get("com.docker.compose.project").unwrap(), "myapp");
        assert_eq!(labels.get("com.docker.compose.service").unwrap(), "web");
    }

    #[test]
    fn parse_labels_empty() {
        assert!(parse_labels("").is_empty());
    }

    #[test]
    fn container_from_raw_extracts_compose_labels() {
        let raw = RawContainer {
            id: "abc123".into(),
            names: "myapp-web-1".into(),
            image: "nginx".into(),
            command: "\"nginx\"".into(),
            state: "running".into(),
            status: "Up 3 minutes".into(),
            ports: "0.0.0.0:8080->80/tcp".into(),
            created_at: "2024-01-01".into(),
            running_for: "3 minutes ago".into(),
            labels: "com.docker.compose.project=myapp,com.docker.compose.service=web".into(),
        };
        let c: Container = raw.into();
        assert_eq!(c.compose_project.as_deref(), Some("myapp"));
        assert_eq!(c.compose_service.as_deref(), Some("web"));
        assert_eq!(c.port_links.len(), 1);
        assert_eq!(c.kubernetes, None);
        assert_eq!(c.compose_working_dir, None);
        assert!(c.compose_config_files.is_empty());
    }

    #[test]
    fn parse_labels_shreds_values_containing_commas() {
        // Realistic label string captured live from a k3s-managed container
        // on a colima docker socket: `docker ps --format '{{json .}}'`'s
        // `Labels` field flattens everything into one comma-joined string,
        // and the `container.ports` annotation's own JSON-array value
        // contains commas, so naive splitting on `,` breaks it into bogus
        // pseudo-labels. This documents why `list_containers` does NOT rely
        // on `parse_labels` for compose config_files / kubernetes info.
        let raw = concat!(
            "annotation.io.kubernetes.container.hash=6fc7e53a,",
            "io.kubernetes.pod.namespace=k0smotron,",
            "io.kubernetes.pod.name=kmc-my-k0smotron-0,",
            "io.kubernetes.container.name=controller,",
            "annotation.io.kubernetes.container.ports=[{\"name\":\"api\",\"containerPort\":30443,\"protocol\":\"TCP\"}]",
        );
        let labels = parse_labels(raw);
        // The full JSON array value is NOT preserved intact under its key...
        assert_ne!(
            labels.get("annotation.io.kubernetes.container.ports").map(String::as_str),
            Some(r#"[{"name":"api","containerPort":30443,"protocol":"TCP"}]"#)
        );
        // ...instead it gets truncated at the first embedded comma, and the
        // remaining comma-separated fragments become spurious keys with
        // empty values (e.g. `"containerPort":30443` as a bare key).
        assert!(labels.contains_key("\"containerPort\":30443"));
    }

    #[test]
    fn parse_labels_config_files_with_multiple_files_is_split_incorrectly() {
        // Realistic label captured live from `docker compose up` with two
        // `-f` files: the value itself is comma-joined.
        let raw = concat!(
            "com.docker.compose.project=probeproj,",
            "com.docker.compose.project.config_files=/a/docker-compose.yml,/a/docker-compose.override.yml,",
            "com.docker.compose.project.working_dir=/a",
        );
        let labels = parse_labels(raw);
        // Naive split leaves only the first file under the key...
        assert_eq!(
            labels.get("com.docker.compose.project.config_files").map(String::as_str),
            Some("/a/docker-compose.yml")
        );
        // ...and the second file leaks in as a bogus standalone key.
        assert!(labels.contains_key("/a/docker-compose.override.yml"));
    }

    #[test]
    fn split_config_files_handles_multiple_files() {
        let files = split_config_files("/a/docker-compose.yml,/a/docker-compose.override.yml");
        assert_eq!(
            files,
            vec![
                "/a/docker-compose.yml".to_string(),
                "/a/docker-compose.override.yml".to_string()
            ]
        );
    }

    #[test]
    fn split_config_files_single_file() {
        assert_eq!(split_config_files("/a/docker-compose.yml"), vec!["/a/docker-compose.yml".to_string()]);
    }

    #[test]
    fn split_config_files_empty() {
        assert!(split_config_files("").is_empty());
    }

    #[test]
    fn kubernetes_info_from_labels_extracts_pod_and_container() {
        // Realistic label map captured live via `docker inspect --format
        // '{{json .Config.Labels}}'` for a k3s-managed container.
        let mut labels = HashMap::new();
        labels.insert("io.kubernetes.pod.namespace".to_string(), "k0smotron".to_string());
        labels.insert("io.kubernetes.pod.name".to_string(), "kmc-my-k0smotron-0".to_string());
        labels.insert("io.kubernetes.container.name".to_string(), "controller".to_string());
        labels.insert("io.kubernetes.pod.uid".to_string(), "936b24f2".to_string());

        let info = kubernetes_info_from_labels(&labels).unwrap();
        assert_eq!(info.namespace, "k0smotron");
        assert_eq!(info.pod, "kmc-my-k0smotron-0");
        assert_eq!(info.container.as_deref(), Some("controller"));
    }

    #[test]
    fn kubernetes_info_from_labels_sandbox_container_has_no_container_name() {
        // The `k8s_POD_...` pause/sandbox container has pod namespace/name
        // labels but no `io.kubernetes.container.name`.
        let mut labels = HashMap::new();
        labels.insert("io.kubernetes.pod.namespace".to_string(), "kube-system".to_string());
        labels.insert("io.kubernetes.pod.name".to_string(), "coredns-1".to_string());

        let info = kubernetes_info_from_labels(&labels).unwrap();
        assert_eq!(info.container, None);
    }

    #[test]
    fn kubernetes_info_from_labels_none_when_no_k8s_labels() {
        let mut labels = HashMap::new();
        labels.insert("com.docker.compose.project".to_string(), "myapp".to_string());
        assert!(kubernetes_info_from_labels(&labels).is_none());
    }

    #[test]
    fn parse_inspect_labels_output_parses_multiple_lines() {
        let stdout = concat!(
            "abc123\t{\"io.kubernetes.pod.namespace\":\"kube-system\",\"io.kubernetes.pod.name\":\"coredns-1\"}\n",
            "def456\t{\"com.docker.compose.project\":\"myapp\"}\n",
        );
        let map = parse_inspect_labels_output(stdout);
        assert_eq!(map.len(), 2);
        assert_eq!(
            map["abc123"].get("io.kubernetes.pod.namespace").map(String::as_str),
            Some("kube-system")
        );
        assert_eq!(map["def456"].get("com.docker.compose.project").map(String::as_str), Some("myapp"));
    }

    #[test]
    fn parse_inspect_labels_output_handles_null_labels() {
        // A container with no labels at all: docker prints `null`, not `{}`.
        let stdout = "abc123\tnull\n";
        let map = parse_inspect_labels_output(stdout);
        assert!(map["abc123"].is_empty());
    }

    #[test]
    fn parse_inspect_labels_output_skips_unparseable_lines_gracefully() {
        // Simulates a batch where one id vanished mid-inspect: docker still
        // emits successful lines for the others on stdout, with the error
        // going to stderr (not part of this input at all).
        let stdout = concat!(
            "abc123\t{\"com.docker.compose.project\":\"myapp\"}\n",
            "not a valid line without a tab and json\n",
        );
        let map = parse_inspect_labels_output(stdout);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("abc123"));
    }

    #[test]
    fn parse_inspect_labels_output_empty_stdout() {
        assert!(parse_inspect_labels_output("").is_empty());
    }

    #[test]
    fn enrich_config_files_realistic_probeproj_label() {
        // Captured live from `docker inspect --format '{{json
        // .Config.Labels}}'` after `docker compose -f a.yml -f b.yml -p
        // probeproj up -d` on this machine.
        let mut labels = HashMap::new();
        labels.insert(
            "com.docker.compose.project.config_files".to_string(),
            "/a/docker-compose.yml,/a/docker-compose.override.yml".to_string(),
        );
        labels.insert("com.docker.compose.project.working_dir".to_string(), "/a".to_string());
        labels.insert("com.docker.compose.project".to_string(), "probeproj".to_string());
        labels.insert("com.docker.compose.service".to_string(), "web".to_string());

        let files = labels
            .get("com.docker.compose.project.config_files")
            .map(|s| split_config_files(s))
            .unwrap_or_default();
        assert_eq!(
            files,
            vec!["/a/docker-compose.yml".to_string(), "/a/docker-compose.override.yml".to_string()]
        );
    }

    #[test]
    fn parse_in_use_images_extracts_ref_and_id() {
        let inspect_ids = "sha256:abcdef1234567890\n1234567890abcdef";
        let image_refs = vec!["nginx:latest", "redis:7"];
        let refs = parse_in_use_images(inspect_ids, &image_refs);
        assert!(refs.contains("nginx:latest"));
        assert!(refs.contains("abcdef1234567890"));
        assert!(refs.contains("redis:7"));
        assert!(refs.contains("1234567890abcdef"));
    }

    #[test]
    fn parse_in_use_images_empty_inputs() {
        let refs = parse_in_use_images("", &[]);
        assert!(refs.is_empty());
    }

    #[test]
    fn parse_in_use_images_partial_output_when_one_id_vanished() {
        // Reproduces the exact scenario that used to lose ALL in-use data:
        // `docker inspect --format '{{.Image}}' id1 id2 id3` where id2 has
        // disappeared between `ps` and `inspect` (a real race, verified
        // live against a busy k3s-managed docker socket where containers
        // are recreated frequently). Docker still writes `{{.Image}}` for
        // every id it *could* resolve to stdout, in order, before exiting
        // non-zero overall with "No such object: <id2>" on stderr — so
        // `in_use_image_refs` must read that partial stdout via
        // `exec::run_capture_stdout` (not `exec::run`, which discards
        // stdout entirely on a non-zero exit) and this parser must still
        // treat the ids that did print as in-use.
        let inspect_stdout_with_gap = "sha256:aaa111\nsha256:ccc333"; // id2's line is simply absent
        let image_refs = vec!["nginx:latest", "redis:7", "alpine:latest"];
        let refs = parse_in_use_images(inspect_stdout_with_gap, &image_refs);
        // The two ids that did resolve are present...
        assert!(refs.contains("aaa111"));
        assert!(refs.contains("ccc333"));
        // ...and all three `docker ps` Image refs are still recorded
        // (that side never depended on the inspect call succeeding), so
        // the vanished container's own image reference is still usable as
        // a fallback match.
        assert!(refs.contains("nginx:latest"));
        assert!(refs.contains("redis:7"));
        assert!(refs.contains("alpine:latest"));
    }

    #[test]
    fn image_in_use_matches_by_repo_tag() {
        let img = RawImage {
            id: "sha256:abcdef1234567890".into(),
            repository: "nginx".into(),
            tag: "latest".into(),
            size: "10MB".into(),
            created_since: "1 day ago".into(),
            created_at: "2024-01-01".into(),
        };
        let mut refs = HashSet::new();
        refs.insert("nginx:latest".to_string());
        assert!(image_in_use(&img, &refs));
    }

    #[test]
    fn image_in_use_matches_by_id() {
        let img = RawImage {
            id: "sha256:abcdef1234567890".into(),
            repository: "<none>".into(),
            tag: "<none>".into(),
            size: "10MB".into(),
            created_since: "1 day ago".into(),
            created_at: "2024-01-01".into(),
        };
        let mut refs = HashSet::new();
        refs.insert("abcdef1234567890".to_string());
        assert!(image_in_use(&img, &refs));
    }

    #[test]
    fn image_in_use_false_when_not_referenced() {
        let img = RawImage {
            id: "sha256:zzz".into(),
            repository: "unused".into(),
            tag: "latest".into(),
            size: "1MB".into(),
            created_since: "1 day ago".into(),
            created_at: "2024-01-01".into(),
        };
        let refs = HashSet::new();
        assert!(!image_in_use(&img, &refs));
    }

    #[test]
    fn split_command_basic_whitespace() {
        assert_eq!(split_command("sh -c ls"), vec!["sh", "-c", "ls"]);
    }

    #[test]
    fn split_command_honors_quotes() {
        assert_eq!(
            split_command(r#"sh -c "echo hello world""#),
            vec!["sh", "-c", "echo hello world"]
        );
        assert_eq!(
            split_command("sh -c 'echo hi'"),
            vec!["sh", "-c", "echo hi"]
        );
    }

    #[test]
    fn split_command_empty() {
        assert!(split_command("").is_empty());
        assert!(split_command("   ").is_empty());
    }
}
