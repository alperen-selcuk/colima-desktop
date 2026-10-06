//! VM disk inspection and the commands built on it (§6.4 "disk" rules):
//! `profile_disk_info`, `recreate_profile` (the only way to get a smaller
//! disk, since Lima/colima cannot shrink one) and `reclaim_space`.
//!
//! The disk file is `<colimaHome>/_lima/<instanceId>/diffdisk`; its apparent
//! size is the real VM disk size, its allocated blocks are what it actually
//! occupies on the host.

use crate::colima::{colima_home, resolve_docker_socket};
use crate::exec;
use crate::state::AppState;
use crate::validate::validate_profile_name;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Generic message for `colima start` failing at the "starting" stage.
pub const START_FAILED_GENERIC: &str = "The VM failed to start. If you reduced the disk size, VM disks can't be shrunk — restore the previous size or recreate the machine.";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub exists: bool,
    pub size_gib: Option<f64>,
    pub used_on_host_bytes: Option<u64>,
}

/// Lima instance id for a colima profile: `colima` for `default`, else
/// `colima-<profile>`.
pub fn instance_id(profile: &str) -> String {
    if profile == "default" {
        "colima".to_string()
    } else {
        format!("colima-{profile}")
    }
}

pub fn diskfile_path_at(home: &Path, profile: &str) -> PathBuf {
    home.join("_lima").join(instance_id(profile)).join("diffdisk")
}

/// Round to 2 decimals so e.g. 42949672960 bytes is exactly 40.
fn bytes_to_gib(bytes: u64) -> f64 {
    ((bytes as f64 / GIB) * 100.0).round() / 100.0
}

#[cfg(unix)]
fn allocated_bytes(meta: &std::fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.blocks() * 512)
}

#[cfg(not(unix))]
fn allocated_bytes(_meta: &std::fs::Metadata) -> Option<u64> {
    None
}

/// Inspect the disk file at `path` (missing file => `exists: false`).
pub fn disk_info_at(path: &Path) -> DiskInfo {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => DiskInfo {
            exists: true,
            size_gib: Some(bytes_to_gib(meta.len())),
            used_on_host_bytes: allocated_bytes(&meta),
        },
        _ => DiskInfo {
            exists: false,
            size_gib: None,
            used_on_host_bytes: None,
        },
    }
}

/// Whether `configured` GiB is smaller than the existing disk (with a small
/// tolerance for the 2-decimal rounding of the current size).
pub fn is_shrink(configured: f64, current: Option<f64>) -> bool {
    match current {
        Some(cur) => configured + 0.01 < cur,
        None => false,
    }
}

/// `disk:` from a colima.yaml text (colima's default of 100 when absent).
pub fn configured_disk_gib(content: &str) -> Option<f64> {
    let value: serde_yaml::Value = serde_yaml::from_str(content).ok()?;
    match value.as_mapping()?.get("disk") {
        None | Some(serde_yaml::Value::Null) => Some(100.0),
        Some(v) => v.as_f64(),
    }
}

pub fn shrink_start_message(current_gib: f64, configured_gib: f64) -> String {
    format!(
        "The VM failed to start because the configured disk ({configured_gib} GiB) is smaller than the existing VM disk ({current_gib} GiB). VM disks can't be shrunk: restore the disk size to at least {current_gib} GiB, or recreate the machine to use a smaller disk."
    )
}

/// Refine the generic start failure message using the profile's config and
/// disk file; leaves any other message untouched.
pub fn refine_start_error(msg: String, profile: &str) -> String {
    if msg != START_FAILED_GENERIC {
        return msg;
    }
    let home = colima_home();
    let current = disk_info_at(&diskfile_path_at(&home, profile)).size_gib;
    let configured = std::fs::read_to_string(home.join(profile).join("colima.yaml"))
        .ok()
        .and_then(|c| configured_disk_gib(&c));
    match (configured, current) {
        (Some(conf), Some(cur)) if is_shrink(conf, Some(cur)) => shrink_start_message(cur, conf),
        _ => msg,
    }
}

#[tauri::command]
pub async fn profile_disk_info(profile: String) -> Result<DiskInfo, String> {
    validate_profile_name(&profile)?;
    Ok(disk_info_at(&diskfile_path_at(&colima_home(), &profile)))
}

fn invalidate_caches(state: &AppState, profile: &str) {
    state.invalidate_docker_socket(profile);
    state.kubeconfig.invalidate(profile);
    state.invalidate_compose_info(profile);
}

/// Delete the machine and recreate it from `config_content` (the way to get a
/// smaller disk). Order: validate, stop (failures ignored; `delete -f`
/// follows), `colima delete -f` (which also removes the profile's
/// colima.yaml), atomic config write, plain `colima start -p`.
#[tauri::command]
pub async fn recreate_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
    config_content: String,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    crate::config_file::validate_config_content(&config_content)?;
    let _guard = state.try_lock_profile(&profile)?;
    invalidate_caches(&state, &profile);

    let op = "recreate";
    let _ = exec::run_streaming(&app, "colima", &["stop", "-p", &profile], &profile, op).await;
    let result = async {
        exec::run_streaming(&app, "colima", &["delete", "-f", "-p", &profile], &profile, op).await?;
        crate::config_file::save_profile_config_raw_at(&colima_home(), &profile, &config_content)?;
        exec::run_streaming(&app, "colima", &["start", "-p", &profile], &profile, op).await
    }
    .await;

    invalidate_caches(&state, &profile);
    let _ = app.emit("profiles-changed", ());
    result
}

/// `docker system prune -af` (never volumes) then a best-effort `fstrim`
/// inside the VM. The frontend compares `profile_disk_info` before/after.
#[tauri::command]
pub async fn reclaim_space(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: String,
) -> Result<(), String> {
    validate_profile_name(&profile)?;
    let running = exec::run("colima", &["status", "--json", "-p", &profile]).await.is_ok();
    if !running {
        return Err(format!("{profile} is not running — start it first"));
    }
    let _guard = state.try_lock_profile(&profile)?;
    let op = "reclaim";
    let socket = resolve_docker_socket(&state, &profile).await;
    exec::run_streaming(&app, "docker", &["-H", &socket, "system", "prune", "-af"], &profile, op).await?;
    let _ = exec::run_streaming(
        &app,
        "colima",
        &["ssh", "-p", &profile, "--", "sudo", "fstrim", "-av"],
        &profile,
        op,
    )
    .await;
    let _ = app.emit("profiles-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colima-desktop-disk-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn instance_ids() {
        assert_eq!(instance_id("default"), "colima");
        assert_eq!(instance_id("work"), "colima-work");
    }

    #[test]
    fn diskfile_path() {
        assert_eq!(
            diskfile_path_at(Path::new("/h/.colima"), "work"),
            PathBuf::from("/h/.colima/_lima/colima-work/diffdisk")
        );
    }

    #[test]
    fn missing_disk_file() {
        let d = temp_dir("missing");
        let info = disk_info_at(&diskfile_path_at(&d, "default"));
        assert_eq!(info, DiskInfo { exists: false, size_gib: None, used_on_host_bytes: None });
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sparse_disk_file_reports_apparent_and_allocated() {
        let d = temp_dir("sparse");
        let path = diskfile_path_at(&d, "default");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(40 * 1024 * 1024 * 1024).unwrap();
        let info = disk_info_at(&path);
        assert!(info.exists);
        assert_eq!(info.size_gib, Some(40.0));
        #[cfg(unix)]
        assert!(info.used_on_host_bytes.unwrap() < 1024 * 1024 * 1024);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn shrink_detection() {
        assert!(is_shrink(10.0, Some(40.0)));
        assert!(!is_shrink(40.0, Some(40.0)));
        assert!(!is_shrink(50.0, Some(40.0)));
        assert!(!is_shrink(10.0, None));
    }

    #[test]
    fn configured_disk_parsing() {
        assert_eq!(configured_disk_gib("disk: 10\n"), Some(10.0));
        assert_eq!(configured_disk_gib("cpu: 2\n"), Some(100.0));
        assert_eq!(configured_disk_gib("disk: abc\n"), None);
    }

    #[test]
    fn shrink_message_mentions_sizes() {
        let m = shrink_start_message(40.0, 10.0);
        assert!(m.contains("10 GiB") && m.contains("40 GiB") && m.contains("recreate"));
    }

    #[test]
    fn refine_leaves_other_messages() {
        assert_eq!(refine_start_error("boom".into(), "default"), "boom");
    }
}
