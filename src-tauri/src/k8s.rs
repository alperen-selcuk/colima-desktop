//! Kubernetes commands. Every `kubectl` call passes an explicit
//! `--context <ctx>` (§2.1) derived from the profile name; never touches
//! `current-context`.

use crate::kubeconfig;
use crate::quantity;
use crate::validate::{validate_k8s_arg, validate_profile_name};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::AppHandle;

fn ns_args(namespace: &Option<String>) -> Vec<String> {
    match namespace {
        Some(ns) => vec!["-n".to_string(), ns.clone()],
        None => vec!["-A".to_string()],
    }
}

// ---------- Pods ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sPod {
    pub name: String,
    pub namespace: String,
    pub phase: String,
    pub status: String,
    pub ready: String,
    pub restarts: u32,
    pub created_at: String,
    pub node: Option<String>,
    pub pod_ip: Option<String>,
    pub containers: Vec<String>,
    /// Declared container ports (v0.2.5), for the port-forward dialog.
    pub ports: Vec<PodPort>,
    /// `metadata.labels`.
    pub labels: BTreeMap<String, String>,
    // §6.6: sum over regular containers; null when no container sets it.
    pub cpu_request_milli: Option<i64>,
    pub cpu_limit_milli: Option<i64>,
    pub mem_request_bytes: Option<i64>,
    pub mem_limit_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PodPort {
    pub name: Option<String>,
    pub container_port: i64,
    pub protocol: String,
}

/// `spec.containers[].ports[]` flattened (deduplicated by port+protocol).
fn pod_ports(pod: &Value) -> Vec<PodPort> {
    let mut out: Vec<PodPort> = Vec::new();
    for c in pod["spec"]["containers"].as_array().into_iter().flatten() {
        for p in c["ports"].as_array().into_iter().flatten() {
            let Some(port) = p["containerPort"].as_i64() else { continue };
            let protocol = p["protocol"].as_str().unwrap_or("TCP").to_string();
            if out.iter().any(|e| e.container_port == port && e.protocol == protocol) {
                continue;
            }
            out.push(PodPort { name: p["name"].as_str().map(str::to_string), container_port: port, protocol });
        }
    }
    out
}

fn labels_of(v: &Value) -> BTreeMap<String, String> {
    v.as_object()
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default()
}

/// Derive the `kubectl get pods`-style display status for one pod JSON
/// object: waiting/terminated reasons from container statuses take
/// priority, `deletionTimestamp` means `"Terminating"`, else the raw phase.
/// Mirrors kubectl's `printers` logic closely enough for the common cases.
fn derive_pod_status(pod: &Value) -> String {
    let metadata = &pod["metadata"];
    let status = &pod["status"];
    let phase = status["phase"].as_str().unwrap_or("Unknown").to_string();

    if metadata.get("deletionTimestamp").and_then(Value::as_str).is_some() {
        return "Terminating".to_string();
    }

    // init containers: a waiting/terminated (non-zero) reason on an init
    // container takes priority, e.g. "Init:CrashLoopBackOff" / "Init:2/3".
    if let Some(init_statuses) = status["initContainerStatuses"].as_array() {
        let total = init_statuses.len();
        for (i, cs) in init_statuses.iter().enumerate() {
            let state = &cs["state"];
            if let Some(waiting) = state["waiting"].as_object() {
                if let Some(reason) = waiting.get("reason").and_then(Value::as_str) {
                    return format!("Init:{reason}");
                }
                return format!("Init:{}/{}", i, total);
            }
            if let Some(terminated) = state["terminated"].as_object() {
                let exit_code = terminated.get("exitCode").and_then(Value::as_i64).unwrap_or(0);
                if exit_code != 0 {
                    if let Some(reason) = terminated.get("reason").and_then(Value::as_str) {
                        return format!("Init:{reason}");
                    }
                    return format!("Init:{}/{}", i, total);
                }
            }
        }
    }

    if let Some(container_statuses) = status["containerStatuses"].as_array() {
        // last (most recent) waiting/terminated reason wins, matching
        // kubectl's iteration which reports the last non-running one found.
        for cs in container_statuses.iter().rev() {
            let state = &cs["state"];
            if let Some(waiting) = state["waiting"].as_object() {
                if let Some(reason) = waiting.get("reason").and_then(Value::as_str) {
                    return reason.to_string();
                }
            }
            if let Some(terminated) = state["terminated"].as_object() {
                if let Some(reason) = terminated.get("reason").and_then(Value::as_str) {
                    return reason.to_string();
                }
            }
        }
    }

    phase
}

/// `"ready/total"` from `status.containerStatuses[].ready`.
fn derive_ready(pod: &Value) -> String {
    let statuses = pod["status"]["containerStatuses"].as_array();
    let total = statuses.map(|s| s.len()).unwrap_or(0);
    let ready = statuses
        .map(|s| {
            s.iter()
                .filter(|cs| cs["ready"].as_bool().unwrap_or(false))
                .count()
        })
        .unwrap_or(0);
    format!("{ready}/{total}")
}

/// Sum of `restartCount` across all containers.
fn derive_restarts(pod: &Value) -> u32 {
    pod["status"]["containerStatuses"]
        .as_array()
        .map(|statuses| {
            statuses
                .iter()
                .filter_map(|cs| cs["restartCount"].as_u64())
                .sum::<u64>() as u32
        })
        .unwrap_or(0)
}

fn pod_from_json(pod: &Value) -> K8sPod {
    let containers = pod["spec"]["containers"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let resources = quantity::pod_resource_summary(pod);

    K8sPod {
        name: pod["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        namespace: pod["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        phase: pod["status"]["phase"].as_str().unwrap_or("Unknown").to_string(),
        status: derive_pod_status(pod),
        ready: derive_ready(pod),
        restarts: derive_restarts(pod),
        created_at: pod["metadata"]["creationTimestamp"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        node: pod["spec"]["nodeName"].as_str().map(str::to_string),
        pod_ip: pod["status"]["podIP"].as_str().map(str::to_string),
        containers,
        ports: pod_ports(pod),
        labels: labels_of(&pod["metadata"]["labels"]),
        cpu_request_milli: resources.cpu_request_milli,
        cpu_limit_milli: resources.cpu_limit_milli,
        mem_request_bytes: resources.mem_request_bytes,
        mem_limit_bytes: resources.mem_limit_bytes,
    }
}

fn items_from_list(stdout: &str) -> Result<Vec<Value>, String> {
    let value: Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("failed to parse kubectl JSON: {e}"))?;
    Ok(value["items"].as_array().cloned().unwrap_or_default())
}

// ---------- Deployments ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sDeployment {
    pub name: String,
    pub namespace: String,
    pub ready: String,
    pub up_to_date: i64,
    pub available: i64,
    pub replicas: i64,
    pub created_at: String,
    pub images: Vec<String>,
    /// `spec.template.metadata.labels` (v0.2.5; for the Service selector dropdown).
    pub pod_labels: BTreeMap<String, String>,
}

fn images_of_template(obj: &Value) -> Vec<String> {
    obj["spec"]["template"]["spec"]["containers"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|c| c["image"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn deployment_from_json(dep: &Value) -> K8sDeployment {
    let replicas = dep["spec"]["replicas"].as_i64().unwrap_or(0);
    let ready_replicas = dep["status"]["readyReplicas"].as_i64().unwrap_or(0);
    let images = images_of_template(dep);

    K8sDeployment {
        name: dep["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        namespace: dep["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        ready: format!("{ready_replicas}/{replicas}"),
        up_to_date: dep["status"]["updatedReplicas"].as_i64().unwrap_or(0),
        available: dep["status"]["availableReplicas"].as_i64().unwrap_or(0),
        replicas,
        created_at: dep["metadata"]["creationTimestamp"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        images,
        pod_labels: labels_of(&dep["spec"]["template"]["metadata"]["labels"]),
    }
}

// ---------- StatefulSets ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sStatefulSet {
    pub name: String,
    pub namespace: String,
    pub ready: String,
    pub replicas: i64,
    pub service_name: String,
    pub images: Vec<String>,
    pub created_at: String,
    pub pod_labels: BTreeMap<String, String>,
}

fn statefulset_from_json(sts: &Value) -> K8sStatefulSet {
    let replicas = sts["spec"]["replicas"].as_i64().unwrap_or(1);
    let ready = sts["status"]["readyReplicas"].as_i64().unwrap_or(0);
    K8sStatefulSet {
        name: sts["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        namespace: sts["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        ready: format!("{ready}/{replicas}"),
        replicas,
        service_name: sts["spec"]["serviceName"].as_str().unwrap_or_default().to_string(),
        images: images_of_template(sts),
        created_at: sts["metadata"]["creationTimestamp"].as_str().unwrap_or_default().to_string(),
        pod_labels: labels_of(&sts["spec"]["template"]["metadata"]["labels"]),
    }
}

// ---------- DaemonSets ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sDaemonSet {
    pub name: String,
    pub namespace: String,
    pub desired: i64,
    pub current: i64,
    pub ready: i64,
    pub available: i64,
    pub images: Vec<String>,
    pub created_at: String,
    pub pod_labels: BTreeMap<String, String>,
}

fn daemonset_from_json(ds: &Value) -> K8sDaemonSet {
    let st = &ds["status"];
    K8sDaemonSet {
        name: ds["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        namespace: ds["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        desired: st["desiredNumberScheduled"].as_i64().unwrap_or(0),
        current: st["currentNumberScheduled"].as_i64().unwrap_or(0),
        ready: st["numberReady"].as_i64().unwrap_or(0),
        available: st["numberAvailable"].as_i64().unwrap_or(0),
        images: images_of_template(ds),
        created_at: ds["metadata"]["creationTimestamp"].as_str().unwrap_or_default().to_string(),
        pod_labels: labels_of(&ds["spec"]["template"]["metadata"]["labels"]),
    }
}

// ---------- Services ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sService {
    pub name: String,
    pub namespace: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub cluster_ip: String,
    pub external_ip: Option<String>,
    pub ports: String,
    /// Structured `spec.ports[]` (v0.2.5), for port-forward and the Ingress form.
    pub port_list: Vec<ServicePort>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServicePort {
    pub name: Option<String>,
    pub port: i64,
    pub protocol: String,
}

fn service_port_list(svc: &Value) -> Vec<ServicePort> {
    svc["spec"]["ports"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    Some(ServicePort {
                        name: p["name"].as_str().map(str::to_string),
                        port: p["port"].as_i64()?,
                        protocol: p["protocol"].as_str().unwrap_or("TCP").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Format `spec.ports[]` as `"80:30080/TCP,443/TCP"` (nodePort present ->
/// `port:nodePort/PROTO`, else `port/PROTO`), matching kubectl's display.
fn format_service_ports(svc: &Value) -> String {
    let Some(ports) = svc["spec"]["ports"].as_array() else {
        return String::new();
    };
    ports
        .iter()
        .map(|p| {
            let port = p["port"].as_i64().unwrap_or(0);
            let proto = p["protocol"].as_str().unwrap_or("TCP");
            match p["nodePort"].as_i64() {
                Some(node_port) => format!("{port}:{node_port}/{proto}"),
                None => format!("{port}/{proto}"),
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn external_ip_of(svc: &Value) -> Option<String> {
    // LoadBalancer: status.loadBalancer.ingress[].ip or .hostname
    if let Some(ingress) = svc["status"]["loadBalancer"]["ingress"].as_array() {
        if let Some(first) = ingress.first() {
            if let Some(ip) = first["ip"].as_str() {
                return Some(ip.to_string());
            }
            if let Some(hostname) = first["hostname"].as_str() {
                return Some(hostname.to_string());
            }
        }
    }
    // ExternalName / externalIPs
    if let Some(ext_ips) = svc["spec"]["externalIPs"].as_array() {
        let joined: Vec<String> = ext_ips
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        if !joined.is_empty() {
            return Some(joined.join(","));
        }
    }
    None
}

fn service_from_json(svc: &Value) -> K8sService {
    K8sService {
        name: svc["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        namespace: svc["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        type_: svc["spec"]["type"].as_str().unwrap_or("ClusterIP").to_string(),
        cluster_ip: svc["spec"]["clusterIP"].as_str().unwrap_or_default().to_string(),
        external_ip: external_ip_of(svc),
        ports: format_service_ports(svc),
        port_list: service_port_list(svc),
        created_at: svc["metadata"]["creationTimestamp"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    }
}

// ---------- Nodes ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sNode {
    pub name: String,
    pub status: String,
    pub roles: String,
    pub version: String,
    pub internal_ip: Option<String>,
    pub os_image: String,
    pub cpu: String,
    pub memory: String,
    pub created_at: String,
    pub cpu_allocatable_milli: Option<i64>,
    pub mem_allocatable_bytes: Option<i64>,
}

/// Roles from `node-role.kubernetes.io/<role>` label keys, joined with
/// `,`, sorted; `"<none>"` if none present (matches kubectl).
fn derive_roles(node: &Value) -> String {
    const PREFIX: &str = "node-role.kubernetes.io/";
    let mut roles: Vec<String> = node["metadata"]["labels"]
        .as_object()
        .map(|labels| {
            labels
                .keys()
                .filter_map(|k| k.strip_prefix(PREFIX).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    roles.sort();
    if roles.is_empty() {
        "<none>".to_string()
    } else {
        roles.join(",")
    }
}

/// `"Ready"`/`"NotReady"` from the `Ready` condition's status.
fn derive_node_status(node: &Value) -> String {
    let ready = node["status"]["conditions"]
        .as_array()
        .and_then(|conds| conds.iter().find(|c| c["type"] == "Ready"))
        .and_then(|c| c["status"].as_str());
    match ready {
        Some("True") => "Ready".to_string(),
        _ => "NotReady".to_string(),
    }
}

fn node_from_json(node: &Value) -> K8sNode {
    let addresses = node["status"]["addresses"].as_array();
    let internal_ip = addresses.and_then(|addrs| {
        addrs
            .iter()
            .find(|a| a["type"] == "InternalIP")
            .and_then(|a| a["address"].as_str())
            .map(str::to_string)
    });

    let (cpu_allocatable_milli, mem_allocatable_bytes) = quantity::node_allocatable(node);

    K8sNode {
        name: node["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        status: derive_node_status(node),
        roles: derive_roles(node),
        version: node["status"]["nodeInfo"]["kubeletVersion"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        internal_ip,
        os_image: node["status"]["nodeInfo"]["osImage"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        cpu: node["status"]["capacity"]["cpu"].as_str().unwrap_or_default().to_string(),
        memory: node["status"]["capacity"]["memory"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        created_at: node["metadata"]["creationTimestamp"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        cpu_allocatable_milli,
        mem_allocatable_bytes,
    }
}

// ---------- Commands ----------

/// Fetch + parse namespaces given an already-resolved kubectl runner
/// closure. Factored out so both the tauri command (which routes through
/// [`kubeconfig::kubectl`], with freshness tracking and retry) and the live
/// test (which has a concrete kubeconfig path and no `AppHandle`) share the
/// exact same parsing logic.
async fn namespaces_via<F, Fut>(run: F) -> Result<Vec<String>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let args = vec!["get".to_string(), "ns".to_string(), "-o".to_string(), "json".to_string()];
    let stdout = run(args).await?;
    let items = items_from_list(&stdout)?;
    Ok(items
        .iter()
        .filter_map(|ns| ns["metadata"]["name"].as_str().map(str::to_string))
        .collect())
}

async fn pods_via<F, Fut>(run: F, namespace: &Option<String>) -> Result<Vec<K8sPod>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut args = vec!["get".to_string(), "pods".to_string()];
    args.extend(ns_args(namespace));
    args.push("-o".into());
    args.push("json".into());
    let stdout = run(args).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(pod_from_json).collect())
}

async fn deployments_via<F, Fut>(run: F, namespace: &Option<String>) -> Result<Vec<K8sDeployment>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut args = vec!["get".to_string(), "deployments".to_string()];
    args.extend(ns_args(namespace));
    args.push("-o".into());
    args.push("json".into());
    let stdout = run(args).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(deployment_from_json).collect())
}

async fn statefulsets_via<F, Fut>(run: F, namespace: &Option<String>) -> Result<Vec<K8sStatefulSet>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut args = vec!["get".to_string(), "statefulsets".to_string()];
    args.extend(ns_args(namespace));
    args.push("-o".into());
    args.push("json".into());
    let stdout = run(args).await?;
    Ok(items_from_list(&stdout)?.iter().map(statefulset_from_json).collect())
}

async fn daemonsets_via<F, Fut>(run: F, namespace: &Option<String>) -> Result<Vec<K8sDaemonSet>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut args = vec!["get".to_string(), "daemonsets".to_string()];
    args.extend(ns_args(namespace));
    args.push("-o".into());
    args.push("json".into());
    let stdout = run(args).await?;
    Ok(items_from_list(&stdout)?.iter().map(daemonset_from_json).collect())
}

async fn services_via<F, Fut>(run: F, namespace: &Option<String>) -> Result<Vec<K8sService>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut args = vec!["get".to_string(), "services".to_string()];
    args.extend(ns_args(namespace));
    args.push("-o".into());
    args.push("json".into());
    let stdout = run(args).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(service_from_json).collect())
}

async fn nodes_via<F, Fut>(run: F) -> Result<Vec<K8sNode>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let args = vec!["get".to_string(), "nodes".to_string(), "-o".to_string(), "json".to_string()];
    let stdout = run(args).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(node_from_json).collect())
}

#[tauri::command]
pub async fn k8s_namespaces(app: AppHandle, profile: String) -> Result<Vec<String>, String> {
    validate_profile_name(&profile)?;
    namespaces_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }).await
}

#[tauri::command]
pub async fn k8s_pods(app: AppHandle, profile: String, namespace: Option<String>) -> Result<Vec<K8sPod>, String> {
    validate_profile_name(&profile)?;
    pods_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }, &namespace).await
}

#[tauri::command]
pub async fn k8s_deployments(
    app: AppHandle,
    profile: String,
    namespace: Option<String>,
) -> Result<Vec<K8sDeployment>, String> {
    validate_profile_name(&profile)?;
    deployments_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }, &namespace).await
}

#[tauri::command]
pub async fn k8s_statefulsets(
    app: AppHandle,
    profile: String,
    namespace: Option<String>,
) -> Result<Vec<K8sStatefulSet>, String> {
    validate_profile_name(&profile)?;
    statefulsets_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }, &namespace).await
}

#[tauri::command]
pub async fn k8s_daemonsets(
    app: AppHandle,
    profile: String,
    namespace: Option<String>,
) -> Result<Vec<K8sDaemonSet>, String> {
    validate_profile_name(&profile)?;
    daemonsets_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }, &namespace).await
}

#[tauri::command]
pub async fn k8s_services(
    app: AppHandle,
    profile: String,
    namespace: Option<String>,
) -> Result<Vec<K8sService>, String> {
    validate_profile_name(&profile)?;
    services_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }, &namespace).await
}

#[tauri::command]
pub async fn k8s_nodes(app: AppHandle, profile: String) -> Result<Vec<K8sNode>, String> {
    validate_profile_name(&profile)?;
    nodes_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }).await
}

/// The kind whitelist (§6.6): namespaced `pod | deployment | statefulset | daemonset | service |
/// configmap | secret | ingress`, cluster-scoped `node` (read-only — no
/// delete/edit/apply). Validated in the backend before any kubectl call.
fn validate_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "pod" => Ok("pod"),
        "deployment" => Ok("deployment"),
        "statefulset" => Ok("statefulset"),
        "daemonset" => Ok("daemonset"),
        "service" => Ok("service"),
        "configmap" => Ok("configmap"),
        "secret" => Ok("secret"),
        "ingress" => Ok("ingress"),
        "node" => Ok("node"),
        other => Err(format!("invalid kind: {other}")),
    }
}

/// Whether `kind` is namespace-scoped (all whitelisted kinds except `node`).
fn kind_is_namespaced(kind: &str) -> bool {
    kind != "node"
}

/// Reject mutating operations (delete/edit/apply) against the read-only
/// `node` kind (§6.6: "node is read-only: reject delete/edit/apply").
fn reject_node_mutation(kind: &str) -> Result<(), String> {
    if kind == "node" {
        Err("nodes are read-only: delete/edit/apply is not supported".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn k8s_describe(
    app: AppHandle,
    profile: String,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<String, String> {
    validate_profile_name(&profile)?;
    let kind = validate_kind(&kind)?;
    validate_k8s_arg("name", &name)?;
    if let Some(ns) = &namespace {
        validate_k8s_arg("namespace", ns)?;
    }
    let mut args = vec!["describe".to_string(), kind.to_string(), name];
    if let Some(ns) = &namespace {
        args.push("-n".into());
        args.push(ns.clone());
    }
    kubeconfig::kubectl(&app, &profile, &args).await
}

#[tauri::command]
pub async fn k8s_delete_pod(app: AppHandle, profile: String, namespace: String, name: String) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let args = vec![
        "delete".to_string(),
        "pod".to_string(),
        name,
        "-n".to_string(),
        namespace,
        "--wait=false".to_string(),
    ];
    kubeconfig::kubectl(&app, &profile, &args).await.map(|_| ())
}

/// Kinds that support `kubectl scale` (v0.2.5).
fn validate_scalable(kind: &str) -> Result<&'static str, String> {
    match kind {
        "deployment" => Ok("deployment"),
        "statefulset" => Ok("statefulset"),
        other => Err(format!("{other} cannot be scaled")),
    }
}

/// Kinds that support `kubectl rollout restart` (v0.2.5).
fn validate_restartable(kind: &str) -> Result<&'static str, String> {
    match kind {
        "deployment" => Ok("deployment"),
        "statefulset" => Ok("statefulset"),
        "daemonset" => Ok("daemonset"),
        other => Err(format!("{other} cannot be restarted")),
    }
}

#[tauri::command]
pub async fn k8s_scale(
    app: AppHandle,
    profile: String,
    kind: String,
    namespace: String,
    name: String,
    replicas: u32,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let kind = validate_scalable(&kind)?;
    validate_k8s_arg("namespace", &namespace)?;
    validate_k8s_arg("name", &name)?;
    let target = format!("{kind}/{name}");
    let replicas_flag = format!("--replicas={replicas}");
    let args = vec!["scale".to_string(), target, replicas_flag, "-n".to_string(), namespace];
    kubeconfig::kubectl(&app, &profile, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn k8s_restart(
    app: AppHandle,
    profile: String,
    kind: String,
    namespace: String,
    name: String,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let kind = validate_restartable(&kind)?;
    validate_k8s_arg("namespace", &namespace)?;
    validate_k8s_arg("name", &name)?;
    let target = format!("{kind}/{name}");
    let args = vec!["rollout".to_string(), "restart".to_string(), target, "-n".to_string(), namespace];
    kubeconfig::kubectl(&app, &profile, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn k8s_yaml(
    app: AppHandle,
    profile: String,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<String, String> {
    validate_profile_name(&profile)?;
    let kind = validate_kind(&kind)?;
    validate_k8s_arg("name", &name)?;
    if let Some(ns) = &namespace {
        validate_k8s_arg("namespace", ns)?;
    }
    let mut args = vec!["get".to_string(), kind.to_string(), name];
    if let Some(ns) = &namespace {
        args.push("-n".into());
        args.push(ns.clone());
    }
    args.push("-o".into());
    args.push("yaml".into());
    let yaml = kubeconfig::kubectl(&app, &profile, &args).await?;
    if kind == "secret" {
        Ok(quantity::mask_secret_yaml(&yaml))
    } else {
        Ok(yaml)
    }
}

// ---------- ConfigMaps ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sConfigMap {
    pub name: String,
    pub namespace: String,
    pub keys: Vec<String>,
    pub created_at: String,
}

fn sorted_keys_of(obj: &Value, field: &str) -> Vec<String> {
    obj[field].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

fn configmap_from_json(cm: &Value) -> K8sConfigMap {
    let mut keys = sorted_keys_of(cm, "data");
    keys.extend(sorted_keys_of(cm, "binaryData"));
    keys.sort();
    keys.dedup();

    K8sConfigMap {
        name: cm["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        namespace: cm["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        keys,
        created_at: cm["metadata"]["creationTimestamp"].as_str().unwrap_or_default().to_string(),
    }
}

async fn configmaps_via<F, Fut>(run: F, namespace: &Option<String>) -> Result<Vec<K8sConfigMap>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut args = vec!["get".to_string(), "configmaps".to_string()];
    args.extend(ns_args(namespace));
    args.push("-o".into());
    args.push("json".into());
    let stdout = run(args).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(configmap_from_json).collect())
}

#[tauri::command]
pub async fn k8s_configmaps(
    app: AppHandle,
    profile: String,
    namespace: Option<String>,
) -> Result<Vec<K8sConfigMap>, String> {
    validate_profile_name(&profile)?;
    configmaps_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }, &namespace).await
}

// ---------- Secrets ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sSecret {
    pub name: String,
    pub namespace: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub keys: Vec<String>,
    pub created_at: String,
}

/// Build a [`K8sSecret`] from raw JSON. Only key *names* are kept — actual
/// `data`/`stringData` values are dropped here and never leave the backend
/// via this path (§6.6: "drop values before they leave the backend").
fn secret_from_json(secret: &Value) -> K8sSecret {
    let mut keys = sorted_keys_of(secret, "data");
    keys.extend(sorted_keys_of(secret, "stringData"));
    keys.sort();
    keys.dedup();

    K8sSecret {
        name: secret["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        namespace: secret["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        type_: secret["type"].as_str().unwrap_or("Opaque").to_string(),
        keys,
        created_at: secret["metadata"]["creationTimestamp"].as_str().unwrap_or_default().to_string(),
    }
}

async fn secrets_via<F, Fut>(run: F, namespace: &Option<String>) -> Result<Vec<K8sSecret>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut args = vec!["get".to_string(), "secrets".to_string()];
    args.extend(ns_args(namespace));
    args.push("-o".into());
    args.push("json".into());
    let stdout = run(args).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(secret_from_json).collect())
}

#[tauri::command]
pub async fn k8s_secrets(app: AppHandle, profile: String, namespace: Option<String>) -> Result<Vec<K8sSecret>, String> {
    validate_profile_name(&profile)?;
    secrets_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }, &namespace).await
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    pub value: String,
    pub binary: bool,
}

/// Decode a single secret key's base64 value (as stored in `data`), or find
/// it directly in `stringData` if kubectl happens to return it there.
/// `binary: true` when the decoded bytes aren't valid UTF-8, in which case
/// `value` stays base64-encoded (§6.6).
fn decode_secret_key(secret: &Value, key: &str) -> Result<SecretValue, String> {
    use base64::Engine;

    if let Some(raw) = secret["data"][key].as_str() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|e| format!("failed to base64-decode secret key {key:?}: {e}"))?;
        return Ok(match String::from_utf8(bytes) {
            Ok(s) => SecretValue { value: s, binary: false },
            // Not valid UTF-8: keep the original base64 text as `value` and
            // flag `binary` so the frontend knows not to render it as text.
            Err(_) => SecretValue { value: raw.to_string(), binary: true },
        });
    }
    if let Some(s) = secret["stringData"][key].as_str() {
        return Ok(SecretValue { value: s.to_string(), binary: false });
    }
    Err(format!("key {key:?} not found in secret"))
}

#[tauri::command]
pub async fn k8s_secret_value(
    app: AppHandle,
    profile: String,
    namespace: String,
    name: String,
    key: String,
) -> Result<SecretValue, String> {
    validate_profile_name(&profile)?;
    validate_k8s_arg("namespace", &namespace)?;
    validate_k8s_arg("name", &name)?;
    validate_k8s_arg("key", &key)?;

    let args = vec![
        "get".to_string(),
        "secret".to_string(),
        name,
        "-n".to_string(),
        namespace,
        "-o".to_string(),
        "json".to_string(),
    ];
    let stdout = kubeconfig::kubectl(&app, &profile, &args).await?;
    let secret: Value = serde_json::from_str(stdout.trim()).map_err(|e| format!("failed to parse kubectl JSON: {e}"))?;
    decode_secret_key(&secret, &key)
}

// ---------- Ingresses ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sIngressRule {
    pub host: Option<String>,
    pub path: String,
    pub path_type: Option<String>,
    pub backend: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sIngress {
    pub name: String,
    pub namespace: String,
    pub class_name: Option<String>,
    pub hosts: Vec<String>,
    pub address: Option<String>,
    pub ports: String,
    pub tls: bool,
    pub rules: Vec<K8sIngressRule>,
    pub created_at: String,
}

fn ingress_address(ing: &Value) -> Option<String> {
    let ingress_list = ing["status"]["loadBalancer"]["ingress"].as_array()?;
    let first = ingress_list.first()?;
    first["ip"]
        .as_str()
        .or_else(|| first["hostname"].as_str())
        .map(str::to_string)
}

fn ingress_from_json(ing: &Value) -> K8sIngress {
    let rules = quantity::flatten_ingress_rules(ing)
        .into_iter()
        .map(|r| K8sIngressRule { host: r.host, path: r.path, path_type: r.path_type, backend: r.backend })
        .collect();
    let has_tls = ing["spec"]["tls"].as_array().map(|a| !a.is_empty()).unwrap_or(false);

    K8sIngress {
        name: ing["metadata"]["name"].as_str().unwrap_or_default().to_string(),
        namespace: ing["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
        class_name: ing["spec"]["ingressClassName"].as_str().map(str::to_string),
        hosts: quantity::ingress_hosts(ing),
        address: ingress_address(ing),
        ports: quantity::ingress_ports_summary(ing),
        tls: has_tls,
        rules,
        created_at: ing["metadata"]["creationTimestamp"].as_str().unwrap_or_default().to_string(),
    }
}

async fn ingresses_via<F, Fut>(run: F, namespace: &Option<String>) -> Result<Vec<K8sIngress>, String>
where
    F: FnOnce(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut args = vec!["get".to_string(), "ingresses".to_string()];
    args.extend(ns_args(namespace));
    args.push("-o".into());
    args.push("json".into());
    let stdout = run(args).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(ingress_from_json).collect())
}

#[tauri::command]
pub async fn k8s_ingresses(
    app: AppHandle,
    profile: String,
    namespace: Option<String>,
) -> Result<Vec<K8sIngress>, String> {
    validate_profile_name(&profile)?;
    ingresses_via(|args| async move { kubeconfig::kubectl(&app, &profile, &args).await }, &namespace).await
}

// ---------- Delete / Edit / Apply ----------

#[tauri::command]
pub async fn k8s_delete(
    app: AppHandle,
    profile: String,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let kind = validate_kind(&kind)?;
    reject_node_mutation(kind)?;
    validate_k8s_arg("name", &name)?;
    if let Some(ns) = &namespace {
        validate_k8s_arg("namespace", ns)?;
    }
    if kind_is_namespaced(kind) && namespace.is_none() {
        return Err(format!("namespace is required to delete a {kind}"));
    }

    let mut args = vec!["delete".to_string(), kind.to_string(), name];
    if let Some(ns) = &namespace {
        args.push("-n".into());
        args.push(ns.clone());
    }
    args.push("--wait=false".to_string());
    kubeconfig::kubectl(&app, &profile, &args).await.map(|_| ())
}

/// Strip `metadata.managedFields` and the whole `status` section from a
/// parsed `kubectl get -o yaml` document, keeping `resourceVersion` (needed
/// for the subsequent `k8s_apply_yaml` conflict check). Falls back to
/// returning the original text unchanged if it doesn't parse as YAML.
fn strip_edit_yaml_fields(yaml: &str) -> String {
    let Ok(mut doc) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return yaml.to_string();
    };
    if let Some(mapping) = doc.as_mapping_mut() {
        mapping.remove(serde_yaml::Value::String("status".to_string()));
        if let Some(serde_yaml::Value::Mapping(metadata)) =
            mapping.get_mut(serde_yaml::Value::String("metadata".to_string()))
        {
            metadata.remove(serde_yaml::Value::String("managedFields".to_string()));
        }
    }
    serde_yaml::to_string(&doc).unwrap_or_else(|_| yaml.to_string())
}

#[tauri::command]
pub async fn k8s_edit_yaml(
    app: AppHandle,
    profile: String,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<String, String> {
    validate_profile_name(&profile)?;
    let kind = validate_kind(&kind)?;
    reject_node_mutation(kind)?;
    validate_k8s_arg("name", &name)?;
    if let Some(ns) = &namespace {
        validate_k8s_arg("namespace", ns)?;
    }

    let mut args = vec!["get".to_string(), kind.to_string(), name];
    if let Some(ns) = &namespace {
        args.push("-n".into());
        args.push(ns.clone());
    }
    args.push("-o".into());
    args.push("yaml".into());
    let yaml = kubeconfig::kubectl(&app, &profile, &args).await?;
    Ok(strip_edit_yaml_fields(&yaml))
}

#[tauri::command]
pub async fn k8s_apply_yaml(
    app: AppHandle,
    profile: String,
    kind: String,
    namespace: Option<String>,
    name: String,
    content: String,
    dry_run: bool,
) -> Result<String, String> {
    validate_profile_name(&profile)?;
    let kind = validate_kind(&kind)?;
    reject_node_mutation(kind)?;
    validate_k8s_arg("name", &name)?;
    if let Some(ns) = &namespace {
        validate_k8s_arg("namespace", ns)?;
    }

    let parsed: serde_yaml::Value =
        serde_yaml::from_str(&content).map_err(|e| format!("invalid YAML: {e}"))?;
    quantity::apply_target_matches(&parsed, kind, namespace.as_deref(), &name)?;

    let mut args = vec!["replace".to_string(), "-f".to_string(), "-".to_string()];
    if let Some(ns) = &namespace {
        args.push("-n".into());
        args.push(ns.clone());
    }
    if dry_run {
        args.push("--dry-run=server".to_string());
    }

    match kubeconfig::kubectl_with_stdin(&app, &profile, &args, &content).await {
        Ok(out) => Ok(out),
        Err(e) if e.contains("Conflict") || e.to_lowercase().contains("the object has been modified") => {
            Err("modified since you opened it — reload".to_string())
        }
        Err(e) => Err(e),
    }
}

// ---------- Create / IngressClasses (v0.2.5) ----------

/// Kinds `k8s_create` accepts (namespaced whitelist, §6.10) -> `kind` field.
const CREATABLE_KINDS: [&str; 8] =
    ["Pod", "Deployment", "Service", "Ingress", "StatefulSet", "DaemonSet", "ConfigMap", "Secret"];

/// RFC 1123 DNS label (namespaces): <= 63 chars, lowercase alphanumerics and
/// `-`, starting and ending alphanumeric.
fn is_dns_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// RFC 1123 DNS subdomain (object names): <= 253 chars, dot-separated labels.
fn is_dns_subdomain(s: &str) -> bool {
    !s.is_empty() && s.len() <= 253 && s.split('.').all(is_dns_label)
}

/// Validate a single-document manifest for `k8s_create` and return its
/// `(kind, name)`. The target `namespace` is forced via `-n`; a different
/// `metadata.namespace` in the manifest is rejected.
fn prepare_create(content: &str, namespace: &str) -> Result<(String, String), String> {
    validate_k8s_arg("namespace", namespace)?;
    if !is_dns_label(namespace) {
        return Err(format!("invalid namespace {namespace:?}: use lowercase letters, digits and '-'"));
    }
    let doc: serde_yaml::Value = serde_yaml::from_str(content).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("more than one document") {
            "only a single YAML document can be created at a time".to_string()
        } else {
            format!("invalid YAML: {msg}")
        }
    })?;
    let kind = doc.get("kind").and_then(|v| v.as_str()).unwrap_or_default();
    if !CREATABLE_KINDS.contains(&kind) {
        return Err(format!(
            "kind {kind:?} is not supported here (allowed: {})",
            CREATABLE_KINDS.join(", ")
        ));
    }
    let name = doc.get("metadata").and_then(|m| m.get("name")).and_then(|v| v.as_str()).unwrap_or_default();
    if !is_dns_subdomain(name) {
        return Err(format!("invalid metadata.name {name:?}: use lowercase letters, digits, '-' and '.'"));
    }
    if let Some(ns) = doc.get("metadata").and_then(|m| m.get("namespace")).and_then(|v| v.as_str()) {
        if ns != namespace {
            return Err(format!("metadata.namespace {ns:?} does not match the target namespace {namespace:?}"));
        }
    }
    Ok((kind.to_string(), name.to_string()))
}

/// Turn kubectl's create errors into short, friendly messages.
fn friendly_create_error(err: &str, kind: &str, name: &str, namespace: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("alreadyexists") || lower.contains("already exists") {
        format!("{kind} \"{name}\" already exists in namespace \"{namespace}\"")
    } else if lower.contains("namespaces \"") && lower.contains("not found") {
        format!("Namespace \"{namespace}\" does not exist")
    } else if lower.contains("forbidden") {
        format!("Not allowed: {}", err.trim())
    } else {
        err.trim().to_string()
    }
}

#[tauri::command]
pub async fn k8s_create(
    app: AppHandle,
    profile: String,
    namespace: String,
    content: String,
    dry_run: bool,
) -> Result<String, String> {
    validate_profile_name(&profile)?;
    let (kind, name) = prepare_create(&content, &namespace)?;
    let mut args = vec![
        "create".to_string(),
        "-f".to_string(),
        "-".to_string(),
        "-n".to_string(),
        namespace.clone(),
    ];
    if dry_run {
        args.push("--dry-run=server".to_string());
    }
    kubeconfig::kubectl_with_stdin(&app, &profile, &args, &content)
        .await
        .map_err(|e| friendly_create_error(&e, &kind, &name, &namespace))
}

fn ingress_class_names(stdout: &str) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = items_from_list(stdout)?
        .iter()
        .filter_map(|c| c["metadata"]["name"].as_str().map(str::to_string))
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn k8s_ingress_classes(app: AppHandle, profile: String) -> Result<Vec<String>, String> {
    validate_profile_name(&profile)?;
    let args = vec!["get".to_string(), "ingressclass".to_string(), "-o".to_string(), "json".to_string()];
    let out = kubeconfig::kubectl(&app, &profile, &args).await?;
    ingress_class_names(&out)
}

// ---------- Metrics ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetricEntry {
    pub namespace: String,
    pub name: String,
    pub cpu_milli: i64,
    pub mem_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetrics {
    pub available: bool,
    pub reason: Option<String>,
    pub pods: Vec<PodMetricEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetricEntry {
    pub name: String,
    pub cpu_milli: i64,
    pub mem_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetrics {
    pub available: bool,
    pub reason: Option<String>,
    pub nodes: Vec<NodeMetricEntry>,
}

/// The friendly reason returned when the metrics API isn't present (§6.6:
/// 404/`ServiceUnavailable`/"the server could not find the requested
/// resource" -> `available:false`, not an `Err`).
const METRICS_UNAVAILABLE_REASON: &str = "metrics-server is not installed or not ready";

/// Whether an error string from `kubectl get --raw` against the metrics API
/// indicates the API simply isn't installed/ready (as opposed to some other,
/// real failure that should still surface as an `Err`).
fn is_metrics_unavailable_error(err: &str) -> bool {
    err.contains("NotFound")
        || err.contains("ServiceUnavailable")
        || err.contains("the server could not find the requested resource")
        || err.contains("404")
}

/// Sum `containers[].usage.{cpu,memory}` for one metrics API item (pod or
/// node metrics entries share this container-list shape for pods; nodes have
/// `usage` directly — see [`parse_node_metrics_items`]).
fn sum_container_usage(containers: &Value) -> (i64, i64) {
    let Some(arr) = containers.as_array() else {
        return (0, 0);
    };
    let mut cpu = 0i64;
    let mut mem = 0i64;
    for c in arr {
        if let Some(s) = c["usage"]["cpu"].as_str() {
            cpu += quantity::parse_cpu_millis(s).unwrap_or(0);
        }
        if let Some(s) = c["usage"]["memory"].as_str() {
            mem += quantity::parse_memory_bytes(s).unwrap_or(0);
        }
    }
    (cpu, mem)
}

fn parse_pod_metrics_items(items: &[Value]) -> Vec<PodMetricEntry> {
    items
        .iter()
        .map(|item| {
            let (cpu, mem) = sum_container_usage(&item["containers"]);
            PodMetricEntry {
                namespace: item["metadata"]["namespace"].as_str().unwrap_or_default().to_string(),
                name: item["metadata"]["name"].as_str().unwrap_or_default().to_string(),
                cpu_milli: cpu,
                mem_bytes: mem,
            }
        })
        .collect()
}

fn parse_node_metrics_items(items: &[Value]) -> Vec<NodeMetricEntry> {
    items
        .iter()
        .map(|item| {
            let cpu = item["usage"]["cpu"].as_str().and_then(quantity::parse_cpu_millis).unwrap_or(0);
            let mem = item["usage"]["memory"].as_str().and_then(quantity::parse_memory_bytes).unwrap_or(0);
            NodeMetricEntry { name: item["metadata"]["name"].as_str().unwrap_or_default().to_string(), cpu_milli: cpu, mem_bytes: mem }
        })
        .collect()
}

#[tauri::command]
pub async fn k8s_pod_metrics(app: AppHandle, profile: String, namespace: Option<String>) -> Result<PodMetrics, String> {
    validate_profile_name(&profile)?;
    if let Some(ns) = &namespace {
        validate_k8s_arg("namespace", ns)?;
    }

    let path = match &namespace {
        Some(ns) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods"),
        None => "/apis/metrics.k8s.io/v1beta1/pods".to_string(),
    };
    let args = vec!["get".to_string(), "--raw".to_string(), path];

    match kubeconfig::kubectl(&app, &profile, &args).await {
        Ok(stdout) => {
            let items = items_from_list(&stdout)?;
            Ok(PodMetrics { available: true, reason: None, pods: parse_pod_metrics_items(&items) })
        }
        Err(e) if is_metrics_unavailable_error(&e) => {
            Ok(PodMetrics { available: false, reason: Some(METRICS_UNAVAILABLE_REASON.to_string()), pods: vec![] })
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn k8s_node_metrics(app: AppHandle, profile: String) -> Result<NodeMetrics, String> {
    validate_profile_name(&profile)?;
    let args = vec!["get".to_string(), "--raw".to_string(), "/apis/metrics.k8s.io/v1beta1/nodes".to_string()];

    match kubeconfig::kubectl(&app, &profile, &args).await {
        Ok(stdout) => {
            let items = items_from_list(&stdout)?;
            Ok(NodeMetrics { available: true, reason: None, nodes: parse_node_metrics_items(&items) })
        }
        Err(e) if is_metrics_unavailable_error(&e) => {
            Ok(NodeMetrics { available: false, reason: Some(METRICS_UNAVAILABLE_REASON.to_string()), nodes: vec![] })
        }
        Err(e) => Err(e),
    }
}

/// Shell one-liner used for interactive shells in a container/pod: prefer
/// `bash` when present, fall back to `sh`. Shared by the docker and
/// kubectl exec command builders in [`crate::pty`].
pub const SHELL_FALLBACK: &str = "command -v bash >/dev/null && exec bash || exec sh";

/// Build the `exec -it -n ns pod [-c c] -- sh -c '<SHELL_FALLBACK>'` argv
/// (bin and `--kubeconfig`/`--context` excluded — the caller, [`crate::pty`],
/// prepends those via [`crate::kubeconfig::kubectl_prefix_args`] after
/// ensuring the app-managed kubeconfig is fresh, since PTY spawning can't
/// route through the [`crate::kubeconfig::kubectl`] retry-on-auth-error
/// helper the way one-shot commands do). Used to open an in-app terminal
/// session against a pod.
pub fn exec_pod_args(namespace: &str, pod: &str, container: Option<&str>) -> Vec<String> {
    let mut args = vec!["exec".to_string(), "-it".to_string(), "-n".to_string(), namespace.to_string(), pod.to_string()];
    if let Some(c) = container {
        args.push("-c".to_string());
        args.push(c.to_string());
    }
    args.push("--".to_string());
    args.push("sh".to_string());
    args.push("-c".to_string());
    args.push(SHELL_FALLBACK.to_string());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::kube_context;
    use serde_json::json;

    #[test]
    fn context_naming() {
        assert_eq!(kube_context("default"), "colima");
        assert_eq!(kube_context("rosetta"), "colima-rosetta");
    }

    #[test]
    fn pod_status_running_phase() {
        let pod = json!({
            "metadata": {"name": "p", "namespace": "default", "creationTimestamp": "2024-01-01T00:00:00Z"},
            "status": {"phase": "Running", "containerStatuses": [{"ready": true, "restartCount": 0, "state": {"running": {}}}]}
        });
        assert_eq!(derive_pod_status(&pod), "Running");
    }

    #[test]
    fn pod_status_crash_loop_backoff() {
        let pod = json!({
            "metadata": {"name": "p", "namespace": "default"},
            "status": {
                "phase": "Running",
                "containerStatuses": [{"ready": false, "restartCount": 5, "state": {"waiting": {"reason": "CrashLoopBackOff"}}}]
            }
        });
        assert_eq!(derive_pod_status(&pod), "CrashLoopBackOff");
    }

    #[test]
    fn pod_status_image_pull_backoff() {
        let pod = json!({
            "metadata": {"name": "p", "namespace": "default"},
            "status": {
                "phase": "Pending",
                "containerStatuses": [{"ready": false, "restartCount": 0, "state": {"waiting": {"reason": "ImagePullBackOff"}}}]
            }
        });
        assert_eq!(derive_pod_status(&pod), "ImagePullBackOff");
    }

    #[test]
    fn pod_status_completed() {
        let pod = json!({
            "metadata": {"name": "p", "namespace": "default"},
            "status": {
                "phase": "Succeeded",
                "containerStatuses": [{"ready": false, "restartCount": 0, "state": {"terminated": {"reason": "Completed", "exitCode": 0}}}]
            }
        });
        assert_eq!(derive_pod_status(&pod), "Completed");
    }

    #[test]
    fn pod_status_terminating_from_deletion_timestamp() {
        let pod = json!({
            "metadata": {"name": "p", "namespace": "default", "deletionTimestamp": "2024-01-01T00:00:00Z"},
            "status": {"phase": "Running"}
        });
        assert_eq!(derive_pod_status(&pod), "Terminating");
    }

    #[test]
    fn pod_ready_counts_ready_containers() {
        let pod = json!({
            "status": {"containerStatuses": [
                {"ready": true, "restartCount": 0},
                {"ready": false, "restartCount": 0}
            ]}
        });
        assert_eq!(derive_ready(&pod), "1/2");
    }

    #[test]
    fn pod_ready_zero_containers() {
        let pod = json!({"status": {}});
        assert_eq!(derive_ready(&pod), "0/0");
    }

    #[test]
    fn pod_restarts_sums_across_containers() {
        let pod = json!({
            "status": {"containerStatuses": [
                {"restartCount": 2},
                {"restartCount": 3}
            ]}
        });
        assert_eq!(derive_restarts(&pod), 5);
    }

    #[test]
    fn pod_from_json_full() {
        let pod = json!({
            "metadata": {"name": "web-abc", "namespace": "default", "creationTimestamp": "2024-01-01T00:00:00Z"},
            "spec": {"nodeName": "node1", "containers": [{"name": "web"}]},
            "status": {
                "phase": "Running",
                "podIP": "10.0.0.1",
                "containerStatuses": [{"ready": true, "restartCount": 1, "state": {"running": {}}}]
            }
        });
        let p = pod_from_json(&pod);
        assert_eq!(p.name, "web-abc");
        assert_eq!(p.namespace, "default");
        assert_eq!(p.node.as_deref(), Some("node1"));
        assert_eq!(p.pod_ip.as_deref(), Some("10.0.0.1"));
        assert_eq!(p.containers, vec!["web".to_string()]);
        assert_eq!(p.ready, "1/1");
        assert_eq!(p.restarts, 1);
    }

    #[test]
    fn service_ports_with_node_port() {
        let svc = json!({
            "spec": {"ports": [
                {"port": 80, "nodePort": 30080, "protocol": "TCP"},
                {"port": 443, "protocol": "TCP"}
            ]}
        });
        assert_eq!(format_service_ports(&svc), "80:30080/TCP,443/TCP");
    }

    #[test]
    fn service_ports_empty() {
        let svc = json!({"spec": {}});
        assert_eq!(format_service_ports(&svc), "");
    }

    #[test]
    fn node_roles_from_labels() {
        let node = json!({
            "metadata": {"labels": {
                "node-role.kubernetes.io/control-plane": "",
                "node-role.kubernetes.io/master": "",
                "other-label": "x"
            }}
        });
        assert_eq!(derive_roles(&node), "control-plane,master");
    }

    #[test]
    fn node_roles_none() {
        let node = json!({"metadata": {"labels": {"other": "x"}}});
        assert_eq!(derive_roles(&node), "<none>");
    }

    #[test]
    fn node_status_ready() {
        let node = json!({"status": {"conditions": [{"type": "Ready", "status": "True"}]}});
        assert_eq!(derive_node_status(&node), "Ready");
    }

    #[test]
    fn node_status_not_ready() {
        let node = json!({"status": {"conditions": [{"type": "Ready", "status": "False"}]}});
        assert_eq!(derive_node_status(&node), "NotReady");
    }

    #[test]
    fn node_from_json_capacity_and_ip() {
        let node = json!({
            "metadata": {"name": "colima", "creationTimestamp": "2024-01-01T00:00:00Z"},
            "status": {
                "addresses": [{"type": "InternalIP", "address": "192.168.5.2"}],
                "nodeInfo": {"kubeletVersion": "v1.31.2+k3s1", "osImage": "K3s"},
                "capacity": {"cpu": "2", "memory": "3999000Ki"},
                "conditions": [{"type": "Ready", "status": "True"}]
            }
        });
        let n = node_from_json(&node);
        assert_eq!(n.name, "colima");
        assert_eq!(n.internal_ip.as_deref(), Some("192.168.5.2"));
        assert_eq!(n.cpu, "2");
        assert_eq!(n.memory, "3999000Ki");
        assert_eq!(n.status, "Ready");
    }

    #[test]
    fn deployment_from_json_basic() {
        let dep = json!({
            "metadata": {"name": "web", "namespace": "default", "creationTimestamp": "2024-01-01T00:00:00Z"},
            "spec": {"replicas": 3, "template": {"spec": {"containers": [{"image": "nginx:1.25"}]}}},
            "status": {"readyReplicas": 2, "updatedReplicas": 3, "availableReplicas": 2}
        });
        let d = deployment_from_json(&dep);
        assert_eq!(d.ready, "2/3");
        assert_eq!(d.up_to_date, 3);
        assert_eq!(d.available, 2);
        assert_eq!(d.replicas, 3);
        assert_eq!(d.images, vec!["nginx:1.25".to_string()]);
    }

    #[test]
    fn items_from_list_parses_items_array() {
        let stdout = r#"{"items":[{"a":1},{"a":2}]}"#;
        let items = items_from_list(stdout).unwrap();
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn items_from_list_missing_items_is_empty() {
        let stdout = r#"{}"#;
        let items = items_from_list(stdout).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn exec_pod_args_includes_container() {
        let args = exec_pod_args("ns", "pod-1", Some("app"));
        assert_eq!(args, vec!["exec", "-it", "-n", "ns", "pod-1", "-c", "app", "--", "sh", "-c", SHELL_FALLBACK]);
    }

    #[test]
    fn exec_pod_args_no_container() {
        let args = exec_pod_args("ns", "pod-1", None);
        assert_eq!(args, vec!["exec", "-it", "-n", "ns", "pod-1", "--", "sh", "-c", SHELL_FALLBACK]);
    }

    /// Live diagnostic against this machine's running colima k3s (profile
    /// `default`, context `colima`). Exercises the exact same
    /// fetch-kubeconfig -> parse-JSON pipeline the app uses, just without a
    /// Tauri `AppHandle`: fetches the app-managed kubeconfig into a scratch
    /// directory via [`kubeconfig::fetch_and_write`] (the same logic
    /// `kubeconfig::ensure_fresh`/`kubectl` uses under a real app), then runs
    /// through [`kubeconfig::run_kubectl_once`] and the same `*_via` parsing
    /// helpers the tauri commands call. Ignored by default; run with
    /// `cargo test live_colima_k8s_listing -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_colima_k8s_listing() {
        let profile = "default";
        let ctx = kube_context(profile);
        let scratch_dir = std::env::temp_dir().join(format!(
            "colima-desktop-live-k8s-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&scratch_dir).unwrap();
        let kubeconfig_path = kubeconfig::fetch_and_write(&scratch_dir, profile)
            .await
            .expect("fetch_and_write should succeed against a running colima k3s VM");

        let run = |args: Vec<String>| {
            let path = kubeconfig_path.clone();
            let ctx = ctx.clone();
            async move { kubeconfig::run_kubectl_once(&path, &ctx, &args).await }
        };

        println!("namespaces: {:?}", namespaces_via(run).await.map(|v| v.len()));
        match pods_via(run, &None).await {
            Ok(v) => {
                println!(
                    "pods: {} e.g. {:?}",
                    v.len(),
                    v.iter().take(3).map(|x| format!("{}/{} {}", x.namespace, x.name, x.status)).collect::<Vec<_>>()
                );
                assert!(!v.is_empty(), "expected at least one pod on this running cluster");
            }
            Err(e) => panic!("pods ERROR: {e}"),
        }
        match deployments_via(run, &None).await {
            Ok(v) => println!("deployments: {}", v.len()),
            Err(e) => println!("deployments ERROR: {e}"),
        }
        match services_via(run, &None).await {
            Ok(v) => println!("services: {}", v.len()),
            Err(e) => println!("services ERROR: {e}"),
        }
        match nodes_via(run).await {
            Ok(v) => println!(
                "nodes: {:?}",
                v.iter().map(|n| format!("{} {} {}", n.name, n.status, n.version)).collect::<Vec<_>>()
            ),
            Err(e) => println!("nodes ERROR: {e}"),
        }

        let _ = std::fs::remove_dir_all(&scratch_dir);
    }

    /// Live diagnostic for every new §6.6 READ command against this
    /// machine's running colima k3s (profile `default`, context `colima`,
    /// namespaces k0smotron/kube-system/redis, metrics-server installed).
    /// Same fetch-kubeconfig-into-scratch-dir approach as
    /// [`live_colima_k8s_listing`], but calling straight through
    /// `kubeconfig::run_kubectl_once` with the exact argv the tauri commands
    /// build, so this exercises the real command bodies' logic (JSON
    /// parsing, quantity parsing, masking, edit/apply) without needing a
    /// Tauri `AppHandle`. Read-only: only a dry-run (server-side, no
    /// persisted change) apply is performed, against an unchanged configmap.
    /// Never deletes/edits/applies (non-dry-run) anything, never touches
    /// other kube contexts, never touches `~/.kube/config`, never starts/
    /// stops colima. Ignored by default; run with `cargo test
    /// live_colima_k8s_v012_reads -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_colima_k8s_v012_reads() {
        let profile = "default";
        let ctx = kube_context(profile);
        let scratch_dir = std::env::temp_dir().join(format!(
            "colima-desktop-live-k8s-v012-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&scratch_dir).unwrap();
        let kubeconfig_path = kubeconfig::fetch_and_write(&scratch_dir, profile)
            .await
            .expect("fetch_and_write should succeed against a running colima k3s VM");

        let run = |args: Vec<String>| {
            let path = kubeconfig_path.clone();
            let ctx = ctx.clone();
            async move { kubeconfig::run_kubectl_once(&path, &ctx, &args).await }
        };

        // --- configmaps ---------------------------------------------------
        let mut sample_cm: Option<(String, String)> = None; // (namespace, name)
        match configmaps_via(run, &None).await {
            Ok(v) => {
                println!(
                    "configmaps: {} e.g. {:?}",
                    v.len(),
                    v.iter().take(5).map(|c| format!("{}/{} keys={:?}", c.namespace, c.name, c.keys)).collect::<Vec<_>>()
                );
                sample_cm = v.into_iter().next().map(|c| (c.namespace, c.name));
            }
            Err(e) => println!("configmaps ERROR: {e}"),
        }

        // --- secrets: print only names/key counts, never values -----------
        let mut sample_secret: Option<(String, String, Vec<String>)> = None;
        match secrets_via(run, &None).await {
            Ok(v) => {
                println!(
                    "secrets: {} e.g. {:?}",
                    v.len(),
                    v.iter().take(5).map(|s| format!("{}/{} type={} #keys={}", s.namespace, s.name, s.type_, s.keys.len())).collect::<Vec<_>>()
                );
                sample_secret = v.into_iter().find(|s| !s.keys.is_empty()).map(|s| (s.namespace, s.name, s.keys));
            }
            Err(e) => println!("secrets ERROR: {e}"),
        }

        // --- secret_value: reveal exactly one key of one secret, print only
        //     whether it decoded + its length (never the value itself) -----
        if let Some((ns, name, keys)) = &sample_secret {
            if let Some(key) = keys.first() {
                let args = vec![
                    "get".to_string(), "secret".to_string(), name.clone(),
                    "-n".to_string(), ns.clone(), "-o".to_string(), "json".to_string(),
                ];
                match run(args).await {
                    Ok(stdout) => {
                        let secret: Value = serde_json::from_str(stdout.trim()).expect("parse secret json");
                        match decode_secret_key(&secret, key) {
                            Ok(v) => println!(
                                "secret_value: {ns}/{name} key={key:?} decoded ok, binary={}, len={}",
                                v.binary, v.value.len()
                            ),
                            Err(e) => println!("secret_value ERROR: {e}"),
                        }
                    }
                    Err(e) => println!("secret_value fetch ERROR: {e}"),
                }
            }
        }

        // --- ingresses (may be empty on this cluster) -----------------------
        match ingresses_via(run, &None).await {
            Ok(v) => println!(
                "ingresses: {} e.g. {:?}",
                v.len(),
                v.iter().take(5).map(|i| format!("{}/{} hosts={:?} tls={}", i.namespace, i.name, i.hosts, i.tls)).collect::<Vec<_>>()
            ),
            Err(e) => println!("ingresses ERROR: {e}"),
        }

        // --- pod metrics ------------------------------------------------------
        let pod_metrics_args = vec![
            "get".to_string(), "--raw".to_string(), "/apis/metrics.k8s.io/v1beta1/pods".to_string(),
        ];
        match run(pod_metrics_args).await {
            Ok(stdout) => match items_from_list(&stdout) {
                Ok(items) => {
                    let entries = parse_pod_metrics_items(&items);
                    println!(
                        "pod metrics: available=true, {} entries, e.g. {:?}",
                        entries.len(),
                        entries.iter().take(5).map(|e| format!("{}/{} cpuMilli={} memBytes={}", e.namespace, e.name, e.cpu_milli, e.mem_bytes)).collect::<Vec<_>>()
                    );
                }
                Err(e) => println!("pod metrics parse ERROR: {e}"),
            },
            Err(e) if is_metrics_unavailable_error(&e) => {
                println!("pod metrics: available=false, reason={METRICS_UNAVAILABLE_REASON:?} (raw: {e})")
            }
            Err(e) => println!("pod metrics ERROR: {e}"),
        }

        // --- node metrics ------------------------------------------------------
        let node_metrics_args =
            vec!["get".to_string(), "--raw".to_string(), "/apis/metrics.k8s.io/v1beta1/nodes".to_string()];
        match run(node_metrics_args).await {
            Ok(stdout) => match items_from_list(&stdout) {
                Ok(items) => {
                    let entries = parse_node_metrics_items(&items);
                    println!(
                        "node metrics: available=true, {} entries: {:?}",
                        entries.len(),
                        entries.iter().map(|e| format!("{} cpuMilli={} memBytes={}", e.name, e.cpu_milli, e.mem_bytes)).collect::<Vec<_>>()
                    );
                }
                Err(e) => println!("node metrics parse ERROR: {e}"),
            },
            Err(e) if is_metrics_unavailable_error(&e) => {
                println!("node metrics: available=false, reason={METRICS_UNAVAILABLE_REASON:?} (raw: {e})")
            }
            Err(e) => println!("node metrics ERROR: {e}"),
        }

        // --- edit_yaml for one configmap: print first lines only -----------
        let mut edited_yaml_and_target: Option<(String, String, String)> = None; // (yaml, namespace, name)
        if let Some((ns, name)) = &sample_cm {
            let args = vec![
                "get".to_string(), "configmap".to_string(), name.clone(),
                "-n".to_string(), ns.clone(), "-o".to_string(), "yaml".to_string(),
            ];
            match run(args).await {
                Ok(yaml) => {
                    let stripped = strip_edit_yaml_fields(&yaml);
                    let first_lines: Vec<&str> = stripped.lines().take(8).collect();
                    println!("edit_yaml {ns}/{name} first lines:\n{}", first_lines.join("\n"));
                    assert!(!stripped.contains("managedFields"), "managedFields should be stripped");
                    assert!(!stripped.contains("\nstatus:"), "status should be stripped");
                    edited_yaml_and_target = Some((stripped, ns.clone(), name.clone()));
                }
                Err(e) => println!("edit_yaml ERROR: {e}"),
            }
        } else {
            println!("edit_yaml: skipped (no configmap found to sample)");
        }

        // --- apply_yaml dryRun=true on that unchanged configmap YAML --------
        if let Some((yaml, ns, name)) = &edited_yaml_and_target {
            let parsed: serde_yaml::Value = serde_yaml::from_str(yaml).expect("parse stripped yaml");
            match quantity::apply_target_matches(&parsed, "configmap", Some(ns.as_str()), name) {
                Ok(()) => {
                    let args = vec![
                        "replace".to_string(), "-f".to_string(), "-".to_string(),
                        "-n".to_string(), ns.clone(),
                        "--dry-run=server".to_string(),
                    ];
                    match kubeconfig::run_kubectl_once_with_stdin(&kubeconfig_path, &ctx, &args, yaml).await {
                        Ok(out) => println!("apply_yaml dryRun=true {ns}/{name}: OK, output: {out}"),
                        Err(e) => println!("apply_yaml dryRun=true {ns}/{name} ERROR (non-fatal for this diagnostic): {e}"),
                    }
                }
                Err(e) => println!("apply_target_matches ERROR (unexpected): {e}"),
            }
        } else {
            println!("apply_yaml: skipped (no edited configmap YAML available)");
        }

        let _ = std::fs::remove_dir_all(&scratch_dir);
    }

    // --- v0.2.5 ---------------------------------------------------------------

    #[test]
    fn statefulset_parse() {
        let v = json!({
            "metadata": {"name": "db", "namespace": "default", "creationTimestamp": "2024-01-01T00:00:00Z"},
            "spec": {"replicas": 3, "serviceName": "db-headless",
                "template": {"metadata": {"labels": {"app": "db"}}, "spec": {"containers": [{"image": "postgres:16"}]}}},
            "status": {"readyReplicas": 2}
        });
        let s = statefulset_from_json(&v);
        assert_eq!(s.ready, "2/3");
        assert_eq!(s.service_name, "db-headless");
        assert_eq!(s.images, vec!["postgres:16"]);
        assert_eq!(s.pod_labels.get("app").map(String::as_str), Some("db"));
    }

    #[test]
    fn daemonset_parse() {
        let v = json!({
            "metadata": {"name": "agent", "namespace": "kube-system"},
            "spec": {"template": {"spec": {"containers": [{"image": "a:1"}, {"image": "b:2"}]}}},
            "status": {"desiredNumberScheduled": 2, "currentNumberScheduled": 2, "numberReady": 1, "numberAvailable": 1}
        });
        let d = daemonset_from_json(&v);
        assert_eq!((d.desired, d.current, d.ready, d.available), (2, 2, 1, 1));
        assert_eq!(d.images.len(), 2);
    }

    #[test]
    fn pod_ports_flatten_and_dedupe() {
        let v = json!({"spec": {"containers": [
            {"ports": [{"name": "http", "containerPort": 80}, {"containerPort": 80, "protocol": "TCP"}]},
            {"ports": [{"containerPort": 53, "protocol": "UDP"}]}
        ]}});
        let p = pod_ports(&v);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].name.as_deref(), Some("http"));
        assert_eq!(p[1].protocol, "UDP");
    }

    #[test]
    fn service_port_list_parse() {
        let v = json!({"spec": {"ports": [{"name": "web", "port": 80, "nodePort": 30080}]}});
        let l = service_port_list(&v);
        assert_eq!(l, vec![ServicePort { name: Some("web".into()), port: 80, protocol: "TCP".into() }]);
    }

    #[test]
    fn kind_whitelist_includes_workloads() {
        assert!(validate_kind("statefulset").is_ok());
        assert!(validate_kind("daemonset").is_ok());
        assert!(validate_kind("job").is_err());
        assert!(validate_scalable("daemonset").is_err());
        assert!(validate_scalable("statefulset").is_ok());
        assert!(validate_restartable("daemonset").is_ok());
        assert!(validate_restartable("pod").is_err());
    }

    #[test]
    fn create_accepts_whitelisted_kind() {
        let y = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-1\n  namespace: dev\nspec: {}\n";
        assert_eq!(prepare_create(y, "dev").unwrap(), ("Pod".to_string(), "web-1".to_string()));
    }

    #[test]
    fn create_rejects_bad_input() {
        let ok = "kind: Pod\nmetadata:\n  name: p\n";
        assert!(prepare_create(ok, "-x").is_err());
        assert!(prepare_create(ok, "Bad_NS").is_err());
        assert!(prepare_create("kind: Namespace\nmetadata:\n  name: p\n", "default").is_err());
        assert!(prepare_create("kind: Pod\nmetadata:\n  name: Bad_Name\n", "default").is_err());
        assert!(prepare_create("kind: Pod\nmetadata: {}\n", "default").is_err());
        assert!(prepare_create("kind: Pod\nmetadata:\n  name: p\n  namespace: other\n", "default").is_err());
        assert!(prepare_create("kind: Pod\nmetadata:\n  name: p\n---\nkind: Pod\nmetadata:\n  name: q\n", "default")
            .unwrap_err()
            .contains("single"));
    }

    #[test]
    fn create_error_friendly() {
        let e = "Error from server (AlreadyExists): error when creating \"STDIN\": pods \"x\" already exists";
        assert_eq!(friendly_create_error(e, "Pod", "x", "default"), "Pod \"x\" already exists in namespace \"default\"");
        let e = "Error from server (NotFound): namespaces \"zzz\" not found";
        assert_eq!(friendly_create_error(e, "Pod", "x", "zzz"), "Namespace \"zzz\" does not exist");
        assert_eq!(friendly_create_error("boom\n", "Pod", "x", "d"), "boom");
    }

    #[test]
    fn ingress_class_names_sorted() {
        let out = r#"{"items":[{"metadata":{"name":"traefik"}},{"metadata":{"name":"nginx"}}]}"#;
        assert_eq!(ingress_class_names(out).unwrap(), vec!["nginx", "traefik"]);
    }
}
