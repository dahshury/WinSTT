//! Cleanup service: path-resolution, filesystem deletion, HF-cache scanning,
//! OS cleanup-script staging, and the model-uninstall settings patch.
//!
//! This is the SERVICE layer behind the `remove_application_data` /
//! `remove_downloaded_models` Tauri commands (`crate::commands::cleanup`). The
//! commands stay thin: they validate the caller, call into here, and map the
//! results onto their generated binding shapes. All filesystem/script/HF/Ollama
//! logic lives here so it can be unit-tested and reused without a command shell.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::winstt::commands::settings::PartialWinsttSettings;
use crate::winstt::managers::{
    tts_download_manager::TtsDownloadManager, DownloadManager, LlmManager,
};
use crate::winstt::settings_schema::{
    LiveTranscriptionDisplay, LlmProvider, RecordingMode, WinsttSettings,
};

// ───────────────────────── model-uninstall settings patch ─────────────────────────

/// Build the settings patch that uninstalling all downloaded models implies:
/// clear the selected STT models and disable every model-backed feature. Returns
/// the patch plus the list of feature keys that were toggled off (for surfacing).
pub fn model_uninstall_settings_patch(
    settings: &WinsttSettings,
    delete_ollama_models: bool,
) -> (PartialWinsttSettings, Vec<String>) {
    let mut disabled = BTreeSet::new();

    let mut model = settings.model.clone();
    if !model.model.trim().is_empty() {
        disabled.insert("sttModel".to_string());
    }
    if !model.realtime_model.trim().is_empty() {
        disabled.insert("realtimeSttModel".to_string());
    }
    model.model.clear();
    model.realtime_model.clear();

    let mut general = settings.general.clone();
    if general.live_transcription_display != LiveTranscriptionDisplay::None {
        disabled.insert("liveTranscription".to_string());
    }
    general.live_transcription_display = LiveTranscriptionDisplay::None;
    if general.speaker_diarization {
        disabled.insert("speakerDiarization".to_string());
    }
    general.speaker_diarization = false;
    if matches!(
        general.recording_mode,
        RecordingMode::Wakeword | RecordingMode::Listen
    ) {
        disabled.insert("ambientRecording".to_string());
        general.recording_mode = RecordingMode::Ptt;
    }

    let mut tts = settings.tts.clone();
    if tts.enabled {
        disabled.insert("textToSpeech".to_string());
    }
    tts.enabled = false;

    let llm = if delete_ollama_models {
        let mut llm = settings.llm.clone();
        if llm.dictation.enabled && llm.dictation.base.provider == LlmProvider::Ollama {
            disabled.insert("llmDictation".to_string());
            llm.dictation.enabled = false;
        }
        if llm.transforms.enabled && llm.transforms.base.provider == LlmProvider::Ollama {
            disabled.insert("llmTransforms".to_string());
            llm.transforms.enabled = false;
        }
        Some(llm)
    } else {
        None
    };

    (
        PartialWinsttSettings {
            model: Some(model),
            general: Some(general),
            tts: Some(tts),
            llm,
            ..PartialWinsttSettings::default()
        },
        disabled.into_iter().collect(),
    )
}

/// Clear the legacy top-level `selected_model` field that predates the nested
/// settings tree. No-op when already empty.
pub fn clear_legacy_selected_model(app: &AppHandle) {
    let mut settings = crate::settings::get_settings(app);
    if settings.selected_model.is_empty() {
        return;
    }
    settings.selected_model.clear();
    crate::settings::write_settings(app, settings);
}

// ───────────────────────── model-cache deletion ─────────────────────────

/// Delete every cached STT model (catalog entries + the WinSTT-owned Hugging
/// Face cache repos). Returns the number of distinct caches removed; failures
/// are pushed onto `errors`.
pub async fn delete_stt_model_caches(
    downloads: &Arc<DownloadManager>,
    errors: &mut Vec<String>,
) -> usize {
    let mut deleted = 0;
    for entry in crate::winstt::catalog::STT_CATALOG {
        downloads.delete_model_cache(entry.id);
        deleted += 1;
    }

    for path in win_stt_hf_cache_repo_paths().await {
        match remove_path_if_exists(&path) {
            Ok(true) => deleted += 1,
            Ok(false) => {}
            Err(err) => errors.push(format!("{}: {err}", path.display())),
        }
    }

    downloads.invalidate_scan_memo();
    for entry in crate::winstt::catalog::STT_CATALOG {
        downloads.emit_cache_changed(entry.id);
    }

    deleted
}

/// Delete every cached TTS model (catalog entries, the app-data `tts` dir, and
/// the hardcoded runtime dir). Returns the count removed; failures push onto
/// `errors`.
pub fn delete_tts_model_caches(
    app: &AppHandle,
    tts_downloads: &Arc<TtsDownloadManager>,
    errors: &mut Vec<String>,
) -> usize {
    let mut deleted = 0;
    for entry in crate::winstt::tts::catalog::TTS_CATALOG {
        tts_downloads.delete(entry.id);
        deleted += 1;
    }

    match crate::portable::app_data_dir(app) {
        Ok(app_data_dir) => match remove_path_if_exists(&app_data_dir.join("tts")) {
            Ok(true) => deleted += 1,
            Ok(false) => {}
            Err(err) => errors.push(format!("{}: {err}", app_data_dir.join("tts").display())),
        },
        Err(err) => errors.push(format!("failed to resolve app data directory: {err}")),
    }

    for path in hardcoded_tts_runtime_dirs() {
        match remove_path_if_exists(&path) {
            Ok(true) => {
                deleted += 1;
                remove_empty_parent_dirs(&path, 2);
            }
            Ok(false) => {}
            Err(err) => errors.push(format!("{}: {err}", path.display())),
        }
    }

    deleted
}

/// Delete the cached wake-word model dir. Returns 1 if a dir was removed, else 0;
/// failures push onto `errors`.
pub fn delete_wakeword_model_caches(app: &AppHandle, errors: &mut Vec<String>) -> usize {
    let app_data_dir = match crate::portable::app_data_dir(app) {
        Ok(path) => path,
        Err(err) => {
            errors.push(format!("failed to resolve app data directory: {err}"));
            return 0;
        }
    };
    let path = app_data_dir.join("wakeword");
    match remove_path_if_exists(&path) {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(err) => {
            errors.push(format!("{}: {err}", path.display()));
            0
        }
    }
}

fn hardcoded_tts_runtime_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        out.push(
            PathBuf::from(local)
                .join("winstt")
                .join("tts")
                .join("runtime"),
        );
    }
    out
}

fn remove_path_if_exists(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .map_err(|err| err.to_string())?;
    Ok(true)
}

fn remove_empty_parent_dirs(path: &Path, max_depth: usize) {
    let mut parent = path.parent();
    for _ in 0..max_depth {
        let Some(dir) = parent else {
            return;
        };
        let next = dir.parent();
        let _ = std::fs::remove_dir(dir);
        parent = next;
    }
}

// ───────────────────────── application-data cleanup plan ─────────────────────────

/// Resolved set of filesystem targets to delete when wiping all application data,
/// plus whether the portable app directory itself is safe to remove.
pub struct CleanupPlan {
    pub app_dir: Option<PathBuf>,
    pub delete_portable_app_dir: bool,
    pub targets: Vec<PathBuf>,
}

impl CleanupPlan {
    pub async fn from_app(app: &AppHandle) -> Result<Self, String> {
        let app_data_dir = crate::portable::app_data_dir(app)
            .map_err(|err| format!("failed to resolve app data directory: {err}"))?;
        let exe_path =
            std::env::current_exe().map_err(|err| format!("failed to resolve exe path: {err}"))?;
        let app_dir = exe_path.parent().map(Path::to_path_buf);

        let mut targets = BTreeSet::new();
        targets.insert(app_data_dir.clone());
        insert_path_result(&mut targets, crate::portable::app_log_dir(app));
        insert_path_result(&mut targets, app.path().app_cache_dir());
        insert_path_result(&mut targets, app.path().app_config_dir());
        insert_path_result(&mut targets, app.path().app_local_data_dir());
        for path in hardcoded_winstt_local_dirs() {
            targets.insert(path);
        }
        for path in win_stt_hf_cache_repo_paths().await {
            targets.insert(path);
        }

        let mut delete_portable_app_dir = false;
        if crate::portable::is_portable() {
            if let Some(dir) = app_dir.as_ref() {
                if safe_to_remove_portable_app_dir(dir, &app_data_dir, &exe_path) {
                    delete_portable_app_dir = true;
                    targets.insert(dir.clone());
                } else {
                    targets.insert(exe_path);
                    targets.insert(dir.join("portable"));
                }
            }
        }

        Ok(Self {
            app_dir,
            delete_portable_app_dir,
            targets: targets.into_iter().collect(),
        })
    }
}

fn insert_path_result(
    targets: &mut BTreeSet<PathBuf>,
    result: Result<PathBuf, impl std::fmt::Display>,
) {
    match result {
        Ok(path) => {
            targets.insert(path);
        }
        Err(err) => {
            log::warn!("[cleanup] failed to resolve cleanup target: {err}");
        }
    }
}

fn hardcoded_winstt_local_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        // TTS phonemization installs the pinned espeakng_loader runtime here,
        // outside the portable Data dir and outside Tauri's app dirs.
        out.push(PathBuf::from(local).join("winstt"));
    }
    out
}

// ───────────────────────── app-data disk usage ─────────────────────────

/// Recursively sum the byte size of `path` (a file or a directory tree).
/// Unreadable entries contribute 0 — this powers the "what will I free?" preview,
/// where a best-effort figure beats failing the whole panel.
fn path_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                total += entry.metadata().map_or(0, |m| m.len());
            }
        }
    }
    total
}

/// Per-category on-disk footprint of WinSTT's application data, for the
/// "remove application data" preview so the user can see what each removal frees.
/// Categories mirror what the wipe deletes; `other` is whatever else lives in the
/// app-data dir (settings, misc caches). Best-effort: an unreadable path is 0.
pub async fn app_data_usage(app: &AppHandle) -> Vec<(&'static str, u64)> {
    let Ok(app_data) = crate::portable::app_data_dir(app) else {
        return Vec::new();
    };
    let log_dir = crate::portable::app_log_dir(app).ok();

    let tts_app = path_size(&app_data.join("tts"));
    let tts_runtime: u64 = hardcoded_tts_runtime_dirs()
        .iter()
        .map(|p| path_size(p))
        .sum();
    let dictionary = path_size(&app_data.join("encoder-dict"));
    let wakeword = path_size(&app_data.join("wakeword"));
    let history = path_size(&app_data.join("history.db")) + path_size(&app_data.join("recordings"));
    let logs = log_dir.as_deref().map_or(0, path_size);
    let stt: u64 = win_stt_hf_cache_repo_paths()
        .await
        .iter()
        .map(|p| path_size(p))
        .sum();

    // "Other" = the app-data total minus the categories that live under it
    // (settings.json + misc caches). Logs live under app-data in portable mode,
    // so subtract them too when nested to avoid double-counting.
    let app_data_total = path_size(&app_data);
    let mut known_under = tts_app + dictionary + wakeword + history;
    if log_dir.as_deref().is_some_and(|p| p.starts_with(&app_data)) {
        known_under += logs;
    }
    let other = app_data_total.saturating_sub(known_under);

    vec![
        ("stt", stt),
        ("tts", tts_app + tts_runtime),
        ("dictionary", dictionary),
        ("wakeword", wakeword),
        ("history", history),
        ("logs", logs),
        ("other", other),
    ]
}

// ───────────────────────── Ollama model deletion ─────────────────────────

/// Delete each configured Ollama model via the LLM manager. Returns
/// (deleted, errors).
pub async fn delete_configured_ollama_models(
    settings: &WinsttSettings,
    llm_manager: Arc<LlmManager>,
) -> (Vec<String>, Vec<String>) {
    let mut deleted = Vec::new();
    let mut errors = Vec::new();
    let endpoint = settings.llm.endpoint.clone();

    for model in configured_ollama_models(settings) {
        let (success, error) = llm_manager.ollama_delete(&endpoint, &model).await;
        if success {
            deleted.push(model);
        } else {
            errors.push(format!(
                "{model}: {}",
                error.unwrap_or_else(|| "delete failed".to_string())
            ));
        }
    }

    (deleted, errors)
}

fn configured_ollama_models(settings: &WinsttSettings) -> Vec<String> {
    let mut out = BTreeSet::new();
    if settings.llm.dictation.base.provider == LlmProvider::Ollama {
        let model = settings.llm.dictation.base.model.trim();
        if !model.is_empty() {
            out.insert(model.to_string());
        }
    }
    if settings.llm.transforms.base.provider == LlmProvider::Ollama {
        let model = settings.llm.transforms.base.model.trim();
        if !model.is_empty() {
            out.insert(model.to_string());
        }
    }
    out.into_iter().collect()
}

// ───────────────────────── Hugging Face cache repos ─────────────────────────

async fn win_stt_hf_cache_repo_paths() -> Vec<PathBuf> {
    let repo_ids = win_stt_hf_repo_ids();
    if repo_ids.is_empty() {
        return Vec::new();
    }

    let client = match hf_hub::HFClient::new() {
        Ok(client) => client,
        Err(err) => {
            log::warn!("[cleanup] failed to initialize Hugging Face client: {err}");
            return Vec::new();
        }
    };
    let scan = match client.scan_cache().send().await {
        Ok(scan) => scan,
        Err(err) => {
            log::warn!("[cleanup] failed to scan Hugging Face cache: {err}");
            return Vec::new();
        }
    };

    scan.repos
        .iter()
        .filter(|repo| repo_ids.contains(&repo.repo_id.to_ascii_lowercase()))
        .map(|repo| repo.repo_path.clone())
        .collect()
}

fn win_stt_hf_repo_ids() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for entry in crate::winstt::catalog::STT_CATALOG {
        insert_resolved_repo_id(&mut out, entry.id);
        insert_resolved_repo_id(&mut out, entry.onnx_model_name);
    }
    // Helper model repos used by VAD / diarization code paths.
    insert_resolved_repo_id(&mut out, "silero");
    insert_resolved_repo_id(&mut out, "wespeaker-voxceleb-resnet34-LM");
    out
}

fn insert_resolved_repo_id(out: &mut BTreeSet<String>, model_id: &str) {
    if let Some((owner, name)) = crate::winstt::stt::resolver::resolve_repo(model_id) {
        out.insert(format!("{owner}/{name}").to_ascii_lowercase());
    }
}

// ───────────────────────── portable-dir safety ─────────────────────────

fn safe_to_remove_portable_app_dir(app_dir: &Path, app_data_dir: &Path, exe_path: &Path) -> bool {
    if app_dir.parent().is_none() {
        return false;
    }
    if is_well_known_user_dir(app_dir) {
        return false;
    }
    if app_dir.join(".git").exists() {
        return false;
    }
    if exe_path.parent() != Some(app_dir) {
        return false;
    }
    if app_data_dir.parent() != Some(app_dir) {
        return false;
    }
    if !valid_portable_marker(&app_dir.join("portable")) {
        return false;
    }
    app_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().contains("winstt"))
}

fn valid_portable_marker(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .is_ok_and(|value| value.trim().starts_with("WinSTT Portable Mode"))
}

fn is_well_known_user_dir(path: &Path) -> bool {
    let canonical = canonicalish(path);
    well_known_user_dirs()
        .into_iter()
        .any(|candidate| canonical == canonicalish(&candidate))
}

fn well_known_user_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let profile = PathBuf::from(profile);
        out.push(profile.clone());
        out.push(profile.join("Desktop"));
        out.push(profile.join("Downloads"));
        out.push(profile.join("Documents"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(PathBuf::from(appdata));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        out.push(PathBuf::from(local));
    }
    out
}

fn canonicalish(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

// ───────────────────────── post-exit cleanup script staging ─────────────────────────

/// Stage and spawn the detached OS script that finishes deleting the cleanup
/// plan's targets once this process exits.
pub fn schedule_cleanup_after_exit(plan: &CleanupPlan) -> Result<(), String> {
    if plan.targets.is_empty() {
        return Err("cleanup plan has no targets".to_string());
    }

    #[cfg(windows)]
    {
        schedule_powershell_cleanup(plan)
    }
    #[cfg(not(windows))]
    {
        schedule_sh_cleanup(plan)
    }
}

#[cfg(windows)]
fn schedule_powershell_cleanup(plan: &CleanupPlan) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let script_path = cleanup_script_path("ps1");
    let script = powershell_cleanup_script(plan);
    std::fs::write(&script_path, script)
        .map_err(|err| format!("failed to write cleanup script: {err}"))?;

    let mut command = std::process::Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script_path)
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to spawn cleanup script: {err}"))
}

#[cfg(windows)]
fn powershell_cleanup_script(plan: &CleanupPlan) -> String {
    let targets = plan
        .targets
        .iter()
        .map(|path| format!("  {}", ps_quote(path)))
        .collect::<Vec<_>>()
        .join(",\n");
    let app_dir = plan
        .app_dir
        .as_ref()
        .map_or_else(|| "$null".to_string(), |path| ps_quote(path));
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$pidToWait = {pid}
try {{ Wait-Process -Id $pidToWait -ErrorAction SilentlyContinue }} catch {{ }}
Start-Sleep -Milliseconds 600
$targets = @(
{targets}
)
foreach ($target in $targets) {{
  if ([string]::IsNullOrWhiteSpace($target)) {{ continue }}
  for ($i = 0; $i -lt 24; $i++) {{
    if (-not (Test-Path -LiteralPath $target)) {{ break }}
    try {{
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
      break
    }} catch {{
      Start-Sleep -Milliseconds 250
    }}
  }}
}}
$appDir = {app_dir}
if ($appDir -and (Test-Path -LiteralPath $appDir)) {{
  try {{
    $remaining = @(Get-ChildItem -LiteralPath $appDir -Force -ErrorAction Stop)
    if ($remaining.Count -eq 0) {{
      Remove-Item -LiteralPath $appDir -Force -ErrorAction SilentlyContinue
    }}
  }} catch {{ }}
}}
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
"#,
        pid = std::process::id(),
        targets = targets,
        app_dir = app_dir
    )
}

#[cfg(windows)]
fn ps_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

#[cfg(not(windows))]
fn schedule_sh_cleanup(plan: &CleanupPlan) -> Result<(), String> {
    let script_path = cleanup_script_path("sh");
    let script = sh_cleanup_script(plan);
    std::fs::write(&script_path, script)
        .map_err(|err| format!("failed to write cleanup script: {err}"))?;

    let mut command = std::process::Command::new("sh");
    command
        .arg(&script_path)
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to spawn cleanup script: {err}"))
}

#[cfg(not(windows))]
fn sh_cleanup_script(plan: &CleanupPlan) -> String {
    let targets = plan
        .targets
        .iter()
        .map(|path| sh_quote(path))
        .collect::<Vec<_>>()
        .join(" ");
    let app_dir = plan
        .app_dir
        .as_ref()
        .map_or_else(|| "''".to_string(), |path| sh_quote(path));
    format!(
        r#"pid={pid}
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
sleep 0.6
for target in {targets}; do
  [ -n "$target" ] && rm -rf -- "$target"
done
app_dir={app_dir}
[ -n "$app_dir" ] && rmdir -- "$app_dir" 2>/dev/null || true
rm -f -- "$0"
"#,
        pid = std::process::id(),
        targets = targets,
        app_dir = app_dir
    )
}

#[cfg(not(windows))]
fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn cleanup_script_path(extension: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "winstt-cleanup-{}-{millis}.{extension}",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_ollama_models_dedupes_dictation_and_transforms() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.base.provider = LlmProvider::Ollama;
        settings.llm.dictation.base.model = "gemma3:4b".into();
        settings.llm.transforms.base.provider = LlmProvider::Ollama;
        settings.llm.transforms.base.model = "gemma3:4b".into();

        assert_eq!(configured_ollama_models(&settings), vec!["gemma3:4b"]);
    }

    #[test]
    fn configured_ollama_models_ignores_non_ollama_provider() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.base.provider = LlmProvider::Openrouter;
        settings.llm.dictation.base.model = "gemma3:4b".into();
        settings.llm.transforms.base.provider = LlmProvider::AppleIntelligence;
        settings.llm.transforms.base.model = "qwen3:8b".into();

        assert!(configured_ollama_models(&settings).is_empty());
    }

    #[test]
    fn model_uninstall_patch_clears_models_and_disables_model_backed_features() {
        let mut settings = WinsttSettings::default();
        settings.model.model = "nemo-canary-180m-flash".into();
        settings.model.realtime_model = "tiny".into();
        settings.general.live_transcription_display = LiveTranscriptionDisplay::Both;
        settings.general.speaker_diarization = true;
        settings.general.recording_mode = RecordingMode::Wakeword;
        settings.tts.enabled = true;

        let (patch, disabled) = model_uninstall_settings_patch(&settings, false);

        let model = patch.model.expect("model patch");
        assert_eq!(model.model, "");
        assert_eq!(model.realtime_model, "");

        let general = patch.general.expect("general patch");
        assert_eq!(
            general.live_transcription_display,
            LiveTranscriptionDisplay::None
        );
        assert!(!general.speaker_diarization);
        assert_eq!(general.recording_mode, RecordingMode::Ptt);

        let tts = patch.tts.expect("tts patch");
        assert!(!tts.enabled);

        assert!(disabled.contains(&"sttModel".to_string()));
        assert!(disabled.contains(&"realtimeSttModel".to_string()));
        assert!(disabled.contains(&"liveTranscription".to_string()));
        assert!(disabled.contains(&"speakerDiarization".to_string()));
        assert!(disabled.contains(&"ambientRecording".to_string()));
        assert!(disabled.contains(&"textToSpeech".to_string()));
    }

    #[test]
    fn model_uninstall_patch_only_disables_ollama_features_when_requested() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.provider = LlmProvider::Ollama;
        settings.llm.transforms.enabled = true;
        settings.llm.transforms.base.provider = LlmProvider::Openrouter;

        let (keep_patch, keep_disabled) = model_uninstall_settings_patch(&settings, false);
        assert!(keep_patch.llm.is_none());
        assert!(!keep_disabled.contains(&"llmDictation".to_string()));

        let (delete_patch, delete_disabled) = model_uninstall_settings_patch(&settings, true);
        let llm = delete_patch.llm.expect("llm patch");
        assert!(!llm.dictation.enabled);
        assert!(llm.transforms.enabled);
        assert!(delete_disabled.contains(&"llmDictation".to_string()));
        assert!(!delete_disabled.contains(&"llmTransforms".to_string()));
    }

    #[test]
    fn hf_repo_ids_include_catalog_and_helper_models() {
        let ids = win_stt_hf_repo_ids();
        assert!(ids.contains("onnx-community/whisper-tiny"));
        assert!(ids.contains("istupakov/silero-vad-onnx"));
        assert!(ids.contains("wespeaker/wespeaker-voxceleb-resnet34-lm"));
    }

    #[test]
    fn safe_portable_dir_requires_marker_data_child_and_winstt_name() {
        let dir = test_dir("winstt-cleanup-safe");
        std::fs::create_dir_all(dir.join("Data")).unwrap();
        std::fs::write(dir.join("portable"), "WinSTT Portable Mode").unwrap();
        let exe = dir.join("WinSTT.exe");
        std::fs::write(&exe, "").unwrap();

        assert!(safe_to_remove_portable_app_dir(
            &dir,
            &dir.join("Data"),
            &exe
        ));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn safe_portable_dir_rejects_missing_marker_or_external_data_dir() {
        let dir = test_dir("winstt-cleanup-unsafe");
        let external_data = test_dir("winstt-cleanup-external-data");
        std::fs::create_dir_all(dir.join("Data")).unwrap();
        std::fs::create_dir_all(&external_data).unwrap();
        let exe = dir.join("WinSTT.exe");
        std::fs::write(&exe, "").unwrap();

        assert!(!safe_to_remove_portable_app_dir(
            &dir,
            &dir.join("Data"),
            &exe
        ));

        std::fs::write(dir.join("portable"), "WinSTT Portable Mode").unwrap();
        assert!(!safe_to_remove_portable_app_dir(&dir, &external_data, &exe));

        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(external_data).unwrap();
    }

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}-{}", std::process::id()))
    }
}
