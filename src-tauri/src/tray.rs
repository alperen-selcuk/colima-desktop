//! System tray icon and menu (§5). The menu is rebuilt every 5s by a
//! background task and again after `profiles-changed`, so profile status
//! lines and the enabled state of Start/Stop always reflect reality without
//! the frontend having to drive it.

use crate::colima;
use crate::state::AppState;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager, Wry};

const MANAGED_PROFILE: &str = "default";

/// Fetch the status line for the tray's managed profile (`default`):
/// `"Running"` / `"Stopped"` / etc, or `"unknown"` if `colima list` fails.
async fn managed_profile_status() -> String {
    match colima::list_profiles().await {
        Ok(profiles) => profiles
            .into_iter()
            .find(|p| p.name == MANAGED_PROFILE)
            .map(|p| p.status)
            .unwrap_or_else(|| "not found".to_string()),
        Err(_) => "unknown".to_string(),
    }
}

/// (Re)build the tray menu to reflect the current status of the `default`
/// profile.
async fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let status = managed_profile_status().await;
    let is_running = status.eq_ignore_ascii_case("running");

    let header = MenuItem::with_id(app, "header", "Colima Desktop", false, None::<&str>)?;
    let status_line = MenuItem::with_id(
        app,
        "status",
        format!("{} {} — {}", if is_running { "●" } else { "○" }, MANAGED_PROFILE, status),
        false,
        None::<&str>,
    )?;
    let start_item = MenuItem::with_id(app, "start-default", "Start default", !is_running, None::<&str>)?;
    let stop_item = MenuItem::with_id(app, "stop-default", "Stop default", is_running, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let open_dashboard = MenuItem::with_id(app, "open-dashboard", "Open Dashboard", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &header,
            &status_line,
            &start_item,
            &stop_item,
            &separator,
            &open_dashboard,
            &quit_item,
        ],
    )
}

/// Show and focus the main window (used by "Open Dashboard" and macOS dock
/// reactivation).
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

async fn run_lifecycle_op(app: AppHandle, action: &str) {
    let state = app.state::<AppState>();
    let profile = MANAGED_PROFILE.to_string();
    // Errors are surfaced via the streamed colima-op-log lines already; the
    // tray menu has no dialog surface of its own, so the result is only
    // used to decide whether the docker socket cache needs invalidating.
    let _result = match action {
        "start" => match state.try_lock_profile(&profile) {
            Ok(_guard) => {
                state.invalidate_docker_socket(&profile);
                let args = ["start", "-p", profile.as_str()];
                crate::exec::run_streaming(&app, "colima", &args, &profile, "start").await
            }
            Err(e) => Err(e),
        },
        "stop" => match state.try_lock_profile(&profile) {
            Ok(_guard) => {
                let args = ["stop", "-p", profile.as_str()];
                crate::exec::run_streaming(&app, "colima", &args, &profile, "stop").await
            }
            Err(e) => Err(e),
        },
        _ => Ok(()),
    };
    state.invalidate_docker_socket(&profile);
    let _ = app.emit("profiles-changed", ());
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open-dashboard" => show_main_window(app),
        "quit" => {
            let state = app.state::<AppState>();
            crate::logs::kill_all(&state);
            app.exit(0);
        }
        "start-default" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { run_lifecycle_op(app, "start").await });
        }
        "stop-default" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { run_lifecycle_op(app, "stop").await });
        }
        _ => {}
    }
}

/// Rebuild and apply the tray menu.
async fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_menu(app).await {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// Create the tray icon, wire up menu events, and start the 5s background
/// refresh loop.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let icon = tray_image(app)?;

    let initial_menu = tauri::async_runtime::block_on(build_menu(app))?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&initial_menu)
        .on_menu_event(handle_menu_event)
        .build(app)?;

    // Background refresh every 5s.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            refresh(&app_handle).await;
        }
    });

    // Refresh once more on `profiles-changed`.
    let app_handle = app.clone();
    app.listen("profiles-changed", move |_event| {
        let app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            refresh(&app_handle).await;
        });
    });

    Ok(())
}

fn tray_image(app: &AppHandle) -> tauri::Result<tauri::image::Image<'static>> {
    // Colored icon on Linux, template (monochrome) icon on macOS — both
    // ship as icons/tray.png; `icon_as_template` (set in `setup`) tells
    // macOS to treat it as a template image (recolored to match menu bar
    // appearance) rather than displaying it verbatim.
    let _ = app;
    let bytes = include_bytes!("../icons/tray.png");
    tauri::image::Image::from_bytes(bytes)
}
