//! Kubernetes commands. Every `kubectl` call passes an explicit
//! `--context <ctx>` (§2.1) derived from the profile name; never touches
//! `current-context`.

use crate::exec;
use crate::validate::{kube_context, validate_profile_name};
use serde::Serialize;
use serde_json::Value;

fn kubectl_base_args(context: &str) -> Vec<String> {
    vec!["--context".to_string(), context.to_string()]
}

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
}

fn deployment_from_json(dep: &Value) -> K8sDeployment {
    let replicas = dep["spec"]["replicas"].as_i64().unwrap_or(0);
    let ready_replicas = dep["status"]["readyReplicas"].as_i64().unwrap_or(0);
    let images = dep["spec"]["template"]["spec"]["containers"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c["image"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

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
    pub created_at: String,
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
    }
}

// ---------- Commands ----------

#[tauri::command]
pub async fn k8s_namespaces(profile: String) -> Result<Vec<String>, String> {
    validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let args = kubectl_base_args(&ctx);
    let mut arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    arg_refs.extend(["get", "ns", "-o", "json"]);
    let stdout = exec::run("kubectl", &arg_refs).await?;
    let items = items_from_list(&stdout)?;
    Ok(items
        .iter()
        .filter_map(|ns| ns["metadata"]["name"].as_str().map(str::to_string))
        .collect())
}

#[tauri::command]
pub async fn k8s_pods(profile: String, namespace: Option<String>) -> Result<Vec<K8sPod>, String> {
    validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let mut args = kubectl_base_args(&ctx);
    args.push("get".into());
    args.push("pods".into());
    args.extend(ns_args(&namespace));
    args.push("-o".into());
    args.push("json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = exec::run("kubectl", &arg_refs).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(pod_from_json).collect())
}

#[tauri::command]
pub async fn k8s_deployments(
    profile: String,
    namespace: Option<String>,
) -> Result<Vec<K8sDeployment>, String> {
    validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let mut args = kubectl_base_args(&ctx);
    args.push("get".into());
    args.push("deployments".into());
    args.extend(ns_args(&namespace));
    args.push("-o".into());
    args.push("json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = exec::run("kubectl", &arg_refs).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(deployment_from_json).collect())
}

#[tauri::command]
pub async fn k8s_services(
    profile: String,
    namespace: Option<String>,
) -> Result<Vec<K8sService>, String> {
    validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let mut args = kubectl_base_args(&ctx);
    args.push("get".into());
    args.push("services".into());
    args.extend(ns_args(&namespace));
    args.push("-o".into());
    args.push("json".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = exec::run("kubectl", &arg_refs).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(service_from_json).collect())
}

#[tauri::command]
pub async fn k8s_nodes(profile: String) -> Result<Vec<K8sNode>, String> {
    validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let mut args = kubectl_base_args(&ctx);
    args.extend(["get".into(), "nodes".into(), "-o".into(), "json".into()]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdout = exec::run("kubectl", &arg_refs).await?;
    let items = items_from_list(&stdout)?;
    Ok(items.iter().map(node_from_json).collect())
}

fn validate_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "pod" => Ok("pod"),
        "deployment" => Ok("deployment"),
        "service" => Ok("service"),
        "node" => Ok("node"),
        other => Err(format!("invalid kind: {other}")),
    }
}

#[tauri::command]
pub async fn k8s_describe(
    profile: String,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<String, String> {
    validate_profile_name(&profile)?;
    let kind = validate_kind(&kind)?;
    let ctx = kube_context(&profile);
    let mut args = kubectl_base_args(&ctx);
    args.push("describe".into());
    args.push(kind.into());
    args.push(name);
    if let Some(ns) = &namespace {
        args.push("-n".into());
        args.push(ns.clone());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run("kubectl", &arg_refs).await
}

#[tauri::command]
pub async fn k8s_delete_pod(profile: String, namespace: String, name: String) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let mut args = kubectl_base_args(&ctx);
    args.extend([
        "delete".into(),
        "pod".into(),
        name,
        "-n".into(),
        namespace,
        "--wait=false".into(),
    ]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run("kubectl", &arg_refs).await.map(|_| ())
}

#[tauri::command]
pub async fn k8s_scale(
    profile: String,
    namespace: String,
    name: String,
    replicas: u32,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let target = format!("deployment/{name}");
    let replicas_flag = format!("--replicas={replicas}");
    let mut args = kubectl_base_args(&ctx);
    args.extend([
        "scale".into(),
        target,
        replicas_flag,
        "-n".into(),
        namespace,
    ]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run("kubectl", &arg_refs).await.map(|_| ())
}

#[tauri::command]
pub async fn k8s_restart_deployment(
    profile: String,
    namespace: String,
    name: String,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let ctx = kube_context(&profile);
    let target = format!("deployment/{name}");
    let mut args = kubectl_base_args(&ctx);
    args.extend(["rollout".into(), "restart".into(), target, "-n".into(), namespace]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run("kubectl", &arg_refs).await.map(|_| ())
}

#[tauri::command]
pub async fn k8s_yaml(
    profile: String,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<String, String> {
    validate_profile_name(&profile)?;
    let kind = validate_kind(&kind)?;
    let ctx = kube_context(&profile);
    let mut args = kubectl_base_args(&ctx);
    args.push("get".into());
    args.push(kind.into());
    args.push(name);
    if let Some(ns) = &namespace {
        args.push("-n".into());
        args.push(ns.clone());
    }
    args.push("-o".into());
    args.push("yaml".into());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run("kubectl", &arg_refs).await
}

/// Shell one-liner used for interactive shells in a container/pod: prefer
/// `bash` when present, fall back to `sh`. Shared by the docker and
/// kubectl exec command builders in [`crate::pty`].
pub const SHELL_FALLBACK: &str = "command -v bash >/dev/null && exec bash || exec sh";

/// Build the `kubectl --context c exec -it -n ns pod [-c c] -- sh -c
/// '<SHELL_FALLBACK>'` argv (bin excluded) for a pod target; kept here so
/// context derivation stays in one place. Used by [`crate::pty`] to open an
/// in-app terminal session against a pod.
pub fn exec_pod_args(profile: &str, namespace: &str, pod: &str, container: Option<&str>) -> Vec<String> {
    let ctx = kube_context(profile);
    let mut args = vec![
        "--context".to_string(),
        ctx,
        "exec".to_string(),
        "-it".to_string(),
        "-n".to_string(),
        namespace.to_string(),
        pod.to_string(),
    ];
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
    fn exec_pod_args_includes_context_and_container() {
        let args = exec_pod_args("default", "ns", "pod-1", Some("app"));
        assert_eq!(
            args,
            vec![
                "--context", "colima", "exec", "-it", "-n", "ns", "pod-1", "-c", "app", "--", "sh", "-c",
                SHELL_FALLBACK,
            ]
        );
    }

    #[test]
    fn exec_pod_args_no_container() {
        let args = exec_pod_args("rosetta", "ns", "pod-1", None);
        assert_eq!(
            args,
            vec!["--context", "colima-rosetta", "exec", "-it", "-n", "ns", "pod-1", "--", "sh", "-c", SHELL_FALLBACK]
        );
    }
}
