use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// Apply the persisted launch-at-login setting without treating an already-matching
/// OS state as an error. On Windows, disabling a missing autostart entry can
/// return "file not found"; querying first keeps startup idempotent.
pub(crate) fn sync_launch_at_login(app: &AppHandle, enabled: bool, log_prefix: &str) {
    let autostart = app.autolaunch();

    match autostart.is_enabled() {
        Ok(current) if current == enabled => return,
        Ok(_) => {}
        Err(err) => {
            log::warn!("{log_prefix} failed to query launch-at-login state: {err}");
            if !enabled {
                return;
            }
        }
    }

    let result = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };

    if let Err(err) = result {
        log::warn!("{log_prefix} failed to apply launch-at-login={enabled}: {err}");
    }
}
