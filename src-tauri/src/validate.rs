//! Input validation shared across commands.

/// Validate a profile name against `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`
/// (§2.7), without pulling in a regex dependency for one pattern.
pub fn is_valid_profile_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 63 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Validate `name`, returning a descriptive `Err` for use directly as a
/// command's error return.
pub fn validate_profile_name(name: &str) -> Result<(), String> {
    if is_valid_profile_name(name) {
        Ok(())
    } else {
        Err(format!("invalid profile name: {name:?}"))
    }
}

/// The kubectl context name for a profile: `"colima"` for `default`, else
/// `"colima-<profile>"` (§2.1).
pub fn kube_context(profile: &str) -> String {
    if profile == "default" {
        "colima".to_string()
    } else {
        format!("colima-{profile}")
    }
}

/// Validate a Kubernetes object/namespace name argument before it's passed to
/// `kubectl`: non-empty and not starting with `-` (which would otherwise be
/// interpreted as a flag, i.e. flag injection). This is intentionally looser
/// than full Kubernetes DNS-subdomain validation — kubectl itself rejects
/// malformed names — but it closes the specific "leading dash" injection
/// vector for any argument (kind/namespace/name) that reaches an argv slot
/// (§6.6).
pub fn validate_k8s_arg(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if value.starts_with('-') {
        return Err(format!("{label} must not start with '-': {value:?}"));
    }
    Ok(())
}

#[cfg(test)]
mod k8s_arg_tests {
    use super::*;

    #[test]
    fn accepts_normal_names() {
        assert!(validate_k8s_arg("name", "my-pod").is_ok());
        assert!(validate_k8s_arg("namespace", "kube-system").is_ok());
    }

    #[test]
    fn rejects_empty() {
        assert!(validate_k8s_arg("name", "").is_err());
    }

    #[test]
    fn rejects_leading_dash() {
        assert!(validate_k8s_arg("name", "-o=json").is_err());
        assert!(validate_k8s_arg("namespace", "--kubeconfig=/tmp/x").is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_names() {
        assert!(is_valid_profile_name("default"));
        assert!(is_valid_profile_name("rosetta"));
        assert!(is_valid_profile_name("a"));
        assert!(is_valid_profile_name("my-profile_1.2"));
        assert!(is_valid_profile_name(&"a".repeat(63)));
    }

    #[test]
    fn rejects_invalid_names() {
        assert!(!is_valid_profile_name(""));
        assert!(!is_valid_profile_name("-leading-dash"));
        assert!(!is_valid_profile_name(".leading-dot"));
        assert!(!is_valid_profile_name("_leading-underscore"));
        assert!(!is_valid_profile_name("has space"));
        assert!(!is_valid_profile_name("has/slash"));
        assert!(!is_valid_profile_name("has;semicolon"));
        assert!(!is_valid_profile_name(&"a".repeat(64)));
        assert!(!is_valid_profile_name("$(rm -rf /)"));
    }

    #[test]
    fn kube_context_naming() {
        assert_eq!(kube_context("default"), "colima");
        assert_eq!(kube_context("rosetta"), "colima-rosetta");
        assert_eq!(kube_context("my-profile"), "colima-my-profile");
    }
}
