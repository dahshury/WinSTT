use tauri::WebviewWindow;

pub(crate) fn label_in(caller: &str, allowed: &[&str]) -> bool {
    allowed.contains(&caller)
}

pub(crate) fn authorize_webview(
    caller: &WebviewWindow,
    scope: &str,
    action: &str,
    allowed: &[&str],
    suffix: &str,
) -> Result<(), String> {
    authorize_label(caller.label(), scope, action, allowed, suffix)
}

pub(crate) fn authorize_label(
    caller_label: &str,
    scope: &str,
    action: &str,
    allowed: &[&str],
    suffix: &str,
) -> Result<(), String> {
    if label_in(caller_label, allowed) {
        return Ok(());
    }

    log::warn!("[{scope}] blocked {action}: caller='{caller_label}' is not allowed");
    Err(format!("window '{caller_label}' may not {action}{suffix}"))
}

#[cfg(test)]
pub(crate) fn assert_label_rules(
    allowed: &[&str],
    blocked: &[&str],
    mut is_allowed: impl FnMut(&str) -> bool,
) {
    for caller in allowed {
        assert!(is_allowed(caller), "{caller} should be allowed");
    }
    for caller in blocked {
        assert!(!is_allowed(caller), "{caller} should be blocked");
    }
}
