//! WinSTT-owned STT backend boundary (audit action #14).
//!
//! The inherited Handy pipeline core (`crate::managers::transcription`) used to reach SIDEWAYS
//! into `crate::winstt::*` for every WinSTT-specific decision: catalog resolution, the unified
//! ort-ONNX engine build, the cloud-STT round-trip, the picker's language/dictionary/filler
//! settings, and the winstt-arm decode + post-processing. That broke the one-way dependency edge
//! the dual-manager boundary promises (`winstt/managers/mod.rs`: "these feature managers reuse the
//! core, never the reverse") and made upstream Handy merges of `transcription.rs` intractable.
//!
//! This trait re-homes all of that logic in the `winstt/` tree. The core keeps ONLY the
//! generic engine-lifecycle machinery (the `LoadedEngine` enum, the engine `Mutex`,
//! take/put-back + `catch_unwind` panic safety, poison recovery, the `is_loading`/`warming`
//! flags, the idle watcher, and the failure-atomic unload-AFTER-resolve ordering). It calls into
//! this trait — through a `dyn SttBackend` it holds by `Arc` — for every WinSTT-specific step,
//! so the only `crate::winstt::*` symbols `transcription.rs` names are this trait surface plus
//! the engine `Transcriber` type itself.
//!
//! ## Why a trait (not just free functions)
//! Object-safe + `Send` so the core can hold `Arc<dyn SttBackend>` and (in principle) swap a test
//! double. `WinsttSttBackend` is a zero-sized struct: it reaches every piece of WinSTT state via
//! the `&AppHandle` it's handed (settings store, `CloudSttManager` managed state) exactly as the
//! old inline code did.
//!
//! ## Risk invariants this boundary preserves (do NOT regress — see the audit notes)
//! 1. **Failure-atomic swap**: the load is TWO-PHASE (`resolve_catalog` → core unloads old →
//!    `build_resolved`). The offline resolve is the riskiest step that can fail without having
//!    torn anything down; the core only frees the old ORT session AFTER it succeeds. There are
//!    never two live ORT sessions (the Windows DLL-unload race forbids it).
//! 2. **Panic safety**: `decode` / `decode_realtime` / `warmup` take `&mut dyn Transcriber` on an
//!    engine the CORE already took out of the mutex inside `catch_unwind`. The backend MUST NOT
//!    lock the engine mutex, take/store the engine, or add a `Sync` bound.
//! 3. **No double post-processing**: `decode` does the winstt-arm post-processing (custom words +
//!    filler from `WinsttSettings`); the core therefore skips its generic transcribe-rs
//!    post-processing on the winstt arm. The transcribe-rs arms keep core post-processing.
//! 4. **Cloud nested-runtime branch** lives verbatim in `cloud_transcribe`.
//! 5/6. The `warming` flag / `try_lock` preemption and realtime poison recovery stay in core;
//!    only the decode/warmup BODIES move here. `peak_normalize` is applied ONLY to the winstt
//!    arm input (here), never to the transcribe-rs arms (those stay in core, unconditioned).

use crate::audio_toolkit::vad::{SileroVad, VAD_SPEECH_THRESHOLD};
use crate::audio_toolkit::{apply_custom_words, filter_transcription_output};
use crate::settings::get_settings;
use crate::winstt::stt::{EngineConfig, TranscribeOptions, Transcriber};
use anyhow::Result;
use tauri::{AppHandle, Manager};

/// Which load/decode path a model id routes to. Decided by id namespace (cloud prefix → catalog
/// lookup → neither). The core branches on this in `dispatch_load` / `transcribe`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendRoute {
    /// `<provider>:<id>` cloud STT id — no local engine; the core routes to `cloud_transcribe`.
    Cloud,
    /// A WinSTT-catalog id — loads through the unified ort engine (`resolve_catalog` +
    /// `build_resolved`).
    Catalog,
    /// Neither — a transcribe-rs (Handy `ModelManager`) id, handled entirely by the core.
    None,
}

/// A fully-prepared catalog load, produced by [`SttBackend::resolve_catalog`] and consumed by
/// [`SttBackend::build_resolved`]. It carries the offline-resolved [`EngineConfig`] (its
/// `resolved` field is the on-disk file set verified present with ZERO network) plus the bits the
/// core needs for its `model-state-changed` events. Splitting resolve from build is what lets the
/// core keep the exact "resolve offline FIRST, then unload the old engine, then build the new one"
/// ordering — the failure-atomic / no-two-live-ORT-sessions guarantee.
pub struct ResolvedSpec {
    /// Everything `winstt::stt::build_engine` needs (resolved file set + providers + flags).
    pub config: EngineConfig,
    /// The catalog id the user selected (echoed back into the load events).
    pub model_id: String,
    /// Human-facing display name (for the loading_started / loading_completed events).
    pub display_name: String,
}

/// The WinSTT-owned STT backend. The core holds this as `Arc<dyn SttBackend>` and never names any
/// other `crate::winstt::*` symbol (besides the `Transcriber` engine type). Object-safe + `Send +
/// Sync` — the bound is on the BACKEND, not the engine: `TranscriptionManager` is itself Tauri
/// managed state (`State<Arc<TranscriptionManager>>` requires `Send + Sync`), so the field
/// `Arc<dyn SttBackend>` must be `Sync`. This is safe because `WinsttSttBackend` is a zero-sized,
/// stateless struct (it holds no engine — the engine stays behind the core's mutex; the backend's
/// decode/realtime/warmup methods borrow `&mut dyn Transcriber` for the duration of one call and
/// never store it). See the module docs for the risk invariants every method preserves.
pub trait SttBackend: Send + Sync {
    /// Route a model id by namespace: cloud prefix → [`BackendRoute::Cloud`]; in the WinSTT
    /// catalog → [`BackendRoute::Catalog`]; neither → [`BackendRoute::None`] (a transcribe-rs id).
    fn route_of(&self, model_id: &str) -> BackendRoute;

    /// Best-effort display name for a model id: the catalog display name, else the raw id.
    fn display_name_for(&self, model_id: &str) -> String;

    /// The model id the user actually selected: the WinSTT picker
    /// (`WinsttSettings.model.model`) is the source of truth; `""` when unset (the core then
    /// falls back to Handy's `selected_model`).
    fn selected_model_id(&self, app: &AppHandle) -> String;

    /// The RAW picker language string (`WinsttSettings.model.language`; `""`/`"auto"` = auto).
    /// Language is owned by ONE store — this is its single source. The core validates it against
    /// the selected model's supported languages (a core / `model_manager` concern) for the
    /// transcribe-rs arms WITHOUT having to read `WinsttSettings` itself (audit #14).
    ///
    /// (Deliberately NOT named `selected_language` — the core's `transcription.rs` source-level
    /// guard test forbids that exact substring, which used to flag a dual AppSettings language
    /// read; this is the picker store, the single source of truth.)
    fn picker_language(&self, app: &AppHandle) -> String;

    /// PHASE 1 of a catalog load: resolve the on-disk file set OFFLINE-FIRST and assemble the
    /// [`EngineConfig`] — WITHOUT building any ORT session and WITHOUT touching the resident
    /// engine. Returning `Err` here leaves the previously-loaded model fully intact (the core
    /// re-emits its `loading_completed`).
    fn resolve_catalog(&self, app: &AppHandle, model_id: &str) -> Result<ResolvedSpec>;

    /// PHASE 2 of a catalog load: build the engine from a [`ResolvedSpec`]. The core calls this
    /// only AFTER it has unloaded the old engine (resolve already succeeded), so there are never
    /// two live ORT sessions. Returns the built engine + its display name.
    fn build_resolved(&self, spec: ResolvedSpec) -> Result<(Box<dyn Transcriber>, String)>;

    /// Decode ONE utterance on the winstt-arm engine + apply the WinSTT-arm post-processing
    /// (peak-normalize the input, then custom-words correction + filler filtering from
    /// `WinsttSettings`). Returns the FINAL text — the core must NOT run its generic transcribe-rs
    /// post-processing on this output. `engine` is borrowed `&mut` from inside the core's
    /// `catch_unwind`; this method must NOT lock the engine mutex.
    fn decode(
        &self,
        app: &AppHandle,
        engine: &mut dyn Transcriber,
        audio: &[f32],
    ) -> Result<String>;

    /// One realtime live-preview decode (RAW text, no post-processing) on the winstt-arm engine.
    /// Returns `None` on engine error. Peak-normalizes the input. Called from inside the core's
    /// realtime `catch_unwind`; must NOT lock the engine mutex.
    fn decode_realtime(
        &self,
        engine: &mut dyn Transcriber,
        audio: &[f32],
        language: Option<&str>,
    ) -> Option<String>;

    /// Warm the winstt-arm engine with a dummy 1s-silence decode so the first real PTT decode is
    /// not cold (DML kernel JIT). Best-effort: failures are swallowed. Called from inside the
    /// core's warmup `catch_unwind` on an engine the core `try_lock`'d; must NOT lock the mutex.
    fn warmup(&self, engine: &mut dyn Transcriber);

    /// The full cloud-STT round-trip for a `<provider>:<id>` model: ship the captured audio to
    /// the provider via `CloudSttManager`, then apply the WinSTT dictionary + filler
    /// post-processing (cloud is never Whisper). Owns the nested-runtime `block_in_place` /
    /// `block_on` branch.
    fn cloud_transcribe(&self, app: &AppHandle, model_id: &str, audio: &[f32]) -> Result<String>;

    /// Apply the WinSTT-picker post-processing (dictionary custom-words correction + filler /
    /// hallucination filtering, sourced from `WinsttSettings`) to a transcribe-rs (GGML) arm's RAW
    /// output. The WinSTT decode arm does this inside [`Self::decode`]; this is the transcribe-rs
    /// equivalent so the inherited core never has to read `WinsttSettings` itself (audit #14).
    /// `skip_custom_words` is the core's `is_whisper` gate (transcribe-rs Whisper already seeds
    /// custom words as its initial prompt, so re-correcting would double-apply them).
    fn postprocess_transcribe_rs(
        &self,
        app: &AppHandle,
        text: &str,
        skip_custom_words: bool,
    ) -> String;
}

/// Zero-sized impl of [`SttBackend`]. Reaches all WinSTT state via the `&AppHandle` params
/// (settings store, `CloudSttManager` managed state) — the same way the old inline core code did.
pub struct WinsttSttBackend;

impl SttBackend for WinsttSttBackend {
    fn route_of(&self, model_id: &str) -> BackendRoute {
        if crate::winstt::cloud_stt::provider_of(model_id).is_some() {
            BackendRoute::Cloud
        } else if crate::winstt::catalog::find(model_id).is_some() {
            BackendRoute::Catalog
        } else {
            BackendRoute::None
        }
    }

    fn display_name_for(&self, model_id: &str) -> String {
        crate::winstt::catalog::find(model_id)
            .map(|e| e.display_name.to_string())
            .unwrap_or_else(|| model_id.to_string())
    }

    fn selected_model_id(&self, app: &AppHandle) -> String {
        crate::winstt::commands::settings::read_settings(app)
            .model
            .model
    }

    fn picker_language(&self, app: &AppHandle) -> String {
        crate::winstt::commands::settings::read_settings(app)
            .model
            .language
    }

    fn resolve_catalog(&self, app: &AppHandle, model_id: &str) -> Result<ResolvedSpec> {
        use crate::winstt::catalog::Family;
        use crate::winstt::settings_schema::DeviceType;
        use crate::winstt::stt::resolver::{self, ResolveRequest};
        use crate::winstt::stt::{self, Accelerator, Quantization};

        let entry = crate::winstt::catalog::find(model_id)
            .ok_or_else(|| anyhow::anyhow!("model '{}' not in WinSTT catalog", model_id))?;
        let family_slug = family_policy_slug(entry.family);
        let kind = engine_kind_for(entry).ok_or_else(|| {
            anyhow::anyhow!(
                "model '{}' (family {:?}) has no Rust engine yet — only the Whisper family is wired",
                model_id,
                entry.family
            )
        })?;

        let settings = crate::winstt::commands::settings::read_settings(app);

        // device → primary accelerator (CPU vs the shipped GPU flavor)
        let primary = match settings.model.device {
            DeviceType::Cpu => Accelerator::Cpu,
            DeviceType::Auto => {
                if cfg!(windows) {
                    Accelerator::DirectMl
                } else {
                    Accelerator::Cpu
                }
            }
        };

        // requested quant from settings. The empty string `""` now means EXPLICIT fp32 (the
        // unsuffixed base export → Quantization::Default); the literal `"auto"` is the RAM/VRAM-aware
        // "recommended" sentinel. (They were previously conflated under the empty string.)
        let raw = settings.model.onnx_quantization.trim();
        let available: Vec<Quantization> = entry
            .available_quantizations
            .iter()
            .filter_map(|s| Quantization::parse(s))
            .collect();
        // AUTO ("auto") → RAM/VRAM-aware pick: the highest-accuracy quant that FITS the user's live
        // hardware (NOT a blind int8/fp32). A concrete user pick is respected verbatim (the picker
        // exposes every published quant off-CUDA, incl `""`=fp32). Footprint = param × bytes-per-param;
        // budget is the device the (engine, quant) runs on (VRAM for DML, available RAM for CPU).
        let effective = if raw.eq_ignore_ascii_case("auto") {
            let mut sys = sysinfo::System::new();
            sys.refresh_memory();
            let available_ram = sys.available_memory();
            let vram = crate::winstt::commands::runtime::detected_max_vram_bytes();
            stt::fit_aware_auto_quant(
                &available,
                kind,
                primary,
                entry.param_count,
                available_ram,
                vram,
            )
        } else {
            Quantization::parse(raw).unwrap_or(Quantization::Default) // "" → Default(fp32); "int8" → Int8; ...
        };

        // provider list (primary + CPU fallback), then the DML-incompatible-ENGINE override.
        // EngineKind-based (empirical), NOT family-based: parakeet-ctc/tdt/rnnt + gigaam + t-one
        // run 2-3× faster on DML; only the AED decoders (canary/cohere) + sherpa graphs
        // (kaldi/sense_voice/dolphin) are forced to CPU. See EngineKind::is_dml_incompatible.
        let providers = match primary {
            Accelerator::Cpu => vec![Accelerator::Cpu],
            other => vec![other, Accelerator::Cpu],
        };
        let providers = stt::override_dml_to_cpu_for_kind(providers, kind, effective);

        // resolve the on-disk file set (cache-first; one network refetch if a shard is missing).
        // OFFLINE-FIRST (`local_files_only: true`, no network, no ORT session) — the riskiest step
        // that can still fail without having torn anything down. The core only unloads the old
        // engine AFTER this returns Ok.
        let req = ResolveRequest {
            model_id: entry.onnx_model_name.to_string(),
            kind,
            effective_quant: effective,
            local_dir: None,
            local_files_only: true,
        };
        let resolved = tauri::async_runtime::block_on(resolver::resolve(&req))
            .map_err(|e| anyhow::anyhow!("resolve {}: {}", model_id, e))?;

        let whisper_fp16_workaround =
            matches!(entry.family, Family::Whisper) && effective == Quantization::Fp16;

        let config = EngineConfig {
            model_name: model_id.to_string(),
            family: family_slug.to_string(),
            kind,
            resolved,
            providers,
            whisper_fp16_workaround,
        };

        Ok(ResolvedSpec {
            config,
            model_id: model_id.to_string(),
            display_name: entry.display_name.to_string(),
        })
    }

    fn build_resolved(&self, spec: ResolvedSpec) -> Result<(Box<dyn Transcriber>, String)> {
        let display_name = spec.display_name;
        let model_id = spec.model_id;
        let engine = crate::winstt::stt::build_engine(spec.config)
            .map_err(|e| anyhow::anyhow!("build WinSTT engine for {}: {}", model_id, e))?;
        Ok((engine, display_name))
    }

    fn decode(
        &self,
        app: &AppHandle,
        engine: &mut dyn Transcriber,
        audio: &[f32],
    ) -> Result<String> {
        // Read the WinSTT settings tree ONCE for this decode (picker is the source of truth).
        let ws = crate::winstt::commands::settings::read_settings(app);

        // WinSTT engine inputs (language / translate / initial-prompt) come from the picker store.
        let initial_prompt_text = {
            let p = ws.model.initial_prompt.trim();
            if p.is_empty() {
                None
            } else {
                Some(p.to_string())
            }
        };
        let opts = TranscribeOptions {
            language: normalize_winstt_language(&ws.model.language),
            translate: ws.model.translate_to_english,
            initial_prompt_text,
            ..Default::default()
        };

        // Peak-normalize is the WinSTT-arm-ONLY audio-conditioning chokepoint (the transcribe-rs
        // arms in the core get RAW audio).
        let conditioned = peak_normalize(audio);
        // Long recordings would hit fixed per-decode windows (Whisper truncates at 30 s in mel.rs;
        // the AED decoders cap at ~1024 tokens) and silently drop everything past the cap. For
        // those, VAD-segment into ≤MAX_CHUNK_S chunks on silence boundaries and decode each
        // independently (whisperX / onnx-asr long-form). Short recordings — the common PTT case —
        // take the single-pass path unchanged, and the VAD model is only loaded when actually
        // needed (never for normal dictation).
        const MAX_CHUNK_S: f32 = 28.0; // headroom under Whisper's 30 s mel wall
        let transcribe_once = |engine: &mut dyn Transcriber| -> Result<String> {
            engine
                .transcribe(&conditioned, &opts)
                .map(|t| t.text)
                .map_err(|e| anyhow::anyhow!("WinSTT transcription failed: {}", e))
        };
        let text = if conditioned.len() > (MAX_CHUNK_S * 16_000.0) as usize {
            match build_segmentation_vad(app) {
                Ok(mut vad) => crate::winstt::stt::vad_segment::vad_segment_decode(
                    engine,
                    &conditioned,
                    MAX_CHUNK_S,
                    false, // independent per-chunk decode (whisperX/onnx-asr default)
                    &mut vad,
                    &opts,
                )
                .map_err(|e| anyhow::anyhow!("WinSTT VAD-segment transcription failed: {}", e))?,
                Err(e) => {
                    log::warn!(
                        "VAD-segment unavailable ({e}); single-pass decode (may truncate >30 s)"
                    );
                    transcribe_once(engine)?
                }
            }
        } else {
            transcribe_once(engine)?
        };

        // WinSTT-arm post-processing: custom-words correction + filler/hallucination filtering,
        // sourced from the SAME `ws` snapshot. The core does NOT re-run its generic transcribe-rs
        // post-processing on this output (avoids double-processing). Shared with the realtime-reuse
        // fast path (see `winstt_postprocess`) so a reused live decode gets byte-identical cleanup.
        let app_language = get_settings(app).app_language;
        Ok(winstt_postprocess(&text, &ws, &app_language))
    }

    fn decode_realtime(
        &self,
        engine: &mut dyn Transcriber,
        audio: &[f32],
        language: Option<&str>,
    ) -> Option<String> {
        // Pass the CONFIGURED language so multilingual Whisper doesn't run a 3-token
        // language-DETECT every realtime tick. `None`/empty still auto-detects.
        let opts = TranscribeOptions {
            language: language.map(str::to_string),
            ..Default::default()
        };
        let conditioned = peak_normalize(audio);
        engine.transcribe(&conditioned, &opts).ok().map(|t| t.text)
    }

    fn warmup(&self, engine: &mut dyn Transcriber) {
        // Decode dummy silence DIRECTLY (the core bypasses the RMS silence-gate for this).
        let dummy = vec![0.0f32; 16_000];
        let conditioned = peak_normalize(&dummy);
        let _ = engine.transcribe(&conditioned, &TranscribeOptions::default());
    }

    fn cloud_transcribe(&self, app: &AppHandle, model_id: &str, audio: &[f32]) -> Result<String> {
        // When the selected model carries a cloud prefix (openai:/elevenlabs:), there is NO local
        // engine — ship the captured audio to the provider via CloudSttManager.
        let ws = crate::winstt::commands::settings::read_settings(app);
        let cloud = app
            .state::<std::sync::Arc<crate::winstt::managers::CloudSttManager>>()
            .inner()
            .clone();
        let language = normalize_winstt_language(&ws.model.language);
        let app_language = get_settings(app).app_language;

        // `transcribe()` is SYNC. When it's called from a tokio worker (actions.rs `spawn(async)`
        // → a multi-thread runtime worker), a bare `block_on` panics "Cannot start a runtime from
        // within a runtime"; we must `block_in_place` to hand the worker thread back to the pool
        // while we block on the cloud round-trip. But when it's called from a plain `std::thread`
        // (the loopback consumer), there is NO ambient runtime — `block_in_place` itself would
        // panic, and a bare `block_on` is correct. Branch on whether we're inside a runtime.
        // (See the same hazard documented at resolver.rs:582-585.)
        let cloud_fut = cloud.transcribe_samples(model_id, audio, language);
        let result = if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| tauri::async_runtime::block_on(cloud_fut))
        } else {
            tauri::async_runtime::block_on(cloud_fut)
        };
        let text = result.map_err(|e| {
            anyhow::anyhow!("Cloud STT failed ({}): {}", e.code.as_str(), e.message)
        })?;

        // Cloud is never Whisper → apply the WinSTT dictionary correction + filler filter.
        let dict: Vec<String> = ws
            .dictionary
            .iter()
            .map(|d| d.term.clone())
            .filter(|t| !t.trim().is_empty())
            .collect();
        let corrected = if dict.is_empty() {
            text
        } else {
            apply_custom_words(&text, &dict, ws.general.word_correction_threshold)
        };
        let filler = if ws.general.filter_fillers && !ws.general.custom_filler_words.is_empty() {
            Some(ws.general.custom_filler_words.clone())
        } else if ws.general.filter_fillers {
            None
        } else {
            Some(Vec::new())
        };
        Ok(filter_transcription_output(
            &corrected,
            &app_language,
            &filler,
        ))
    }

    fn postprocess_transcribe_rs(
        &self,
        app: &AppHandle,
        text: &str,
        skip_custom_words: bool,
    ) -> String {
        // WinSTT dictionary bridge: the picker's dictionary (custom words) + fuzzy threshold +
        // filler list live in the WinSTT settings store, NOT Handy's `settings.custom_words`
        // (mirrors the reference set_parameter forwarding custom_words/threshold/filler to the recorder).
        let ws = crate::winstt::commands::settings::read_settings(app);
        let custom_words: Vec<String> = ws
            .dictionary
            .iter()
            .map(|d| d.term.clone())
            .filter(|t| !t.trim().is_empty())
            .collect();

        // Apply word correction if custom words are configured. Skip for (transcribe-rs) Whisper
        // since those custom words are already passed as the initial_prompt by the core.
        let corrected = if !custom_words.is_empty() && !skip_custom_words {
            apply_custom_words(text, &custom_words, ws.general.word_correction_threshold)
        } else {
            text.to_string()
        };

        // filter_fillers off → Some([]) (no patterns); on+empty → None (language default table).
        let filler: Option<Vec<String>> = if ws.general.filter_fillers {
            if ws.general.custom_filler_words.is_empty() {
                None
            } else {
                Some(ws.general.custom_filler_words.clone())
            }
        } else {
            Some(Vec::new())
        };
        let app_language = get_settings(app).app_language;
        filter_transcription_output(&corrected, &app_language, &filler)
    }
}

// ---------------------------------------------------------------------------
// WinSTT-private helpers (moved verbatim out of the core's transcription.rs).
// ---------------------------------------------------------------------------

/// Catalog family → engine decode archetype. Returns `None` for families whose engine isn't
/// dispatched / validated yet so the swap surfaces a precise error instead of silently doing
/// nothing.
fn engine_kind_for(
    entry: &crate::winstt::catalog::ModelEntry,
) -> Option<crate::winstt::stt::EngineKind> {
    use crate::winstt::stt::EngineKind;
    let kind = crate::winstt::stt::cache_probe::engine_kind_for(
        entry.id,
        family_policy_slug(entry.family),
        entry.onnx_model_name,
    );
    // Gate on the resolved ENGINE KIND (not just family) — `Family::Nemo` spans both the
    // validated Canary (NemoAed) and the still-unvalidated parakeet CTC/TDT, so kind-level
    // gating lets Canary go live while parakeet stays disabled. Only kinds whose ONNX
    // numerics are spike-proven (transcribe JFK correctly) are enabled; the rest return a
    // clean "no Rust engine yet" error instead of silent garbage.
    let validated = matches!(
        kind,
        EngineKind::WhisperHf
            | EngineKind::Moonshine
            | EngineKind::SenseVoiceCtc
            | EngineKind::NemoAed
            | EngineKind::NemoCtc
            | EngineKind::NemoTdt
            | EngineKind::NemoRnnt
            | EngineKind::CohereAsr
            | EngineKind::KaldiTransducer
            | EngineKind::DolphinCtc
            | EngineKind::GigaamCtc
            | EngineKind::GigaamRnnt
            | EngineKind::ToneCtc
            | EngineKind::NemoCtcStreaming
            | EngineKind::NemoRnntStreaming
            | EngineKind::KaldiTransducerStreaming
    );
    if validated {
        Some(kind)
    } else {
        None
    }
}

/// Catalog family → the policy slug string passed to quantization resolution. Provider routing is
/// engine-kind based (`override_dml_to_cpu_for_kind`) after the concrete engine is resolved.
fn family_policy_slug(family: crate::winstt::catalog::Family) -> &'static str {
    use crate::winstt::catalog::Family;
    match family {
        Family::Whisper => "whisper",
        Family::Moonshine => "moonshine",
        Family::Cohere => "cohere",
        Family::Nemo => "nemo",
        Family::SenseVoice => "sense_voice",
        Family::GigaAm => "gigaam",
        Family::Kaldi => "kaldi",
        Family::TOne => "t-one",
        Family::Dolphin => "dolphin",
        Family::Custom => "custom",
    }
}

/// Normalize the WinSTT picker's language string to the engine wire form: empty / "auto" →
/// `None` (auto-detect); the two Chinese script tags map to the base "zh" the engines understand;
/// everything else passes through. This is the SINGLE language source every decode reads.
fn normalize_winstt_language(raw: &str) -> Option<String> {
    let l = raw.trim();
    if l.is_empty() || l == "auto" {
        None
    } else if l == "zh-Hans" || l == "zh-Hant" {
        Some("zh".to_string())
    } else {
        Some(l.to_string())
    }
}

/// Peak-normalize to 0.95 — the single audio-conditioning chokepoint the WinSTT engines expect
/// (mirrors Python `_peak_normalize`; the `Transcriber` contract says the caller conditions).
fn peak_normalize(audio: &[f32]) -> Vec<f32> {
    let peak = audio.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if peak <= 0.0 {
        return audio.to_vec();
    }
    let g = 0.95 / peak;
    audio.iter().map(|&x| x * g).collect()
}

/// Build a one-shot Silero VAD for offline FINAL-decode segmentation (long recordings only). This
/// is a SEPARATE instance from the recorder's live VAD — segmentation runs over the already-
/// captured buffer, not the realtime stream — and resolves the same bundled model the recorder
/// uses (managers/audio.rs). Built lazily so normal short-PTT dictation never pays the load.
fn build_segmentation_vad(app: &AppHandle) -> Result<SileroVad> {
    let path = app
        .path()
        .resolve(
            "resources/models/silero_vad_v4.onnx",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| anyhow::anyhow!("resolve VAD path: {e}"))?;
    SileroVad::new(&path, VAD_SPEECH_THRESHOLD)
}

/// Apply the WinSTT-arm text post-processing — custom-words fuzzy correction + filler/
/// hallucination filtering — to an ALREADY-decoded transcript. Factored out of `decode` so the
/// realtime-reuse fast path (the final paste reusing the realtime worker's last full-buffer
/// decode) applies byte-identical cleanup. `ws` + `app_language` are passed in so callers that
/// already hold a settings snapshot don't pay a second `read_settings` (secret-decrypt) hit.
pub(crate) fn winstt_postprocess(
    text: &str,
    ws: &crate::winstt::settings_schema::WinsttSettings,
    app_language: &str,
) -> String {
    let custom_words: Vec<String> = ws
        .dictionary
        .iter()
        .map(|d| d.term.clone())
        .filter(|t| !t.trim().is_empty())
        .collect();
    let corrected = if custom_words.is_empty() {
        text.to_string()
    } else {
        apply_custom_words(text, &custom_words, ws.general.word_correction_threshold)
    };
    // filter_fillers off → Some([]) (no patterns); on+empty → None (language default table).
    let filler: Option<Vec<String>> = if ws.general.filter_fillers {
        if ws.general.custom_filler_words.is_empty() {
            None
        } else {
            Some(ws.general.custom_filler_words.clone())
        }
    } else {
        Some(Vec::new())
    };
    filter_transcription_output(&corrected, app_language, &filler)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winstt_language_normalizes_to_engine_wire_form() {
        // Empty / auto → auto-detect (None).
        assert_eq!(normalize_winstt_language(""), None);
        assert_eq!(normalize_winstt_language("  "), None);
        assert_eq!(normalize_winstt_language("auto"), None);
        // Chinese script tags collapse to the base "zh" the engines understand.
        assert_eq!(normalize_winstt_language("zh-Hans"), Some("zh".to_string()));
        assert_eq!(normalize_winstt_language("zh-Hant"), Some("zh".to_string()));
        // Everything else passes through (trimmed).
        assert_eq!(normalize_winstt_language("en"), Some("en".to_string()));
        assert_eq!(normalize_winstt_language(" fr "), Some("fr".to_string()));
    }

    #[test]
    fn peak_normalize_scales_to_095() {
        // Silence stays silent (no division by zero).
        assert_eq!(peak_normalize(&[0.0, 0.0]), vec![0.0, 0.0]);
        // Peak is scaled to 0.95 and the ratio between samples is preserved.
        let out = peak_normalize(&[0.5, -0.25]);
        assert!((out[0] - 0.95).abs() < 1e-6);
        assert!((out[1] - (-0.475)).abs() < 1e-6);
    }
}
