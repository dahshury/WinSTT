use super::WindowContextSnapshot;

struct AppPolicyProbe {
    app_exe: String,
    host: String,
}

fn build_app_policy_probe(snapshot: &WindowContextSnapshot) -> AppPolicyProbe {
    let app_exe = snapshot.app_exe.as_deref().unwrap_or("").to_lowercase();
    let url = snapshot.url.as_deref().unwrap_or("").to_lowercase();
    AppPolicyProbe {
        app_exe,
        host: extract_host(&url),
    }
}

fn normalise_app_pattern(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    lower.strip_prefix("*.").unwrap_or(&lower).to_string()
}

fn matches_app_exe_pattern(pattern: &str, app_exe: &str) -> bool {
    pattern.ends_with(".exe") && app_exe == pattern
}

fn matches_host_pattern(pattern: &str, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    host == pattern || host.ends_with(&format!(".{pattern}"))
}

fn app_pattern_matches_probe(raw: &str, probe: &AppPolicyProbe) -> bool {
    let pattern = normalise_app_pattern(raw);
    if pattern.is_empty() {
        return false;
    }
    matches_app_exe_pattern(&pattern, &probe.app_exe) || matches_host_pattern(&pattern, &probe.host)
}

/// True when the snapshot's app/url matches any deny-list pattern. A pattern is
/// either an exe name or a URL host suffix, with optional leading `*.`.
pub fn is_denied_by_list(snapshot: &WindowContextSnapshot, deny_list: &[String]) -> bool {
    if deny_list.is_empty() {
        return false;
    }
    let probe = build_app_policy_probe(snapshot);
    deny_list
        .iter()
        .any(|raw| app_pattern_matches_probe(raw, &probe))
}

/// True when the snapshot's app/url matches any selected-only allow-list entry.
/// Uses the same executable/host pattern semantics as the deny-list.
pub fn is_allowed_by_list(snapshot: &WindowContextSnapshot, allow_list: &[String]) -> bool {
    if allow_list.is_empty() {
        return false;
    }
    let probe = build_app_policy_probe(snapshot);
    allow_list
        .iter()
        .any(|raw| app_pattern_matches_probe(raw, &probe))
}

/// Strip rich fields from a denied snapshot, keeping harmless metadata only.
pub fn redact_sensitive_fields(snapshot: &WindowContextSnapshot) -> WindowContextSnapshot {
    WindowContextSnapshot {
        window_title: snapshot.window_title.clone(),
        element_name: snapshot.element_name.clone(),
        focused_text: String::new(),
        ..Default::default()
    }
}

/// Pull the host out of a URL string without a full URL parser. UIA omnibox
/// values sometimes lack a scheme, so this accepts both host/path and URL forms.
pub(super) fn extract_host(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    let no_scheme = match url.find("://") {
        Some(i) => &url[i + 3..],
        None => url,
    };
    let host_part = match no_scheme.find('/') {
        Some(i) => &no_scheme[..i],
        None => no_scheme,
    };
    host_part
        .split('?')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .to_string()
}
