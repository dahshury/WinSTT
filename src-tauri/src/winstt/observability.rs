use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

const MAX_ISSUES: usize = 200;

static ISSUES: OnceLock<Mutex<VecDeque<ObservabilityIssue>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityIssue {
    pub id: u64,
    pub timestamp_ms: u64,
    pub severity: String,
    pub area: String,
    pub operation: String,
    pub kind: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
    pub user_visible: bool,
    #[serde(default)]
    pub context: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct IssueBuilder {
    area: String,
    operation: String,
    summary: String,
    detail: Option<String>,
    kind: Option<String>,
    severity: Option<String>,
    model_id: Option<String>,
    provider: Option<String>,
    request_id: Option<String>,
    duration_ms: Option<u64>,
    remediation: Option<String>,
    user_visible: bool,
    context: BTreeMap<String, String>,
}

impl IssueBuilder {
    pub fn new(
        area: impl Into<String>,
        operation: impl Into<String>,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            area: area.into(),
            operation: operation.into(),
            summary: summary.into(),
            detail: None,
            kind: None,
            severity: None,
            model_id: None,
            provider: None,
            request_id: None,
            duration_ms: None,
            remediation: None,
            user_visible: true,
            context: BTreeMap::new(),
        }
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn maybe_detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }

    pub fn kind(mut self, kind: impl Into<String>) -> Self {
        self.kind = Some(kind.into());
        self
    }

    pub fn severity(mut self, severity: impl Into<String>) -> Self {
        self.severity = Some(severity.into());
        self
    }

    pub fn model_id(mut self, model_id: impl Into<String>) -> Self {
        self.model_id = Some(model_id.into());
        self
    }

    pub fn provider(mut self, provider: impl Into<String>) -> Self {
        self.provider = Some(provider.into());
        self
    }

    pub fn request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }

    pub fn duration_ms(mut self, duration_ms: u64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    pub fn remediation(mut self, remediation: impl Into<String>) -> Self {
        self.remediation = Some(remediation.into());
        self
    }

    pub fn user_visible(mut self, user_visible: bool) -> Self {
        self.user_visible = user_visible;
        self
    }

    pub fn context(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.context.insert(key.into(), value.into());
        self
    }

    pub fn record(self, app: Option<&AppHandle>) -> ObservabilityIssue {
        record_issue(app, self)
    }
}

pub fn classify_error_kind(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("panic") || lower.contains("panicked") {
        return "panic";
    }
    if lower.contains("out of memory")
        || lower.contains("oom")
        || lower.contains("allocation")
        || lower.contains("failed to allocate")
        || lower.contains("cuda_error_out_of_memory")
        || lower.contains("directml") && (lower.contains("memory") || lower.contains("resource"))
    {
        return "out_of_memory";
    }
    if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("deadline")
        || lower.contains("elapsed")
    {
        return "timeout";
    }
    if lower.contains("rate limit")
        || lower.contains("rate limited")
        || lower.contains("too many requests")
        || lower.contains("429")
    {
        return "rate_limited";
    }
    if lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("invalid api key")
        || lower.contains("authentication")
        || lower.contains("401")
        || lower.contains("403")
    {
        return "auth";
    }
    if lower.contains("no api key")
        || lower.contains("api key is empty")
        || lower.contains("not configured")
    {
        return "key_missing";
    }
    if lower.contains("disk full")
        || lower.contains("not enough space")
        || lower.contains("no space left")
    {
        return "disk_full";
    }
    if lower.contains("permission denied")
        || lower.contains("access is denied")
        || lower.contains("unauthorizedaccess")
    {
        return "permission_denied";
    }
    if lower.contains("not found")
        || lower.contains("404")
        || lower.contains("missing")
        || lower.contains("unknown model")
    {
        return "not_found";
    }
    if lower.contains("corrupt")
        || lower.contains("checksum")
        || lower.contains("hash")
        || lower.contains("invalid model")
        || lower.contains("failed cache self-check")
    {
        return "model_corrupt";
    }
    if lower.contains("dns")
        || lower.contains("connection refused")
        || lower.contains("econnrefused")
        || lower.contains("enotfound")
        || lower.contains("network")
        || lower.contains("tcp connect")
        || lower.contains("error sending request")
        || lower.contains("fetch failed")
    {
        return "network";
    }
    if lower.contains("cancelled") || lower.contains("canceled") || lower.contains("aborted") {
        return "cancelled";
    }
    "unknown"
}

pub fn remediation_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "out_of_memory" => Some(
            "Choose a smaller or quantized model, switch to CPU, close other GPU-heavy apps, or free RAM/VRAM before retrying.",
        ),
        "timeout" => Some(
            "Retry with a shorter input, smaller model, or more responsive provider. Check the model/provider health if this repeats.",
        ),
        "network" => Some(
            "Check the internet connection, proxy/VPN/firewall, and provider availability, then retry.",
        ),
        "auth" => Some("Verify the configured API key and provider permissions."),
        "key_missing" => Some("Add a valid API key for the selected cloud provider."),
        "rate_limited" => Some("Wait for the provider quota window to reset or switch providers/models."),
        "disk_full" => Some("Free disk space and retry the download or model operation."),
        "permission_denied" => Some(
            "Check file permissions, antivirus quarantine, and whether the app can access its data folder.",
        ),
        "model_corrupt" => Some("Delete the affected model cache and download the model again."),
        "not_found" => Some("Confirm the model id, selected quantization, and whether the model is available."),
        "panic" => Some("Restart WinSTT. Save a diagnostic bundle if the issue repeats."),
        _ => None,
    }
}

pub fn recent_issues(limit: Option<usize>) -> Vec<ObservabilityIssue> {
    let limit = limit.unwrap_or(MAX_ISSUES).min(MAX_ISSUES);
    let Ok(issues) = issue_store().lock() else {
        return Vec::new();
    };
    issues.iter().rev().take(limit).cloned().collect()
}

fn issue_store() -> &'static Mutex<VecDeque<ObservabilityIssue>> {
    ISSUES.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_ISSUES)))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn severity_for_kind(kind: &str) -> &'static str {
    match kind {
        "panic" | "out_of_memory" | "disk_full" | "permission_denied" | "model_corrupt" => "error",
        "timeout" | "network" | "auth" | "key_missing" | "rate_limited" | "not_found" => "warn",
        "cancelled" => "info",
        _ => "warn",
    }
}

fn log_issue(issue: &ObservabilityIssue) {
    let fields = serde_json::json!({
        "id": issue.id,
        "area": issue.area,
        "operation": issue.operation,
        "kind": issue.kind,
        "modelId": issue.model_id,
        "provider": issue.provider,
        "requestId": issue.request_id,
        "durationMs": issue.duration_ms,
        "context": issue.context,
    });
    match issue.severity.as_str() {
        "error" => log::error!(
            "[observability] issue={} summary=\"{}\" detail={} fields={}",
            issue.id,
            issue.summary,
            issue.detail.as_deref().unwrap_or(""),
            fields
        ),
        "warn" => log::warn!(
            "[observability] issue={} summary=\"{}\" detail={} fields={}",
            issue.id,
            issue.summary,
            issue.detail.as_deref().unwrap_or(""),
            fields
        ),
        _ => log::info!(
            "[observability] issue={} summary=\"{}\" detail={} fields={}",
            issue.id,
            issue.summary,
            issue.detail.as_deref().unwrap_or(""),
            fields
        ),
    }
}

fn record_issue(_app: Option<&AppHandle>, input: IssueBuilder) -> ObservabilityIssue {
    let detail_for_classification = input
        .detail
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&input.summary);
    let kind = input
        .kind
        .unwrap_or_else(|| classify_error_kind(detail_for_classification).to_string());
    let severity = input
        .severity
        .unwrap_or_else(|| severity_for_kind(&kind).to_string());
    let remediation = input
        .remediation
        .or_else(|| remediation_for_kind(&kind).map(str::to_string));
    let issue = ObservabilityIssue {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        timestamp_ms: now_ms(),
        severity,
        area: input.area,
        operation: input.operation,
        kind,
        summary: input.summary,
        detail: input.detail,
        model_id: input.model_id,
        provider: input.provider,
        request_id: input.request_id,
        duration_ms: input.duration_ms,
        remediation,
        user_visible: input.user_visible,
        context: input.context,
    };

    if let Ok(mut issues) = issue_store().lock() {
        while issues.len() >= MAX_ISSUES {
            issues.pop_front();
        }
        issues.push_back(issue.clone());
    }
    log_issue(&issue);
    issue
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_failure_strings() {
        assert_eq!(
            classify_error_kind("CUDA_ERROR_OUT_OF_MEMORY"),
            "out_of_memory"
        );
        assert_eq!(
            classify_error_kind("HTTP 429 Too Many Requests"),
            "rate_limited"
        );
        assert_eq!(classify_error_kind("connection refused"), "network");
        assert_eq!(classify_error_kind("no space left on device"), "disk_full");
        assert_eq!(classify_error_kind("thread panicked"), "panic");
    }
}
