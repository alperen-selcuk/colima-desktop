//! Dependency doctor (§6.9): detect the CLIs Colima Desktop relies on and,
//! on macOS with Homebrew, offer one-click fixes (`brew install` / `brew link`).

use crate::{env::find_in_path, exec};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepFix {
    pub label: String,
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dep {
    pub name: String,
    pub required: bool,
    pub installed: bool,
    /// `Some(false)` when Homebrew has the formula but the binary isn't on PATH.
    pub linked: Option<bool>,
    pub version: Option<String>,
    pub purpose: String,
    pub fix: Option<DepFix>,
}

struct Spec {
    name: &'static str,
    bin: &'static str,
    formula: &'static str,
    required: bool,
    purpose: &'static str,
    linux_hint: &'static str,
}

const SPECS: &[Spec] = &[
    Spec {
        name: "colima",
        bin: "colima",
        formula: "colima",
        required: true,
        purpose: "The container runtime manager this app drives.",
        linux_hint: "Download colima from https://github.com/abiosoft/colima/releases and put it on your PATH.",
    },
    Spec {
        name: "docker",
        bin: "docker",
        formula: "docker",
        required: true,
        purpose: "Docker CLI, used for containers, images and volumes.",
        linux_hint: "Install your distribution's docker CLI package (e.g. docker-ce-cli or docker.io).",
    },
    Spec {
        name: "docker-compose",
        bin: "docker-compose",
        formula: "docker-compose",
        required: true,
        purpose: "Needed for Compose projects and the Marketplace.",
        linux_hint: "Install the docker-compose-plugin package from your distribution or Docker's repository.",
    },
    Spec {
        name: "kubectl",
        bin: "kubectl",
        formula: "kubernetes-cli",
        required: true,
        purpose: "Needed for Kubernetes.",
        linux_hint: "Install kubectl from https://kubernetes.io/docs/tasks/tools/ or your package manager.",
    },
    Spec {
        name: "qemu",
        bin: "qemu-img",
        formula: "qemu",
        required: false,
        purpose: "Optional: only needed for VM type qemu, or x86_64 emulation without Rosetta.",
        linux_hint: "Install qemu from your distribution (e.g. qemu-system and qemu-utils); only needed for VM type qemu.",
    },
];

/// Pure decision for one dependency. `on_path`: binary found (or compose
/// plugin works); `brew`: `None` when not on macOS / no Homebrew, else
/// whether Homebrew has the formula installed.
fn evaluate(spec: &Spec, on_path: bool, macos: bool, brew_present: bool, brew_has: bool) -> Dep {
    let mut dep = Dep {
        name: spec.name.to_string(),
        required: spec.required,
        installed: on_path,
        linked: None,
        version: None,
        purpose: spec.purpose.to_string(),
        fix: None,
    };
    let brew_cmd = |verb: &str, label: String| DepFix {
        label,
        command: vec!["brew".into(), verb.into(), spec.formula.into()],
    };
    if !macos {
        if !on_path {
            dep.purpose = format!("{} {}", spec.purpose, spec.linux_hint);
        }
        return dep;
    }
    if on_path {
        if brew_has {
            dep.linked = Some(true);
        }
        return dep;
    }
    if brew_has {
        dep.installed = true;
        dep.linked = Some(false);
        dep.fix = Some(brew_cmd("link", format!("Link {}", spec.name)));
    } else if brew_present {
        dep.fix = Some(brew_cmd("install", format!("Install {}", spec.name)));
    } else {
        dep.purpose = format!("{} Homebrew was not found; install it from https://brew.sh first.", spec.purpose);
    }
    dep
}

fn first_line(s: &str) -> Option<String> {
    s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

async fn version_of(name: &str) -> Option<String> {
    let out = match name {
        "colima" => exec::run("colima", &["version"]).await,
        "docker" => exec::run("docker", &["--version"]).await,
        "docker-compose" => match exec::run("docker-compose", &["version", "--short"]).await {
            Ok(v) => Ok(v),
            Err(_) => exec::run("docker", &["compose", "version", "--short"]).await,
        },
        "kubectl" => exec::run("kubectl", &["version", "--client"]).await,
        "qemu" => exec::run("qemu-img", &["--version"]).await,
        _ => return None,
    };
    out.ok().and_then(|o| first_line(&o))
}

async fn check() -> Vec<Dep> {
    let macos = cfg!(target_os = "macos");
    let (brew_present, brewed) = if macos {
        match exec::run("brew", &["list", "--formula", "-1"]).await {
            Ok(list) => (true, list.lines().map(|l| l.trim().to_string()).collect::<Vec<_>>()),
            Err(_) => (exec::run("brew", &["--prefix"]).await.is_ok(), Vec::new()),
        }
    } else {
        (false, Vec::new())
    };
    let mut out = Vec::new();
    for spec in SPECS {
        let mut on_path = find_in_path(spec.bin).is_some();
        if !on_path && spec.name == "docker-compose" {
            on_path = exec::run("docker", &["compose", "version"]).await.is_ok();
        }
        let brew_has = brewed.iter().any(|f| f == spec.formula);
        let mut dep = evaluate(spec, on_path, macos, brew_present, brew_has);
        if on_path {
            dep.version = version_of(spec.name).await;
        }
        out.push(dep);
    }
    out
}

#[tauri::command]
pub async fn deps_check() -> Vec<Dep> {
    check().await
}

/// Run the fix for `name`, streamed as op `deps`, then re-check. Only the
/// commands produced by [`check`] can run; `name` is just a lookup key.
#[tauri::command]
pub async fn deps_fix(app: AppHandle, name: String) -> Result<Vec<Dep>, String> {
    let deps = check().await;
    let fix = deps
        .iter()
        .find(|d| d.name == name)
        .ok_or_else(|| format!("unknown dependency: {name}"))?
        .fix
        .clone()
        .ok_or_else(|| format!("no automatic fix available for {name}"))?;
    let (bin, args) = fix.command.split_first().ok_or("empty fix command")?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run_streaming(&app, bin, &args, "", "deps").await?;
    // PATH holds directories (Homebrew's bin is already included), so nothing to refresh.
    Ok(check().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> &'static Spec {
        SPECS.iter().find(|s| s.name == name).unwrap()
    }

    #[test]
    fn on_path_needs_no_fix() {
        let d = evaluate(spec("docker"), true, true, true, true);
        assert!(d.installed && d.fix.is_none());
        assert_eq!(d.linked, Some(true));
    }

    #[test]
    fn unlinked_brew_formula_gets_link_fix() {
        let d = evaluate(spec("docker"), false, true, true, true);
        assert!(d.installed);
        assert_eq!(d.linked, Some(false));
        assert_eq!(d.fix.unwrap().command, vec!["brew", "link", "docker"]);
    }

    #[test]
    fn missing_gets_install_fix_with_formula_name() {
        let d = evaluate(spec("kubectl"), false, true, true, false);
        assert!(!d.installed && d.linked.is_none());
        assert_eq!(d.fix.unwrap().command, vec!["brew", "install", "kubernetes-cli"]);
        let q = evaluate(spec("qemu"), false, true, true, false);
        assert_eq!(q.fix.unwrap().command, vec!["brew", "install", "qemu"]);
        assert!(!q.required);
    }

    #[test]
    fn no_homebrew_or_linux_has_no_fix() {
        let d = evaluate(spec("colima"), false, true, false, false);
        assert!(d.fix.is_none() && d.purpose.contains("brew.sh"));
        let l = evaluate(spec("colima"), false, false, false, false);
        assert!(l.fix.is_none() && l.purpose.contains("github.com/abiosoft/colima"));
    }
}
