use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::command_auth;
use crate::managers::transcription::TranscriptionManager;
use crate::winstt::commands::settings::{
    apply_settings_patch, read_settings, PartialWinsttSettings,
};
use crate::winstt::managers::{
    tts_download_manager::TtsDownloadManager, DownloadManager, LlmManager, TtsManager,
};
use crate::winstt::settings_schema::{
    LiveTranscriptionDisplay, LlmProvider, RecordingMode, WinsttSettings,
};

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveApplicationDataResult {
    pub scheduled: bool,
    pub portable: bool,
    pub delete_portable_app_dir: bool,
    pub deleted_ollama_models: Vec<String>,
    pub ollama_errors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDownloadedModelsResult {
    pub deleted_model_caches: usize,
    pub disabled_features: Vec<String>,
    pub deleted_ollama_models: Vec<String>,
    pub ollama_errors: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
enum CleanupOperation {
    RemoveApplicationData,
    RemoveDownloadedModels,
}

impl CleanupOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::RemoveApplicationData => "remove application data",
            Self::RemoveDownloadedModels => "remove downloaded models",
        }
    }
}

const CLEANUP_ALLOWED_WINDOWS: &[&str] = &["settings"];

#[cfg(test)]
fn is_cleanup_operation_allowed(caller: &str, _operation: CleanupOperation) -> bool {
    command_auth::label_in(caller, CLEANUP_ALLOWED_WINDOWS)
}

#[tauri::command]
#[specta::specta]
pub async fn remove_application_data(
    app: AppHandle,
    webview: WebviewWindow,
    llm_manager: State<'_, Arc<LlmManager>>,
    delete_ollama_models: bool,
) -> Result<RemoveApplicationDataResult, String> {
    command_auth::authorize_webview(
        &webview,
        "cleanup",
        CleanupOperation::RemoveApplicationData.as_str(),
        CLEANUP_ALLOWED_WINDOWS,
        "",
    )?;

    let settings = crate::winstt::commands::settings::read_settings(&app);
    let (deleted_ollama_models, ollama_errors) = if delete_ollama_models {
        delete_configured_ollama_models(&settings, llm_manager.inner().clone()).await
    } else {
        (Vec::new(), Vec::new())
    };

    let plan = CleanupPlan::from_app(&app).await?;
    schedule_cleanup_after_exit(&plan)?;

    let result = RemoveApplicationDataResult {
        scheduled: true,
        portable: crate::portable::is_portable(),
        delete_portable_app_dir: plan.delete_portable_app_dir,
        deleted_ollama_models,
        ollama_errors,
    };

    let app_for_exit = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        app_for_exit.exit(0);
    });

    Ok(result)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn remove_downloaded_models(
    app: AppHandle,
    webview: WebviewWindow,
    transcription: State<'_, Arc<TranscriptionManager>>,
    downloads: State<'_, Arc<DownloadManager>>,
    tts_manager: State<'_, Arc<TtsManager>>,
    tts_downloads: State<'_, Arc<TtsDownloadManager>>,
    llm_manager: State<'_, Arc<LlmManager>>,
    delete_ollama_models: bool,
) -> Result<RemoveDownloadedModelsResult, String> {
    command_auth::authorize_webview(
        &webview,
        "cleanup",
        CleanupOperation::RemoveDownloadedModels.as_str(),
        CLEANUP_ALLOWED_WINDOWS,
        "",
    )?;

    let original_settings = read_settings(&app);
    let (deleted_ollama_models, ollama_errors) = if delete_ollama_models {
        delete_configured_ollama_models(&original_settings, llm_manager.inner().clone()).await
    } else {
        (Vec::new(), Vec::new())
    };

    crate::utils::cancel_current_operation(&app);

    let mut errors = Vec::new();
    if let Err(err) = transcription.unload_model() {
        errors.push(format!("failed to unload STT model: {err}"));
    }
    tts_manager.unload_active_local_model_for_cleanup("model uninstall");

    let (patch, disabled_features) =
        model_uninstall_settings_patch(&original_settings, delete_ollama_models);
    apply_settings_patch(&app, patch)?;
    clear_legacy_selected_model(&app);

    let mut deleted_model_caches = 0;
    deleted_model_caches += delete_stt_model_caches(downloads.inner(), &mut errors).await;
    deleted_model_caches += delete_tts_model_caches(&app, tts_downloads.inner(), &mut errors);
    deleted_model_caches += delete_wakeword_model_caches(&app, &mut errors);

    Ok(RemoveDownloadedModelsResult {
        deleted_model_caches,
        disabled_features,
        deleted_ollama_models,
        ollama_errors,
        errors,
    })
}

fn model_uninstall_settings_patch(
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

fn clear_legacy_selected_model(app: &AppHandle) {
    let mut settings = crate::settings::get_settings(app);
    if settings.selected_model.is_empty() {
        return;
    }
    settings.selected_model.clear();
    crate::settings::write_settings(app, settings);
}

async fn delete_stt_model_caches(
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

fn delete_tts_model_caches(
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

fn delete_wakeword_model_caches(app: &AppHandle, errors: &mut Vec<String>) -> usize {
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

struct CleanupPlan {
    app_dir: Option<PathBuf>,
    delete_portable_app_dir: bool,
    targets: Vec<PathBuf>,
}

impl CleanupPlan {
    async fn from_app(app: &AppHandle) -> Result<Self, String> {
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

async fn delete_configured_ollama_models(
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
        .map(|name| name.to_ascii_lowercase().contains("winstt"))
        .unwrap_or(false)
}

fn valid_portable_marker(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|value| value.trim().starts_with("WinSTT Portable Mode"))
        .unwrap_or(false)
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

fn schedule_cleanup_after_exit(plan: &CleanupPlan) -> Result<(), String> {
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
        .map(|path| ps_quote(path))
        .unwrap_or_else(|| "$null".to_string());
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
        .map(|path| sh_quote(path))
        .unwrap_or_else(|| "''".to_string());
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
    fn cleanup_authorization_matches_settings_only_policy() {
        for operation in [
            CleanupOperation::RemoveApplicationData,
            CleanupOperation::RemoveDownloadedModels,
        ] {
            command_auth::assert_label_rules(
                &["settings"],
                &[
                    "main",
                    "overlay",
                    "tray-menu",
                    "model-picker",
                    "device-picker",
                    "history",
                    "onboarding",
                    "context-playground",
                ],
                |caller| is_cleanup_operation_allowed(caller, operation),
            );
        }
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
