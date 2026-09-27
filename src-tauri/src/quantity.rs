//! Pure helpers for Kubernetes v0.1.2 features (§6.6): Kubernetes "quantity"
//! parsing (CPU -> millicores, memory -> bytes), summing container
//! requests/limits across a pod spec, ingress rule flattening, secret value
//! masking for `k8s_yaml`, and apply-target matching for `k8s_apply_yaml`.
//! Kept free of I/O so they're exhaustively unit-testable.

use serde_json::Value;

// ---------------------------------------------------------------------------
// CPU quantity parsing -> millicores
// ---------------------------------------------------------------------------

/// Parse a Kubernetes CPU quantity string (`"250m"`, `"1"`, `"0.5"`,
/// `"123456789n"`, `"1500u"`) into millicores. Returns `None` if the string
/// doesn't parse as a number (with optional suffix).
pub fn parse_cpu_millis(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    // Suffixed forms: n (nano), u (micro), m (milli). Longest/most specific
    // first so "m" doesn't accidentally match inside another suffix.
    if let Some(num) = s.strip_suffix('n') {
        let n: f64 = num.parse().ok()?;
        return Some((n / 1_000_000.0).round() as i64);
    }
    if let Some(num) = s.strip_suffix('u') {
        let n: f64 = num.parse().ok()?;
        return Some((n / 1_000.0).round() as i64);
    }
    if let Some(num) = s.strip_suffix('m') {
        let n: f64 = num.parse().ok()?;
        return Some(n.round() as i64);
    }

    // Plain number of cores (may be fractional, e.g. "0.5").
    let cores: f64 = s.parse().ok()?;
    Some((cores * 1000.0).round() as i64)
}

// ---------------------------------------------------------------------------
// Memory quantity parsing -> bytes
// ---------------------------------------------------------------------------

/// Parse a Kubernetes memory quantity string (`"128Mi"`, `"1Gi"`,
/// `"123456Ki"`, `"1G"`, `"500M"`, `"1e3"`, plain bytes like `"1024"`) into
/// bytes. Supports binary suffixes (Ki/Mi/Gi/Ti/Pi/Ei), decimal SI suffixes
/// (k/K/M/G/T/P/E), and exponent notation (e.g. `"1e3"`, `"1E3"`). Returns
/// `None` if unparsable.
pub fn parse_memory_bytes(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    const BINARY_SUFFIXES: [(&str, f64); 6] = [
        ("Ki", 1024.0),
        ("Mi", 1024.0 * 1024.0),
        ("Gi", 1024.0 * 1024.0 * 1024.0),
        ("Ti", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Pi", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Ei", 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
    ];
    for (suffix, multiplier) in BINARY_SUFFIXES {
        if let Some(num) = s.strip_suffix(suffix) {
            let n: f64 = num.parse().ok()?;
            return Some((n * multiplier).round() as i64);
        }
    }

    const DECIMAL_SUFFIXES: [(&str, f64); 6] = [
        ("k", 1_000.0),
        ("K", 1_000.0),
        ("M", 1_000_000.0),
        ("G", 1_000_000_000.0),
        ("T", 1_000_000_000_000.0),
        ("P", 1_000_000_000_000_000.0),
    ];
    for (suffix, multiplier) in DECIMAL_SUFFIXES {
        if let Some(num) = s.strip_suffix(suffix) {
            let n: f64 = num.parse().ok()?;
            return Some((n * multiplier).round() as i64);
        }
    }

    // Exponent notation (e.g. "1e3") or plain bytes ("1024", "1.5").
    let n: f64 = s.parse().ok()?;
    Some(n.round() as i64)
}

// ---------------------------------------------------------------------------
// Request/limit summing across a pod spec's regular (non-init) containers.
// ---------------------------------------------------------------------------

/// Sum of a resource ("cpu" or "memory") across `pod.spec.containers[].
/// resources.<requests|limits>.<resource>`, using `parse` to convert each
/// container's quantity string. Init containers are intentionally excluded
/// (they don't run concurrently with regular containers, so summing them
/// would overstate steady-state usage). Returns `None` when *no* container
/// sets the field (§6.6: "null when no container sets it"); containers that
/// don't set it are simply skipped (not treated as zero) when at least one
/// other container does.
fn sum_resource_millis_or_bytes(
    pod_spec_containers: &Value,
    section: &str,
    resource: &str,
    parse: impl Fn(&str) -> Option<i64>,
) -> Option<i64> {
    let containers = pod_spec_containers.as_array()?;
    let mut total: i64 = 0;
    let mut any_set = false;
    for c in containers {
        if let Some(qty) = c["resources"][section][resource].as_str() {
            if let Some(v) = parse(qty) {
                total += v;
                any_set = true;
            }
        }
    }
    if any_set {
        Some(total)
    } else {
        None
    }
}

/// The four pod-level resource-usage fields added to `K8sPod` (§6.6):
/// `cpuRequestMilli`, `cpuLimitMilli`, `memRequestBytes`, `memLimitBytes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PodResourceSummary {
    pub cpu_request_milli: Option<i64>,
    pub cpu_limit_milli: Option<i64>,
    pub mem_request_bytes: Option<i64>,
    pub mem_limit_bytes: Option<i64>,
}

/// Compute [`PodResourceSummary`] from a pod JSON object's
/// `spec.containers[]` (regular containers only; init containers excluded).
pub fn pod_resource_summary(pod: &Value) -> PodResourceSummary {
    let containers = &pod["spec"]["containers"];
    PodResourceSummary {
        cpu_request_milli: sum_resource_millis_or_bytes(containers, "requests", "cpu", parse_cpu_millis),
        cpu_limit_milli: sum_resource_millis_or_bytes(containers, "limits", "cpu", parse_cpu_millis),
        mem_request_bytes: sum_resource_millis_or_bytes(containers, "requests", "memory", parse_memory_bytes),
        mem_limit_bytes: sum_resource_millis_or_bytes(containers, "limits", "memory", parse_memory_bytes),
    }
}

/// Node allocatable cpu (millicores) / memory (bytes), from
/// `node.status.allocatable.{cpu,memory}`. `None` when the field is absent or
/// unparsable.
pub fn node_allocatable(node: &Value) -> (Option<i64>, Option<i64>) {
    let cpu = node["status"]["allocatable"]["cpu"].as_str().and_then(parse_cpu_millis);
    let mem = node["status"]["allocatable"]["memory"].as_str().and_then(parse_memory_bytes);
    (cpu, mem)
}

// ---------------------------------------------------------------------------
// Ingress rule flattening
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlatIngressRule {
    pub host: Option<String>,
    pub path: String,
    pub path_type: Option<String>,
    pub backend: String,
}

/// Flatten `ingress.spec.rules[].{host, http.paths[]}` into one row per
/// (host, path) pair, with `backend` formatted as `"svc:port"` (port name
/// preferred when present, else the numeric port; falls back to
/// `resource.kind/name` for a resource backend).
pub fn flatten_ingress_rules(ingress: &Value) -> Vec<FlatIngressRule> {
    let mut out = Vec::new();
    let Some(rules) = ingress["spec"]["rules"].as_array() else {
        return out;
    };
    for rule in rules {
        let host = rule["host"].as_str().map(str::to_string);
        let Some(paths) = rule["http"]["paths"].as_array() else {
            continue;
        };
        for p in paths {
            let path = p["path"].as_str().unwrap_or("/").to_string();
            let path_type = p["pathType"].as_str().map(str::to_string);
            let backend = format_ingress_backend(&p["backend"]);
            out.push(FlatIngressRule { host: host.clone(), path, path_type, backend });
        }
    }
    out
}

fn format_ingress_backend(backend: &Value) -> String {
    if let Some(svc) = backend.get("service") {
        let name = svc["name"].as_str().unwrap_or("?");
        if let Some(port_name) = svc["port"]["name"].as_str() {
            return format!("{name}:{port_name}");
        }
        if let Some(port_num) = svc["port"]["number"].as_i64() {
            return format!("{name}:{port_num}");
        }
        return format!("{name}:?");
    }
    if let Some(res) = backend.get("resource") {
        let kind = res["kind"].as_str().unwrap_or("?");
        let name = res["name"].as_str().unwrap_or("?");
        return format!("{kind}/{name}");
    }
    "?".to_string()
}

/// All distinct hosts across an ingress's rules, in first-seen order,
/// `None` hosts (default backend rules) skipped.
pub fn ingress_hosts(ingress: &Value) -> Vec<String> {
    let mut hosts = Vec::new();
    for rule in flatten_ingress_rules(ingress) {
        if let Some(h) = rule.host {
            if !hosts.contains(&h) {
                hosts.push(h);
            }
        }
    }
    hosts
}

/// `"80"` or `"80, 443"` style port summary: 443 present whenever
/// `spec.tls` is non-empty (ingress controllers conventionally serve TLS on
/// 443), 80 always present (ingress controllers conventionally also serve
/// plain HTTP), matching kubectl's own `get ingress` ports column behavior.
pub fn ingress_ports_summary(ingress: &Value) -> String {
    let has_tls = ingress["spec"]["tls"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if has_tls {
        "80, 443".to_string()
    } else {
        "80".to_string()
    }
}

// ---------------------------------------------------------------------------
// Secret masking (for `k8s_yaml` on secrets, §6.6).
// ---------------------------------------------------------------------------

pub const SECRET_MASK: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

/// Replace every scalar value under `data`/`stringData` top-level keys in a
/// parsed Secret YAML document with [`SECRET_MASK`], leaving keys, structure,
/// and every other field (metadata, type, etc) untouched. Operates on a
/// `serde_yaml::Value` so it works directly on `kubectl get secret -o yaml`
/// output before it's returned to the frontend.
pub fn mask_secret_yaml_value(doc: &mut serde_yaml::Value) {
    for section in ["data", "stringData"] {
        if let Some(mapping) = doc.get_mut(serde_yaml::Value::String(section.to_string())).and_then(|v| v.as_mapping_mut()) {
            for (_key, value) in mapping.iter_mut() {
                *value = serde_yaml::Value::String(SECRET_MASK.to_string());
            }
        }
    }
}

/// Mask a raw `kubectl get secret -o yaml` string. Falls back to returning
/// the original text unchanged if it doesn't parse as YAML (kubectl always
/// produces valid YAML on success, so this should not happen in practice,
/// but never fail the whole call just because masking couldn't be applied).
pub fn mask_secret_yaml(yaml: &str) -> String {
    match serde_yaml::from_str::<serde_yaml::Value>(yaml) {
        Ok(mut doc) => {
            mask_secret_yaml_value(&mut doc);
            serde_yaml::to_string(&doc).unwrap_or_else(|_| yaml.to_string())
        }
        Err(_) => yaml.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Apply-target matching (`k8s_apply_yaml`, §6.6).
// ---------------------------------------------------------------------------

/// Normalize a kubectl kind name / apiVersion `kind` field for comparison:
/// case-insensitive (kubectl/YAML kind fields are conventionally
/// capitalized, e.g. `ConfigMap`, while our internal kind identifiers are
/// lowercase, e.g. `configmap`).
fn kind_matches(yaml_kind: &str, target_kind: &str) -> bool {
    // Map our lowercase whitelist identifiers to the Kubernetes `kind` field.
    let expected = match target_kind {
        "pod" => "Pod",
        "deployment" => "Deployment",
        "service" => "Service",
        "configmap" => "ConfigMap",
        "secret" => "Secret",
        "ingress" => "Ingress",
        "node" => "Node",
        other => other,
    };
    yaml_kind.eq_ignore_ascii_case(expected)
}

/// Validate that a parsed YAML document's `kind` / `metadata.name` /
/// `metadata.namespace` match the intended apply target, before the content
/// is piped into `kubectl replace -f -`. `target_namespace` is `None` for
/// cluster-scoped kinds (node — though node is read-only and never reaches
/// this path in practice).
pub fn apply_target_matches(
    doc: &serde_yaml::Value,
    target_kind: &str,
    target_namespace: Option<&str>,
    target_name: &str,
) -> Result<(), String> {
    let yaml_kind = doc.get("kind").and_then(|v| v.as_str()).unwrap_or_default();
    if !kind_matches(yaml_kind, target_kind) {
        return Err(format!("YAML kind {yaml_kind:?} does not match target kind {target_kind:?}"));
    }

    let yaml_name = doc.get("metadata").and_then(|m| m.get("name")).and_then(|v| v.as_str()).unwrap_or_default();
    if yaml_name != target_name {
        return Err(format!("YAML metadata.name {yaml_name:?} does not match target name {target_name:?}"));
    }

    let yaml_namespace = doc.get("metadata").and_then(|m| m.get("namespace")).and_then(|v| v.as_str());
    match (target_namespace, yaml_namespace) {
        (Some(target_ns), Some(yaml_ns)) if target_ns == yaml_ns => Ok(()),
        (Some(target_ns), None) => {
            // Some manifests omit metadata.namespace; treat as matching if a
            // namespace flag will be passed alongside on the kubectl call.
            let _ = target_ns;
            Ok(())
        }
        (Some(target_ns), Some(yaml_ns)) => {
            Err(format!("YAML metadata.namespace {yaml_ns:?} does not match target namespace {target_ns:?}"))
        }
        (None, None) => Ok(()),
        (None, Some(yaml_ns)) => Err(format!("YAML metadata.namespace {yaml_ns:?} set for a cluster-scoped target")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- parse_cpu_millis ---------------------------------------------------

    #[test]
    fn cpu_millicore_suffix() {
        assert_eq!(parse_cpu_millis("250m"), Some(250));
    }

    #[test]
    fn cpu_plain_integer_cores() {
        assert_eq!(parse_cpu_millis("1"), Some(1000));
        assert_eq!(parse_cpu_millis("2"), Some(2000));
    }

    #[test]
    fn cpu_fractional_cores() {
        assert_eq!(parse_cpu_millis("0.5"), Some(500));
    }

    #[test]
    fn cpu_nanocores() {
        assert_eq!(parse_cpu_millis("123456789n"), Some(123));
    }

    #[test]
    fn cpu_microcores() {
        assert_eq!(parse_cpu_millis("1500u"), Some(2));
    }

    #[test]
    fn cpu_invalid_is_none() {
        assert_eq!(parse_cpu_millis(""), None);
        assert_eq!(parse_cpu_millis("abc"), None);
    }

    // --- parse_memory_bytes --------------------------------------------------

    #[test]
    fn memory_binary_suffixes() {
        assert_eq!(parse_memory_bytes("128Mi"), Some(128 * 1024 * 1024));
        assert_eq!(parse_memory_bytes("1Gi"), Some(1024i64.pow(3)));
        assert_eq!(parse_memory_bytes("123456Ki"), Some(123456 * 1024));
    }

    #[test]
    fn memory_decimal_suffixes() {
        assert_eq!(parse_memory_bytes("1G"), Some(1_000_000_000));
        assert_eq!(parse_memory_bytes("500M"), Some(500_000_000));
    }

    #[test]
    fn memory_exponent_notation() {
        assert_eq!(parse_memory_bytes("1e3"), Some(1000));
    }

    #[test]
    fn memory_plain_bytes() {
        assert_eq!(parse_memory_bytes("1024"), Some(1024));
    }

    #[test]
    fn memory_invalid_is_none() {
        assert_eq!(parse_memory_bytes(""), None);
        assert_eq!(parse_memory_bytes("xyz"), None);
    }

    // --- pod_resource_summary --------------------------------------------------

    #[test]
    fn pod_resource_summary_sums_across_containers() {
        let pod = json!({
            "spec": {"containers": [
                {"resources": {"requests": {"cpu": "100m", "memory": "64Mi"}, "limits": {"cpu": "200m", "memory": "128Mi"}}},
                {"resources": {"requests": {"cpu": "50m", "memory": "32Mi"}, "limits": {"cpu": "100m", "memory": "64Mi"}}}
            ]}
        });
        let s = pod_resource_summary(&pod);
        assert_eq!(s.cpu_request_milli, Some(150));
        assert_eq!(s.cpu_limit_milli, Some(300));
        assert_eq!(s.mem_request_bytes, Some(96 * 1024 * 1024));
        assert_eq!(s.mem_limit_bytes, Some(192 * 1024 * 1024));
    }

    #[test]
    fn pod_resource_summary_none_when_unset() {
        let pod = json!({"spec": {"containers": [{"resources": {}}]}});
        let s = pod_resource_summary(&pod);
        assert_eq!(s, PodResourceSummary::default());
    }

    #[test]
    fn pod_resource_summary_partial_containers() {
        // Only one of two containers sets cpu requests -> still summed, not None.
        let pod = json!({
            "spec": {"containers": [
                {"resources": {"requests": {"cpu": "100m"}}},
                {"resources": {}}
            ]}
        });
        let s = pod_resource_summary(&pod);
        assert_eq!(s.cpu_request_milli, Some(100));
        assert_eq!(s.mem_request_bytes, None);
    }

    #[test]
    fn node_allocatable_parses_both() {
        let node = json!({"status": {"allocatable": {"cpu": "2", "memory": "3999000Ki"}}});
        let (cpu, mem) = node_allocatable(&node);
        assert_eq!(cpu, Some(2000));
        assert_eq!(mem, Some(3999000 * 1024));
    }

    // --- ingress flattening --------------------------------------------------

    #[test]
    fn flatten_ingress_rules_basic() {
        let ing = json!({
            "spec": {"rules": [
                {"host": "example.com", "http": {"paths": [
                    {"path": "/", "pathType": "Prefix", "backend": {"service": {"name": "web", "port": {"number": 80}}}}
                ]}}
            ]}
        });
        let rules = flatten_ingress_rules(&ing);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].host.as_deref(), Some("example.com"));
        assert_eq!(rules[0].path, "/");
        assert_eq!(rules[0].backend, "web:80");
    }

    #[test]
    fn flatten_ingress_rules_named_port() {
        let ing = json!({
            "spec": {"rules": [
                {"host": "a.com", "http": {"paths": [
                    {"path": "/api", "backend": {"service": {"name": "api", "port": {"name": "http"}}}}
                ]}}
            ]}
        });
        let rules = flatten_ingress_rules(&ing);
        assert_eq!(rules[0].backend, "api:http");
    }

    #[test]
    fn flatten_ingress_rules_multiple_paths() {
        let ing = json!({
            "spec": {"rules": [
                {"host": "a.com", "http": {"paths": [
                    {"path": "/", "backend": {"service": {"name": "web", "port": {"number": 80}}}},
                    {"path": "/api", "backend": {"service": {"name": "api", "port": {"number": 8080}}}}
                ]}}
            ]}
        });
        let rules = flatten_ingress_rules(&ing);
        assert_eq!(rules.len(), 2);
    }

    #[test]
    fn ingress_hosts_dedup_and_order() {
        let ing = json!({
            "spec": {"rules": [
                {"host": "a.com", "http": {"paths": [{"path": "/", "backend": {"service": {"name": "web", "port": {"number": 80}}}}]}},
                {"host": "a.com", "http": {"paths": [{"path": "/api", "backend": {"service": {"name": "api", "port": {"number": 80}}}}]}},
                {"host": "b.com", "http": {"paths": [{"path": "/", "backend": {"service": {"name": "web2", "port": {"number": 80}}}}]}}
            ]}
        });
        assert_eq!(ingress_hosts(&ing), vec!["a.com".to_string(), "b.com".to_string()]);
    }

    #[test]
    fn ingress_ports_summary_http_only() {
        let ing = json!({"spec": {}});
        assert_eq!(ingress_ports_summary(&ing), "80");
    }

    #[test]
    fn ingress_ports_summary_with_tls() {
        let ing = json!({"spec": {"tls": [{"hosts": ["a.com"]}]}});
        assert_eq!(ingress_ports_summary(&ing), "80, 443");
    }

    // --- secret masking --------------------------------------------------------

    #[test]
    fn mask_secret_yaml_masks_data_values() {
        let yaml = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  password: c2VjcmV0\n  user: YWRtaW4=\n";
        let masked = mask_secret_yaml(yaml);
        assert!(!masked.contains("c2VjcmV0"));
        assert!(!masked.contains("YWRtaW4="));
        assert!(masked.contains("password"));
        assert!(masked.matches(SECRET_MASK).count() == 2);
    }

    #[test]
    fn mask_secret_yaml_masks_string_data() {
        let yaml = "kind: Secret\nstringData:\n  token: plaintext-value\n";
        let masked = mask_secret_yaml(yaml);
        assert!(!masked.contains("plaintext-value"));
    }

    #[test]
    fn mask_secret_yaml_leaves_other_fields() {
        let yaml = "kind: Secret\ntype: Opaque\nmetadata:\n  name: my-secret\n  namespace: default\ndata:\n  key: dmFsdWU=\n";
        let masked = mask_secret_yaml(yaml);
        assert!(masked.contains("my-secret"));
        assert!(masked.contains("Opaque"));
        assert!(masked.contains("default"));
    }

    #[test]
    fn mask_secret_yaml_invalid_yaml_passthrough() {
        let bad = "not: [valid";
        assert_eq!(mask_secret_yaml(bad), bad);
    }

    // --- apply target matching --------------------------------------------------

    fn yaml_doc(s: &str) -> serde_yaml::Value {
        serde_yaml::from_str(s).unwrap()
    }

    #[test]
    fn apply_target_matches_ok() {
        let doc = yaml_doc("kind: ConfigMap\nmetadata:\n  name: cm1\n  namespace: default\n");
        assert!(apply_target_matches(&doc, "configmap", Some("default"), "cm1").is_ok());
    }

    #[test]
    fn apply_target_rejects_wrong_kind() {
        let doc = yaml_doc("kind: Secret\nmetadata:\n  name: cm1\n  namespace: default\n");
        let err = apply_target_matches(&doc, "configmap", Some("default"), "cm1").unwrap_err();
        assert!(err.contains("kind"));
    }

    #[test]
    fn apply_target_rejects_wrong_name() {
        let doc = yaml_doc("kind: ConfigMap\nmetadata:\n  name: other\n  namespace: default\n");
        let err = apply_target_matches(&doc, "configmap", Some("default"), "cm1").unwrap_err();
        assert!(err.contains("name"));
    }

    #[test]
    fn apply_target_rejects_wrong_namespace() {
        let doc = yaml_doc("kind: ConfigMap\nmetadata:\n  name: cm1\n  namespace: other-ns\n");
        let err = apply_target_matches(&doc, "configmap", Some("default"), "cm1").unwrap_err();
        assert!(err.contains("namespace"));
    }

    #[test]
    fn apply_target_allows_missing_namespace_in_yaml() {
        let doc = yaml_doc("kind: ConfigMap\nmetadata:\n  name: cm1\n");
        assert!(apply_target_matches(&doc, "configmap", Some("default"), "cm1").is_ok());
    }
}
