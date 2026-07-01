use semver::Version;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::command_auth;
use crate::winstt::commands::settings::read_settings;
use crate::winstt::observability::IssueBuilder;

const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/dahshury/WinSTT/releases?per_page=30";
const LATEST_JSON_ASSET: &str = "latest.json";
const STATUS_EVENT: &str = "updater:status";
const MAX_STATUS_HISTORY: usize = 200;
const PORTABLE_UPDATES_DISABLED_REASON: &str = "portable-updates-disabled";
const UPDATER_CHECK_ALLOWED_WINDOWS: &[&str] = &["settings", "tray-menu", "main"];
const UPDATER_INSTALL_ALLOWED_WINDOWS: &[&str] = &["settings"];

#[derive(Clone, Default)]
pub struct UpdaterRuntimeState {
    inner: Arc<Mutex<UpdaterStateInner>>,
}

#[derive(Default)]
struct UpdaterStateInner {
    history: Vec<UpdaterStatusEntry>,
    pending: Option<PendingDownloadedUpdate>,
    running_check: bool,
}

struct PendingDownloadedUpdate {
    bytes: Vec<u8>,
    update: Update,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCommandResult {
    pub triggered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClearUpdaterHistoryResult {
    pub cleared: bool,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatusEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transferred: Option<u64>,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct UpdaterStatusInput {
    bytes_per_second: Option<f64>,
    message: Option<String>,
    percent: Option<f64>,
    status: &'static str,
    total: Option<u64>,
    transferred: Option<u64>,
    version: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubAsset {
    browser_download_url: String,
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubRelease {
    assets: Vec<GitHubAsset>,
    draft: bool,
    prerelease: bool,
    tag_name: String,
}

#[derive(Clone, Debug)]
struct ReleaseCandidate {
    release: GitHubRelease,
    version: Version,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UpdaterOperation {
    CheckAndDownload,
    Install,
}

impl UpdaterOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::CheckAndDownload => "check-and-download",
            Self::Install => "install",
        }
    }

    fn issue_operation(self) -> &'static str {
        match self {
            Self::CheckAndDownload => "check_and_download",
            Self::Install => "install",
        }
    }
}

fn lock_state(state: &UpdaterRuntimeState) -> std::sync::MutexGuard<'_, UpdaterStateInner> {
    state
        .inner
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn record_status(
    app: &AppHandle,
    state: &UpdaterRuntimeState,
    input: UpdaterStatusInput,
) -> UpdaterStatusEntry {
    let entry = UpdaterStatusEntry {
        bytes_per_second: input.bytes_per_second,
        message: input.message,
        percent: input.percent,
        status: input.status.to_string(),
        timestamp: now_millis(),
        total: input.total,
        transferred: input.transferred,
        version: input.version,
    };

    {
        let mut inner = lock_state(state);
        inner.history.push(entry.clone());
        let overflow = inner.history.len().saturating_sub(MAX_STATUS_HISTORY);
        if overflow > 0 {
            inner.history.drain(0..overflow);
        }
    }

    if let Err(error) = app.emit(STATUS_EVENT, &entry) {
        log::warn!("[updater] failed to emit updater status: {error}");
    }

    entry
}

fn parse_release_version(tag_name: &str) -> Option<Version> {
    Version::parse(tag_name.strip_prefix('v').unwrap_or(tag_name)).ok()
}

fn latest_json_url(release: &GitHubRelease) -> Option<&str> {
    release
        .assets
        .iter()
        .find(|asset| asset.name.eq_ignore_ascii_case(LATEST_JSON_ASSET))
        .map(|asset| asset.browser_download_url.as_str())
}

fn blocked_result(reason: impl Into<String>) -> UpdaterCommandResult {
    UpdaterCommandResult {
        reason: Some(reason.into()),
        triggered: false,
    }
}

fn updater_issue(
    operation: UpdaterOperation,
    summary: impl Into<String>,
    detail: impl Into<String>,
    version: Option<&str>,
) -> IssueBuilder {
    let mut issue = IssueBuilder::new("updater", operation.issue_operation(), summary)
        .detail(detail)
        .provider("github")
        .user_visible(true);
    if let Some(version) = version {
        issue = issue.context("version", version.to_string());
    }
    issue
}

fn record_updater_failure(
    app: &AppHandle,
    operation: UpdaterOperation,
    summary: &'static str,
    detail: impl Into<String>,
    version: Option<&str>,
) {
    updater_issue(operation, summary, detail, version).record(Some(app));
}

#[cfg(test)]
fn is_updater_operation_allowed(caller: &str, operation: UpdaterOperation) -> bool {
    match operation {
        UpdaterOperation::CheckAndDownload => {
            command_auth::label_in(caller, UPDATER_CHECK_ALLOWED_WINDOWS)
        }
        UpdaterOperation::Install => {
            command_auth::label_in(caller, UPDATER_INSTALL_ALLOWED_WINDOWS)
        }
    }
}

fn authorize_updater_operation(
    caller: &tauri::WebviewWindow,
    operation: UpdaterOperation,
) -> Result<(), String> {
    let allowed = match operation {
        UpdaterOperation::CheckAndDownload => UPDATER_CHECK_ALLOWED_WINDOWS,
        UpdaterOperation::Install => UPDATER_INSTALL_ALLOWED_WINDOWS,
    };
    command_auth::authorize_webview(caller, "updater", operation.as_str(), allowed, " updater")
}

fn portable_update_policy_block_reason(is_portable: bool) -> Option<&'static str> {
    is_portable.then_some(PORTABLE_UPDATES_DISABLED_REASON)
}

fn updater_policy_block_reason() -> Option<&'static str> {
    portable_update_policy_block_reason(crate::portable::is_portable())
}

fn select_release(
    releases: Vec<GitHubRelease>,
    current_version: &Version,
    include_prerelease: bool,
) -> Option<ReleaseCandidate> {
    releases
        .into_iter()
        .filter(|release| !release.draft)
        .filter(|release| include_prerelease || !release.prerelease)
        .filter_map(|release| {
            let version = parse_release_version(&release.tag_name)?;
            (version > *current_version).then_some(ReleaseCandidate { release, version })
        })
        .max_by(|left, right| left.version.cmp(&right.version))
}

async fn fetch_github_releases() -> Result<Vec<GitHubRelease>, String> {
    let client = reqwest::Client::builder()
        .user_agent("WinSTT-updater")
        .build()
        .map_err(|error| format!("failed to create GitHub client: {error}"))?;
    let response = client
        .get(GITHUB_RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("failed to query GitHub releases: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub releases request failed with status {}",
            response.status()
        ));
    }

    response
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|error| format!("failed to parse GitHub releases: {error}"))
}

fn begin_check(state: &UpdaterRuntimeState) -> bool {
    let mut inner = lock_state(state);
    if inner.running_check {
        return false;
    }
    inner.running_check = true;
    true
}

fn finish_check(state: &UpdaterRuntimeState) {
    lock_state(state).running_check = false;
}

async fn check_and_download_inner(
    app: AppHandle,
    state: UpdaterRuntimeState,
    include_prerelease_updates: Option<bool>,
) -> Result<UpdaterCommandResult, String> {
    record_status(
        &app,
        &state,
        UpdaterStatusInput {
            status: "checking",
            ..UpdaterStatusInput::default()
        },
    );

    let current_version = app.package_info().version.clone();
    let persisted_include = read_settings(&app).general.receive_prerelease_updates;
    let include_prerelease =
        include_prerelease_updates.unwrap_or(persisted_include) || !current_version.pre.is_empty();

    let releases = fetch_github_releases().await?;
    let Some(candidate) = select_release(releases, &current_version, include_prerelease) else {
        lock_state(&state).pending = None;
        record_status(
            &app,
            &state,
            UpdaterStatusInput {
                status: "not-available",
                ..UpdaterStatusInput::default()
            },
        );
        return Ok(UpdaterCommandResult {
            reason: None,
            triggered: true,
        });
    };

    let manifest_url = latest_json_url(&candidate.release).ok_or_else(|| {
        format!(
            "GitHub release {} is missing latest.json. Re-run the release workflow with updater artifacts enabled.",
            candidate.release.tag_name
        )
    })?;
    let endpoint = manifest_url
        .parse()
        .map_err(|error| format!("invalid updater manifest URL: {error}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        lock_state(&state).pending = None;
        record_status(
            &app,
            &state,
            UpdaterStatusInput {
                status: "not-available",
                ..UpdaterStatusInput::default()
            },
        );
        return Ok(UpdaterCommandResult {
            reason: None,
            triggered: true,
        });
    };

    let version = update.version.clone();
    record_status(
        &app,
        &state,
        UpdaterStatusInput {
            status: "available",
            version: Some(version.clone()),
            ..UpdaterStatusInput::default()
        },
    );

    let mut transferred = 0_u64;
    let mut total = None;
    let mut last_transferred = 0_u64;
    let mut last_at = Instant::now();
    let mut started = false;

    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    total = content_length;
                    record_status(
                        &app,
                        &state,
                        UpdaterStatusInput {
                            percent: content_length.map(|_| 0.0),
                            status: "downloading",
                            total: content_length,
                            transferred: Some(0),
                            version: Some(version.clone()),
                            ..UpdaterStatusInput::default()
                        },
                    );
                }

                transferred = transferred.saturating_add(chunk_length as u64);
                let now = Instant::now();
                let elapsed_seconds = now.duration_since(last_at).as_secs_f64().max(0.001);
                let bytes_per_second =
                    (transferred.saturating_sub(last_transferred) as f64) / elapsed_seconds;
                last_at = now;
                last_transferred = transferred;

                record_status(
                    &app,
                    &state,
                    UpdaterStatusInput {
                        bytes_per_second: Some(bytes_per_second),
                        percent: total.map(|total| {
                            if total == 0 {
                                0.0
                            } else {
                                (transferred as f64 / total as f64) * 100.0
                            }
                        }),
                        status: "downloading",
                        total,
                        transferred: Some(transferred),
                        version: Some(version.clone()),
                        ..UpdaterStatusInput::default()
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;

    record_status(
        &app,
        &state,
        UpdaterStatusInput {
            percent: total.map(|_| 100.0),
            status: "downloading",
            total,
            transferred: Some(transferred),
            version: Some(version.clone()),
            ..UpdaterStatusInput::default()
        },
    );

    {
        let mut inner = lock_state(&state);
        inner.pending = Some(PendingDownloadedUpdate { bytes, update });
    }

    record_status(
        &app,
        &state,
        UpdaterStatusInput {
            status: "downloaded",
            version: Some(version),
            ..UpdaterStatusInput::default()
        },
    );

    Ok(UpdaterCommandResult {
        reason: None,
        triggered: true,
    })
}

#[tauri::command]
#[specta::specta]
pub fn winstt_updater_get_status_history(
    state: State<'_, UpdaterRuntimeState>,
) -> Vec<UpdaterStatusEntry> {
    lock_state(state.inner()).history.clone()
}

#[tauri::command]
#[specta::specta]
pub fn winstt_updater_clear_status_history(
    state: State<'_, UpdaterRuntimeState>,
) -> ClearUpdaterHistoryResult {
    lock_state(state.inner()).history.clear();
    ClearUpdaterHistoryResult { cleared: true }
}

#[tauri::command]
#[specta::specta]
pub async fn winstt_updater_check_and_download(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    state: State<'_, UpdaterRuntimeState>,
    include_prerelease_updates: Option<bool>,
) -> Result<UpdaterCommandResult, String> {
    authorize_updater_operation(&webview, UpdaterOperation::CheckAndDownload)?;
    if let Some(reason) = updater_policy_block_reason() {
        return Ok(blocked_result(reason));
    }

    let state = state.inner().clone();
    if !begin_check(&state) {
        return Ok(UpdaterCommandResult {
            reason: Some("already-checking".to_string()),
            triggered: true,
        });
    }

    let result =
        check_and_download_inner(app.clone(), state.clone(), include_prerelease_updates).await;
    finish_check(&state);

    match result {
        Ok(result) => Ok(result),
        Err(message) => {
            record_updater_failure(
                &app,
                UpdaterOperation::CheckAndDownload,
                "Updater check or download failed",
                message.clone(),
                None,
            );
            record_status(
                &app,
                &state,
                UpdaterStatusInput {
                    message: Some(message.clone()),
                    status: "error",
                    ..UpdaterStatusInput::default()
                },
            );
            Ok(UpdaterCommandResult {
                reason: Some(message),
                triggered: false,
            })
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn winstt_updater_install(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    state: State<'_, UpdaterRuntimeState>,
) -> Result<UpdaterCommandResult, String> {
    authorize_updater_operation(&webview, UpdaterOperation::Install)?;
    if let Some(reason) = updater_policy_block_reason() {
        return Ok(blocked_result(reason));
    }

    let state = state.inner().clone();
    let Some(pending) = lock_state(&state).pending.take() else {
        return Ok(blocked_result("no-update-downloaded"));
    };

    let version = pending.update.version.clone();
    match pending.update.install(&pending.bytes) {
        Ok(()) => {
            let app_to_restart = app;
            std::thread::spawn(move || app_to_restart.restart());
            Ok(UpdaterCommandResult {
                reason: None,
                triggered: true,
            })
        }
        Err(error) => {
            let message = error.to_string();
            let mut inner = lock_state(&state);
            inner.pending = Some(pending);
            drop(inner);
            record_updater_failure(
                &app,
                UpdaterOperation::Install,
                "Updater install failed",
                message.clone(),
                Some(&version),
            );
            record_status(
                &app,
                &state,
                UpdaterStatusInput {
                    message: Some(message.clone()),
                    status: "error",
                    version: Some(version),
                    ..UpdaterStatusInput::default()
                },
            );
            Ok(UpdaterCommandResult {
                reason: Some(message),
                triggered: false,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag_name: &str, prerelease: bool, assets: &[&str]) -> GitHubRelease {
        GitHubRelease {
            assets: assets
                .iter()
                .map(|name| GitHubAsset {
                    browser_download_url: format!("https://example.test/{name}"),
                    name: (*name).to_string(),
                })
                .collect(),
            draft: false,
            prerelease,
            tag_name: tag_name.to_string(),
        }
    }

    #[test]
    fn stable_channel_ignores_newer_prerelease() {
        let current = Version::parse("0.1.0").unwrap();
        let selected = select_release(
            vec![
                release("v0.2.0-alpha.1", true, &[LATEST_JSON_ASSET]),
                release("v0.1.1", false, &[LATEST_JSON_ASSET]),
            ],
            &current,
            false,
        )
        .unwrap();

        assert_eq!(selected.release.tag_name, "v0.1.1");
    }

    #[test]
    fn prerelease_channel_allows_semver_newer_prerelease() {
        let current = Version::parse("0.1.0").unwrap();
        let selected = select_release(
            vec![
                release("v0.1.1", false, &[LATEST_JSON_ASSET]),
                release("v0.2.0-alpha.1", true, &[LATEST_JSON_ASSET]),
            ],
            &current,
            true,
        )
        .unwrap();

        assert_eq!(selected.release.tag_name, "v0.2.0-alpha.1");
    }

    #[test]
    fn current_version_does_not_require_manifest() {
        let current = Version::parse("0.1.0").unwrap();
        let selected = select_release(vec![release("v0.1.0", false, &[])], &current, false);

        assert!(selected.is_none());
    }

    #[test]
    fn updater_check_is_limited_to_main_settings_and_tray_menu() {
        command_auth::assert_label_rules(
            &["main", "settings", "tray-menu"],
            &["overlay", "model-picker", "device-picker", "history"],
            |caller| is_updater_operation_allowed(caller, UpdaterOperation::CheckAndDownload),
        );
    }

    #[test]
    fn updater_install_is_settings_only() {
        command_auth::assert_label_rules(
            &["settings"],
            &["main", "tray-menu", "overlay", "model-picker", "history"],
            |caller| is_updater_operation_allowed(caller, UpdaterOperation::Install),
        );
    }

    #[test]
    fn portable_policy_blocks_updates() {
        assert_eq!(
            portable_update_policy_block_reason(true),
            Some(PORTABLE_UPDATES_DISABLED_REASON)
        );
        assert_eq!(portable_update_policy_block_reason(false), None);
    }

    #[test]
    fn updater_issue_carries_provider_operation_and_version_context() {
        let issue = updater_issue(
            UpdaterOperation::Install,
            "Updater install failed",
            "permission denied while replacing executable",
            Some("0.2.0"),
        )
        .build_for_test();

        assert_eq!(issue.area, "updater");
        assert_eq!(issue.operation, "install");
        assert_eq!(issue.provider.as_deref(), Some("github"));
        assert_eq!(issue.kind, "permission_denied");
        assert_eq!(
            issue.context.get("version").map(String::as_str),
            Some("0.2.0")
        );
    }
}
