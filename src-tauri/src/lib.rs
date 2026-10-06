//! Colima Desktop backend: a Tauri v2 app that shells out to `colima`,
//! `docker`, and `kubectl` to give a GUI over Colima machines, containers,
//! images, volumes, and Kubernetes workloads. See `docs/SPEC.md` at the
//! project root for the full contract this crate implements.

mod colima;
mod compose;
mod config_file;
mod deps;
mod disk;
mod docker;
mod env;
mod exec;
mod k3s;
mod k8s;
mod kubeconfig;
mod logs;
mod marketplace;
mod pty;
mod quantity;
mod state;
mod terminal;
mod tray;
mod validate;

use state::AppState;
use tauri::{Manager, RunEvent, WindowEvent};

/// Build and run the Tauri application. Fixes `PATH` first (§2.3), before
/// anything spawns a subprocess.
pub fn run() {
    env::fix_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            env::env_info,
            deps::deps_check,
            deps::deps_fix,
            colima::list_profiles,
            colima::profile_status,
            colima::profile_config,
            colima::start_profile,
            colima::stop_profile,
            colima::restart_profile,
            colima::delete_profile,
            colima::kubernetes_action,
            colima::busy_profiles,
            disk::profile_disk_info,
            disk::recreate_profile,
            disk::reclaim_space,
            config_file::profile_config_raw,
            config_file::save_profile_config_raw,
            config_file::validate_profile_config_raw,
            k3s::k3s_versions,
            docker::list_containers,
            docker::container_action,
            docker::container_inspect,
            docker::container_stats,
            docker::run_container,
            docker::list_images,
            docker::remove_image,
            docker::pull_image,
            docker::list_volumes,
            docker::remove_volume,
            docker::prune,
            compose::compose_info,
            compose::compose_projects,
            compose::compose_preview,
            compose::compose_up,
            compose::compose_action,
            marketplace::marketplace_catalog,
            marketplace::marketplace_prepare,
            marketplace::marketplace_preflight,
            marketplace::marketplace_fix_preflight,
            marketplace::marketplace_install,
            marketplace::marketplace_installed,
            marketplace::marketplace_uninstall,
            k8s::k8s_namespaces,
            k8s::k8s_pods,
            k8s::k8s_deployments,
            k8s::k8s_services,
            k8s::k8s_nodes,
            k8s::k8s_describe,
            k8s::k8s_delete_pod,
            k8s::k8s_scale,
            k8s::k8s_restart_deployment,
            k8s::k8s_yaml,
            k8s::k8s_configmaps,
            k8s::k8s_secrets,
            k8s::k8s_secret_value,
            k8s::k8s_ingresses,
            k8s::k8s_delete,
            k8s::k8s_edit_yaml,
            k8s::k8s_apply_yaml,
            k8s::k8s_pod_metrics,
            k8s::k8s_node_metrics,
            kubeconfig::host_kubeconfig_health,
            kubeconfig::repair_host_kubeconfig,
            kubeconfig::k8s_kubeconfig,
            kubeconfig::k8s_export_kubeconfig,
            kubeconfig::k8s_merge_kubeconfig,
            logs::start_log_stream,
            logs::stop_log_stream,
            pty::terminal_open,
            pty::terminal_write,
            pty::terminal_resize,
            pty::terminal_close,
        ])
        .setup(|app| {
            tray::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window hides it instead of quitting; the app
            // keeps running in the tray (§5).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application")
        .run(|app_handle, event| {
            match event {
                // macOS: clicking the dock icon re-shows the window.
                #[cfg(target_os = "macos")]
                RunEvent::Reopen { .. } => {
                    tray::show_main_window(app_handle);
                }
                RunEvent::Exit => {
                    let state = app_handle.state::<AppState>();
                    logs::kill_all(&state);
                    pty::kill_all(&state);
                }
                _ => {}
            }
        });
}
