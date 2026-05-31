

################################################################################
# AGENT: file_transcribe  (status=implemented)
FILES_EDITED: ['E:\\DL\\Projects\\WinSTT\\app\\src-tauri\\src\\winstt\\managers\\file_transcribe_manager.rs']

## CARGO_ADDITIONS
REQUIRED — Cargo.toml line 88 is missing the PCM/ADPCM codec features, so WAV files (the most common drag-drop case) would fail to decode with "no decoder for audio codec". The `wav` feature only registers the WavReader DEMUXER; the actual sample codec (PcmDecoder) is gated behind a separate `pcm` feature, and the `default` feature set pairs `wav` with both `pcm` and `adpcm`. Change line 88 from:
    symphonia = { version = "0.6.0", default-features = false, features = ["wav", "mp3", "isomp4", "aac", "flac", "ogg", "vorbis"] }  # file-transcribe decode
to:
    symphonia = { version = "0.6.0", default-features = false, features = ["wav", "pcm", "adpcm", "mp3", "isomp4", "aac", "flac", "ogg", "vorbis"] }  # file-transcribe decode
(`pcm` = standard PCM WAV decoding; `adpcm` = ADPCM-coded WAV. Without `pcm`, WAV decode returns an error row.)

## LIB_MOD_REGISTRATION
none — module is already declared (src/winstt/managers/mod.rs:23 `pub mod file_transcribe_manager;` + re-export at :33) and FileTranscribeManager is already instantiated in lib.rs:187. No new commands or registrations needed; the change is confined to the owned file's private `decode_audio_to_pcm` helper.

## SUMMARY
Implemented decode_audio_to_pcm() in file_transcribe_manager.rs, replacing the "not yet wired" stub. It mirrors the Python server's _decode_media_to_pcm (ffmpeg -f f32le -ac 1 -ar 16000) but in-process via symphonia 0.6.0: open file → MediaSourceStream → get_probe().probe() with an extension Hint → default_track(TrackType::Audio) → get_codecs().make_audio_decoder() → loop next_packet() (Result<Option<Packet>>) filtering by track_id → decoder.decode() → copy_to_vec_interleaved::<f32>() → average-downmix to mono (matches np.mean axis=1 / -ac 1) → accumulate. Then resample the mono buffer from the source rate (read from the decoded AudioSpec) to 16kHz via the project's recording-grade FftFixedIn resampler (FrameResampler), with a 16kHz fast-path that skips resampling entirely. Robust to arbitrary sample rates/channel layouts; per-packet DecodeErrors are skipped (resync), EOF (Ok(None) or UnexpectedEof IoError) and ResetRequired end the loop cleanly, empty/undecodable audio returns an error row. Removed all SPIKE comments. NOTE: requires adding `pcm`+`adpcm` to the symphonia features in Cargo.toml (shared file) for WAV to decode — see cargo_additions.

## RISK
low–medium. Logic is self-contained, written against the verified symphonia 0.6.0 + rubato 0.16.2 APIs (read from .cargo source); reuses the project's existing FrameResampler (recording-resample-quality FftFixedIn). MAIN RISK: the Cargo.toml feature gap above — if `pcm` is not added, every WAV file errors out (other formats mp3/m4a/flac/ogg/aac still work). Could not compile (no MSVC). Minor: FrameResampler zero-pads the final partial frame (≤30ms trailing silence) only on the resample path; the no-op 16kHz path returns the buffer untouched. ALAC-in-mp4 (rare) is unsupported unless `alac` is also added — not required for parity since the Python ffmpeg path's common cases are covered.



################################################################################
# AGENT: transforms  (status=implemented)
FILES_EDITED: ['E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/commands/transforms.rs']

## CARGO_ADDITIONS
none — enigo (0.6.1), tauri-plugin-clipboard-manager (2.3.2) and log (0.4.25) are all already in Cargo.toml.

## LIB_MOD_REGISTRATION
none — `apply_transform` and `apply_transform_preview` are already in collect_commands! in lib.rs (lines 555-556) and `pub mod transforms;` is already declared in winstt/commands/mod.rs (line 125). The `apply_transform` SIGNATURE changed (now takes only `app: AppHandle`; the `llm_manager`/`context` State params were removed and resolved internally via try_state so the same function serves the hotkey path), but the collect_commands! registration line is unchanged — specta re-derives the zero-arg binding, which matches the renderer's `applyTransform()` zero-arg call.

## SUMMARY
Made transforms.rs a complete, provider-aware implementation. apply_transform + apply_transform_preview now route to the CONFIGURED provider (Ollama streaming / OpenRouter structured-output with fallback model / Apple-Intelligence soft-fail) instead of hardcoding ollama_transform — mirroring llm.rs::process_transform → runProcessText exactly. Added a new `run_transform_provider` + `run_openrouter_with_fallback` and a public `run_transform_pipeline(app)` shared by the command and the global hotkey. Replaced the SPIKE selection-capture with the real clipboard-sandwich fallback (save clipboard → synthetic Ctrl+C via managed Enigo → 700ms/25ms poll for change → restore original clipboard) behind the side-effect-free UIA `--selection` primary path, matching selection-capture.ts constants. apply_transform_preview now also honors the provider (incl. an explicit Playground config override via a new parse_provider). For the missing global hotkey (transforms.hotkey, default LCtrl+LShift+T), I cannot edit shared files, so I exposed run_transform_pipeline as a public fn and returned exact shared_file_instructions to: add a TransformAction to ACTION_MAP (actions.rs), seed a default `transforms` ShortcutBinding (settings.rs), and arm/disarm it from llm.transforms.hotkey gated on llm.transforms.enabled in lib.rs setup (mirroring transform-hotkeys.ts). Added unit tests for the apple-intelligence gate and parse_provider.

## RISK
Medium. (1) apply_transform's command signature changed from (app, llm_manager: State, context: State) -> (app); specta will regenerate the TS binding with no args (renderer already calls applyTransform() with no args, so compatible), but the integrator must regenerate tauri-specta bindings. (2) The clipboard-sandwich sends a real synthetic Ctrl+C via the managed EnigoState — if EnigoState isn't initialized it logs+falls through to empty (safe). The 700ms poll runs on spawn_blocking so the async pump isn't stalled. (3) UIA selection-capture depends on the winstt-context sidecar being present; absent it, only the clipboard fallback runs (matches Electron). (4) The global-hotkey wiring is in SHARED files (actions.rs/settings.rs/lib.rs) — I could not compile it; the TransformAction/ACTION_MAP/binding-default/setup-hook edits are exact but unverified against the live build. (5) The `transforms` binding uses the Tauri global-shortcut impl which requires a non-modifier key — LCtrl+LShift+T satisfies that (validate_shortcut passes).

### SHARED_EDIT[0] FILE: E:/DL/Projects/WinSTT/app/src-tauri/src/actions.rs
ANCHOR:
// Test Action
struct TestAction;
CHANGE:
INSERT a new TransformAction ABOVE the `// Test Action` block (and register it in ACTION_MAP below). The action fires the same end-to-end pipeline the IPC command + renderer use, so the hotkey and the toolbar button are byte-identical.

// Transform Action (WinSTT transforms.hotkey, default LCtrl+LShift+T)
struct TransformAction;

impl ShortcutAction for TransformAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Single-shot per press: capture selection -> transform over the
        // configured provider -> paste-replace -> emit transforms:applied.
        // run_transform_pipeline does its own enabled-gate + failure events,
        // and NEVER errors past its boundary. Spawn on the async runtime so the
        // global-shortcut callback thread is not blocked by the LLM round-trip.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::winstt::commands::transforms::run_transform_pipeline(&app).await;
        });
    }
    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Transforms is single-shot on press; nothing to do on release.
    }
}

Then, inside `pub static ACTION_MAP: Lazy<...> = Lazy::new(|| {`, add this entry next to the existing `map.insert("test"...)` lines (before `map` is returned):

    map.insert(
        "transforms".to_string(),
        Arc::new(TransformAction) as Arc<dyn ShortcutAction>,
    );

NOTE: handler.rs::handle_shortcut_event already routes any non-transcribe / non-cancel binding through the default branch (`action.start` on press, `action.stop` on release), so NO edit to shortcut/handler.rs or transcription_coordinator.rs is needed — the `"transforms"` binding id will dispatch automatically.

### SHARED_EDIT[1] FILE: E:/DL/Projects/WinSTT/app/src-tauri/src/settings.rs
ANCHOR:
    bindings.insert(
        "cancel".to_string(),
        ShortcutBinding {
CHANGE:
Register a default `"transforms"` binding so the Handy registry can (un)register the transforms accelerator via change_binding/register_shortcut. INSERT this block immediately BEFORE the existing `bindings.insert("cancel"...)` block inside `get_default_settings()`:

    bindings.insert(
        "transforms".to_string(),
        ShortcutBinding {
            id: "transforms".to_string(),
            name: "Transform Selection".to_string(),
            description: "Rewrites the selected text with the configured LLM.".to_string(),
            // WinSTT key string; handy-keys' parser accepts it verbatim. Mirrors
            // settings_schema LlmTransforms::default_hotkey ("LCtrl+LShift+T").
            default_binding: "LCtrl+LShift+T".to_string(),
            current_binding: "LCtrl+LShift+T".to_string(),
        },
    );

NB: tauri_impl::init_shortcuts auto-registers every default binding except `cancel`, so this row is registered at startup. The accelerator VALUE is kept in sync with the WinSTT setting `llm.transforms.hotkey` by the lib.rs hook below (the binding registry default is only the cold-boot fallback).

### SHARED_EDIT[2] FILE: E:/DL/Projects/WinSTT/app/src-tauri/src/lib.rs
ANCHOR:
            initialize_core_logic(&app_handle);
CHANGE:
Add a startup hook that points the `"transforms"` binding at the user's CURRENT `llm.transforms.hotkey` and arms it only when the feature is enabled (mirrors transform-hotkeys.ts loadHotkey/rebuildCombo: a disabled feature must NOT capture the common LCtrl+LShift+T combo). INSERT immediately AFTER the `initialize_core_logic(&app_handle);` line inside the `.setup(...)` closure:

            // WinSTT transforms global hotkey: arm `llm.transforms.hotkey` only
            // while the feature is enabled (mirrors transform-hotkeys.ts). The
            // accelerator lives in the WinSTT settings tree, NOT Handy's binding
            // registry, so re-point the `transforms` binding at it here.
            {
                let ws = crate::winstt::commands::settings::read_settings(&app_handle);
                let t = &ws.llm.transforms;
                let hotkey = t.hotkey.trim().to_string();
                if t.enabled && !hotkey.is_empty() {
                    if let Err(e) = crate::shortcut::change_binding(
                        app_handle.clone(),
                        "transforms".to_string(),
                        hotkey,
                    ) {
                        log::warn!("Failed to register transforms hotkey: {e}");
                    }
                } else {
                    // Feature off / no hotkey: ensure the default-registered
                    // binding is dropped so the combo is not captured.
                    let b = crate::settings::get_stored_binding(&app_handle, "transforms");
                    let _ = crate::shortcut::unregister_shortcut(&app_handle, b);
                }
            }

OPTIONAL (live re-arm without restart): to re-register when the user toggles the feature / rebinds the hotkey, add an `app.listen("settings:changed", ...)` (the event winstt_set_settings already emits) that re-runs the same read_settings -> change_binding/unregister_shortcut block. Not required for parity (a relaunch picks up the new value), but matches the Electron onDidChange("llm") re-arm. The hotkey string is gated on equality there to avoid churn; here change_binding is idempotent enough to call unconditionally.

NOTE: change_binding + get_stored_binding + unregister_shortcut are already `pub` in src/shortcut and src/settings; read_settings is `pub` in winstt::commands::settings. No new imports needed beyond fully-qualified paths shown.



################################################################################
# AGENT: wakeword  (status=implemented)
FILES_EDITED: ['E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/wakeword.rs', 'E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/managers/wakeword_manager.rs']

## CARGO_ADDITIONS
none — sherpa-onnx 1.13.2 is already an UNCONDITIONAL dep (linked as a shared DLL). There is NO `sherpa` cargo feature and `[features]` does not exist in Cargo.toml; the prior `#[cfg(feature = \"sherpa\")]` gates in wakeword_manager.rs were dead (always-false) and have been removed so the detector compiles unconditionally. Do NOT add a `sherpa` feature.

## LIB_MOD_REGISTRATION
none — no new commands, modules, or state. `WakeWordManager::new(app_handle)` (single-arg) is ALREADY managed in lib.rs L183 and `WakeWordDetectedPayload` is ALREADY registered (lib.rs L578, defined in winstt/commands/events.rs — the manager reuses that canonical payload rather than defining a duplicate). The commands `set_wake_word` / `list_wake_word_presets` are already in collect_commands. The only new wiring is the event listener for `wake_word_detected` and the arm/disarm + chunk-tap, all covered in shared_file_instructions.

## SUMMARY
Made wakeword.rs + wakeword_manager.rs real and complete. wakeword.rs: kept the already-correct sherpa-onnx 1.13.2 KeywordSpotter WakeWordDetector (verified vs installed crate src — create/create_stream_with_keywords/accept_waveform/is_ready/decode/get_result/reset all match), and ADDED the missing bridge between resolve_phrase and the engine: tokenize_phrase (verified BPE map for the 6 multi-word presets + an always-in-vocab char fallback), build_keyword_content (assembles `<tokens> #<threshold> @<label>`), KwsModelPaths::from_bundle_dir/all_present + the gigaspeech bundle file-name constants, plus tests. wakeword_manager.rs: removed all dead `#[cfg(feature=\"sherpa\")]` gates (no such feature exists), made the `detector` field + feed_chunk + set_armed unconditional, and IMPLEMENTED rebuild_detector for real — resolves the KWS bundle under app_data_dir/wakeword/, builds the inline keyword content from the resolved phrase + sensitivity, picks the sherpa provider from model.device, and stands up WakeWordDetector::new (fail-soft to inert None when the wake word is disabled or the model isn't downloaded yet). feed_chunk runs detection on 16k f32 chunks, honors set_armed (resets streaming state on arm to avoid phantom first-chunk hits), drops the lock before emitting, and fires the canonical `wake_word_detected` event (reusing events.rs WakeWordDetectedPayload, not a duplicate). The manager also syncs from settings on construction. Remaining integrator work (shared files): a raw-16k chunk tap in audio_toolkit run_consumer → managers/audio.rs calls feed_chunk; arm/disarm on recordingMode==wakeword; and a `wake_word_detected` listener that starts dictation via the coordinator (toggle-press of \"transcribe\").

## RISK
MEDIUM. (1) The KWS keyword tokenization uses a verified BPE map for the 6 multi-word presets plus a CHARACTER-level fallback (▁<C0> C1 C2 …) for everything else (incl. single-word presets like \"alexa\" and custom phrases). Char tokens are guaranteed in the gigaspeech BPE tokens.txt so a line is NEVER OOV-rejected (sherpa drops the whole keyword on any OOV token — utils.cc EncodeBase), but char-split is not bit-identical to SentencePiece, so recall/precision for single-word presets may differ slightly from a true text2token run; it still detects. If a real `sherpa-onnx-cli text2token` step is wired later, feed its output via `build_keywords_file(specs)` and the engine path is unchanged. (2) The detector only builds when the gigaspeech bundle (encoder/decoder/joiner-epoch-12-avg-2-chunk-16-left-64.onnx + tokens.txt) is present under app_data_dir/wakeword/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/ — the DownloadManager must fetch+extract it (that bundle is a GitHub-release .tar.bz2, not HF; a separate download-wiring task). Until then feed_chunk is a safe no-op. (3) I could not compile (MSVC); the sherpa-onnx 1.13.2 KeywordSpotter/OnlineModelConfig API was verified against the installed crate source under .cargo, and the keyword/OOV/EncodeKeywords contract against the vendored examples/sherpa-onnx C++ + python text2token. (4) The audio chunk-tap edit to the shared run_consumer is essential — without it feed_chunk is never called.

### SHARED_EDIT[0] FILE: app/src-tauri/src/audio_toolkit/audio/recorder.rs
ANCHOR:
pub fn with_level_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(Vec<f32>) + Send + Sync + 'static,
    {
        self.level_cb = Some(Arc::new(cb));
        self
    }
CHANGE:
ADD a raw-16k-chunk tap so the wakeword detector can see the SAME resampled frames the recorder consumer sees (spec 05_*.md L124-126). 1) Add a field to the struct `AudioRecorder`: `chunk_cb: Option<Arc<dyn Fn(&[f32]) + Send + Sync + 'static>>,` and init it `chunk_cb: None,` in `AudioRecorder::new()`. 2) Add a builder right after `with_level_callback`:
```rust
    pub fn with_chunk_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(&[f32]) + Send + Sync + 'static,
    {
        self.chunk_cb = Some(Arc::new(cb));
        self
    }
```
3) In `open()`, clone it next to `let level_cb = self.level_cb.clone();` → `let chunk_cb = self.chunk_cb.clone();` and pass it into the `run_consumer(...)` call (add a param). 4) Change `fn run_consumer(...)` signature to take `chunk_cb: Option<Arc<dyn Fn(&[f32]) + Send + Sync + 'static>>,` and INSIDE the existing `frame_resampler.push(&raw, &mut |frame: &[f32]| { ... })` closure (the one calling `handle_frame`), ALSO call the tap on every 16k frame UNCONDITIONALLY (independent of `recording`, so wakeword listens while idle): `if let Some(cb) = &chunk_cb { cb(frame); }`. The `frame` slice is already mono f32 at WHISPER_SAMPLE_RATE (16000).

### SHARED_EDIT[1] FILE: app/src-tauri/src/managers/audio.rs
ANCHOR:
fn create_audio_recorder(
    vad_path: &str,
    app_handle: &tauri::AppHandle,
) -> Result<AudioRecorder, anyhow::Error> {
CHANGE:
Wire the new chunk tap to the WakeWordManager.feed_chunk so detection runs on the live mic. After the existing `.with_level_callback({...})` builder call on the `AudioRecorder`, chain `.with_chunk_callback({ let app_handle = app_handle.clone(); move |frame: &[f32]| { if let Some(wm) = app_handle.try_state::<std::sync::Arc<crate::winstt::managers::WakeWordManager>>() { let _ = wm.feed_chunk(frame); } } })`. `feed_chunk` is internally gated: it no-ops unless `is_armed()` AND a detector is built, so this tap is free when wakeword mode is off. (Add `use tauri::Manager;` if not already in scope for `try_state`.)

### SHARED_EDIT[2] FILE: app/src-tauri/src/actions.rs
ANCHOR:
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
CHANGE:
Add the wakeword-mode lifecycle + the on-detect dictation start. 1) Add a free fn callable from a `wake_word_detected` event listener:
```rust
pub fn start_dictation_from_wakeword(app: &AppHandle) {
    // A wake-word hit acts exactly like a toggle-press of the transcribe action:
    // begins one recording cycle that the recorder's silence-endpoint stops.
    if let Some(coord) = app.try_state::<crate::TranscriptionCoordinator>() {
        coord.send_input("transcribe", "", true, false);
    }
}
```
2) In `initialize_core_logic` (lib.rs) OR an existing setup hook, install a once listener: `app_handle.listen("wake_word_detected", move |_| start_dictation_from_wakeword(&app_handle_clone));` (use `tauri::Listener`). 3) When `general.recordingMode == wakeword` is entered, call `wm.set_armed(true)` AND ensure the mic stream is open continuously (`AudioRecordingManager::start_microphone_stream`) so the chunk tap flows; on leaving wakeword mode call `wm.set_armed(false)`. The renderer already toggles recordingMode; arm/disarm should hang off that same path (e.g. in the settings-apply handler that sees `general.recordingMode` change, fetch `app.state::<Arc<WakeWordManager>>()` and `.set_armed(mode == wakeword)` + `.sync_from_settings()`).

### SHARED_EDIT[3] FILE: app/src-tauri/src/transcription_coordinator.rs
ANCHOR:
pub fn notify_processing_finished(&self) {
CHANGE:
OPTIONAL convenience (only if you prefer not to call send_input directly from actions): add `pub fn start_dictation(&self) { self.send_input("transcribe", "", true, false); }` so the wakeword path has a named entrypoint. No behavior change — it just wraps the existing `send_input` toggle-press used by `start_dictation_from_wakeword`.



################################################################################
# AGENT: loopback  (status=implemented)
FILES_EDITED: ['E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/loopback.rs', 'E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/managers/loopback_manager.rs']

## CARGO_ADDITIONS
none — `wasapi = "0.23.0"` is already present under `[target.'cfg(windows)'.dependencies]` in app/src-tauri/Cargo.toml. All other crates used (anyhow, thiserror, log, tauri, plus internal audio_toolkit FrameResampler/SileroVad) are already deps. The wasapi 0.23.0 source is vendored at C:/Users/MASTE/.cargo/registry/src/.../wasapi-0.23.0 and all APIs used were verified against it.

## LIB_MOD_REGISTRATION
none — `winstt::loopback` and `winstt::managers::loopback_manager` are already registered (winstt/mod.rs:62 `pub mod loopback;`, winstt/managers/mod.rs:21 `pub mod loopback_manager;` + re-export). `LoopbackManager` is already `.manage(Arc::new(...))`-ed in lib.rs:185, and the `start_listen`/`stop_listen` commands (winstt/commands/listen.rs) that drive `LoopbackManager::start()`/`stop()` are already collected. The public method signatures (`LoopbackManager::new(&AppHandle)`, `start(&self) -> Result<(), String>`, `stop(&self)`, `is_capturing`, `app`) are UNCHANGED, so no call-site edits are needed.

## SUMMARY
Replaced the loopback stub (which only flipped a `capturing` atomic) with a real WASAPI loopback pipeline. loopback.rs: LoopbackCapture::start() opens the default render endpoint in shared-mode loopback (render device + Direction::Capture, EventsShared), spawns a daemon capture thread that drains the WASAPI event-driven buffer, folds to mono, applies the slow-tracking AGC in the int16 domain (TARGET_PEAK=8000/MAX_GAIN=30/NOISE_FLOOR=50/GAIN_SMOOTH=0.05, verbatim from loopback.py — including the load-bearing silence-decay branch), resamples device-rate→16kHz mono via FrameResampler emitting 30ms frames, and delivers f32 chunks over an mpsc Sender. COM is initialized MTA via an RAII ComGuard that only deinitializes an apartment it actually entered (handles RPC_E_CHANGED_MODE). start() is non-blocking and stop() flips an atomic + joins (bounded by the 200ms event-wait timeout) — never stalling the async loop. loopback_manager.rs: LoopbackManager now owns the LoopbackCapture + a consumer/transcription thread. start() kicks off the ASR model load (like mic dictation), opens capture, and spawns a thread that VAD-gates the 16kHz f32 stream with a real SileroVad (0.3 threshold), accumulates speech, and on a 2.0s sustained-silence endpoint flushes the utterance to the shared TranscriptionManager, emits stt:transcription-start/full-sentence (or no-audio-detected/transcription-failed), runs diarization (emitting stt:speaker-segments AFTER the sentence per the relay ordering contract), and pastes — plus per-chunk stt:audio-level for the visualizer. stop() is idempotent and serialized; Drop stops cleanly. The dead SlowAgc f32 stub was removed in favor of the Python-faithful int16 SlowTrackingAgc. No SHARED files needed changes — existing listen.rs/loopback.rs commands and lib.rs wiring drive it unchanged.

## RISK
Cannot compile here (needs MSVC + ~6 min). Wrote against the real wasapi 0.23.0 / windows-result 0.4.1 / tauri 2.10.2 APIs (read from .cargo source): verified initialize_mta()->HRESULT (used via .ok().is_ok()), initialize_client takes &mut self (binding made mut), the (Render device + Direction::Capture + Shared) loopback combo is explicitly supported, read_from_device_to_deque/wait_for_event/get_mixformat/get_subformat/get_nchannels/get_samplespersec/get_bitspersample/get_id/get_friendlyname all exist with the used signatures. Behavioral risks: (1) WASAPI loopback requires an ACTIVE render endpoint producing samples; during pure silence read returns 0 frames and the event wait times out (handled, loop just re-checks stop). (2) The float-mix → int16 (for AGC, Python parity) → f32 round-trip quantizes to 16-bit; faithful to the Python which opens the stream as paInt16. (3) Listen-mode endpointing uses a hardcoded 2.0s post-speech-silence (matches loopback.py's override) + 0.3 Silero threshold (matches the mic recorder) rather than the user's general post_speech_silence_duration — intentional, mirrors the server. (4) device_index from start_listen is used only for the device-name label; capture always opens the DEFAULT render endpoint (None) — covers the common case and keeps listen.rs's signature untouched. Per-device selection would require widening LoopbackManager::start() + start_listen (a future shared-file change, NOT required for parity).



################################################################################
# AGENT: cloud_stt  (status=implemented)
FILES_EDITED: ['E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/cloud_stt.rs', 'E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/managers/cloud_stt_manager.rs', 'E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/commands/catalog_data.rs']

## CARGO_ADDITIONS
none (reqwest already has the `multipart` feature; `hound`, `serde_json`, `tauri` async_runtime all already present)

## LIB_MOD_REGISTRATION
none required for the core feature. CloudSttManager is already managed (lib.rs ~line 180) and the verify/cancel commands (winstt::commands::cloud_stt::verify_cloud_stt_credential, cloud_stt_cancel) plus the renderer's verify seam (winstt::commands::llm::verify_credential — already handles openai/elevenlabs) are already in collect_commands! (lib.rs ~488-490). OPTIONAL: if you want to expose the backend cloud catalog mirror to the renderer, add a thin `#[tauri::command]` wrapper around `catalog_data::all_cloud_catalog_rows()` / `cloud_catalog_rows(provider)` and register it — NOT needed for the picker, which renders cloud models from its own client-side CLOUD_CATALOG.

## SUMMARY
Verified the existing CloudSttManager.transcribe/do_upload against frontend/electron/ipc/stt-cloud.ts: endpoints (OpenAI /v1/audio/transcriptions, ElevenLabs /v1/speech-to-text), multipart fields (file + model/response_format=verbose_json+language for OpenAI; file + model_id + language_code for ElevenLabs), auth headers (Bearer vs xi-api-key), JSON parsing (text/language/duration vs text/language_code), 90s timeout, HTTP-status taxonomy, retry-after, and the ElevenLabs scoped-key 401 `missing_permissions`=valid handling — all correct and faithful to the reference. Made the three owned files real/complete: removed the DRAFT/sketch markers and dead `CloudTranscriber` trait from cloud_stt.rs; added the `<provider>:<id>` helpers (`provider_of`, `split_model_id`, `default_cloud_model_id`), the backend mirror of the renderer's curated CLOUD_CATALOG (`OPENAI_CLOUD_MODELS`/`ELEVENLABS_CLOUD_MODELS` — whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe[default], scribe_v1[default], scribe_v1_experimental, byte-identical to entities/cloud-stt-provider/catalog.ts), and an in-memory WAV encoder (`samples_to_wav_bytes`). Added the high-level live entry point `CloudSttManager::transcribe_samples(model_id, samples, language)` that splits the prefix, reads the decrypted API key from `integrations.<provider>.apiKey`, encodes the 16kHz mono capture to WAV, preflights, uploads, and emits `stt-cloud-error` on failure. Added `cloud_catalog_rows`/`all_cloud_catalog_rows` to catalog_data.rs (kept OUT of the local STT grid by design). The single required SHARED change is a cloud-routing branch in transcription.rs::transcribe() (exact code provided) that detects the `openai:`/`elevenlabs:` prefix and dispatches to the manager instead of the local engine. Discovered + documented that cloud models surface via the renderer's own client-side CLOUD_CATALOG (not list_models), so they must NOT be injected into catalog_rows(). Added unit tests for all new pure helpers.

## RISK
Low-medium

### SHARED_EDIT[0] FILE: E:/DL/Projects/WinSTT/app/src-tauri/src/managers/transcription.rs
ANCHOR:
        if audio.is_empty() {
            debug!("Empty audio vector");
            self.maybe_unload_immediately("empty audio");
            return Ok(String::new());
        }

        // Check if model is loaded, if not try to load it
CHANGE:
INSERT the following cloud-STT routing block BETWEEN the empty-audio `if` block and the `// Check if model is loaded` comment (i.e. right after the closing brace of the empty-audio block, before the engine-loaded guard). This must run BEFORE the engine-loaded guard because cloud models never load a local engine. It routes a `<provider>:<id>` selection to CloudSttManager and returns early with the same filler/custom-word post-processing the local tail applies:

        // ── Cloud STT route ──────────────────────────────────────────────
        // When the user's selected model carries a cloud prefix (openai:/
        // elevenlabs:), there is NO local engine — ship the captured audio
        // to the provider via CloudSttManager instead. Mirrors the Electron
        // RemoteTranscriber path (frontend/electron/ipc/stt-cloud.ts).
        {
            let desired = self.desired_model_id();
            if crate::winstt::cloud_stt::provider_of(&desired).is_some() {
                use tauri::Manager;
                let cloud = self
                    .app_handle
                    .state::<std::sync::Arc<crate::winstt::managers::CloudSttManager>>()
                    .inner()
                    .clone();
                // Decode language from the WinSTT picker (empty/"auto" => None;
                // zh-Hans/zh-Hant => zh) — same normalization as winstt_opts.
                let ws = crate::winstt::commands::settings::read_settings(&self.app_handle);
                let language = {
                    let l = ws.model.language.trim();
                    if l.is_empty() || l == "auto" {
                        None
                    } else if l == "zh-Hans" || l == "zh-Hant" {
                        Some("zh".to_string())
                    } else {
                        Some(l.to_string())
                    }
                };
                let settings = get_settings(&self.app_handle);
                let text = tauri::async_runtime::block_on(
                    cloud.transcribe_samples(&desired, &audio, language),
                )
                .map_err(|e| anyhow::anyhow!("Cloud STT failed ({}): {}", e.code.as_str(), e.message))?;
                // Cloud is never Whisper, so apply custom-word correction (the
                // local tail skips it only for Whisper) then filler filtering.
                let corrected = if settings.custom_words.is_empty() {
                    text
                } else {
                    apply_custom_words(&text, &settings.custom_words, settings.word_correction_threshold)
                };
                let filtered = filter_transcription_output(
                    &corrected,
                    &settings.app_language,
                    &settings.custom_filler_words,
                );
                self.maybe_unload_immediately("cloud transcription");
                return Ok(filtered);
            }
        }

NOTE: `apply_custom_words`, `filter_transcription_output`, and `get_settings` are already imported at the top of transcription.rs; `tauri::Manager` is already in the file-level `use tauri::{AppHandle, Emitter, Manager};`. The local `use tauri::Manager;` inside the block is harmless (re-import) but can be removed if it triggers an unused/duplicate-import warning — `Manager` is already in scope file-wide, so you may DROP the inner `use tauri::Manager;` line entirely.



################################################################################
# AGENT: word_ts  (status=implemented)
FILES_EDITED: ['app/src-tauri/src/winstt/stt/whisper.rs', 'app/src-tauri/src/winstt/managers/word_aligner.rs', 'app/src-tauri/src/winstt/word_timestamps.rs']

## CARGO_ADDITIONS
none — base85 + flate2 + ndarray are already declared (word_timestamps.rs already used them); ort/tauri/serde already present. No new deps.

## LIB_MOD_REGISTRATION
none — word_aligner is already in winstt/managers/mod.rs (pub mod word_aligner; pub use WordAligner) and already managed in lib.rs:186 (WordAligner::new(app_handle, model_manager.clone())); the align_words command is already registered (lib.rs:495). No new modules/commands.

## SUMMARY
Implemented full cross-attention word-DTW. whisper.rs: added cross_attn_names (sorted cross_attentions.{i} outputs captured at load); refactored decode_greedy into a shared decode_inner that, when collecting, reads each step's cross_attentions.{i} f32 outputs and concatenates them along the decoder-token axis into a CrossAttentions buffer (port of _hf.py _decoding_with_cross_attention); added decode_with_cross_attn + align_word_timestamps (builds generated tokens = post-prompt eos-stripped + trailing eos, picks alignment heads via lookup_alignment_heads on vocab size, decode_one preserves the leading space, runs word_timestamps::align_words with medfilt_width=7/qk_scale=1.0); transcribe now branches on return_word_timestamps && has_cross_attention to run the cross-attn path (no initial-prompt prefix, so cross-attn row 0 == prompt[0]) and fills Transcription.words; num_audio_frames = audio.len()/HOP_LENGTH (160). word_aligner.rs: try_load_engine now resolves onnx-community/whisper-tiny_timestamped via stt::resolver::resolve (cache-first) and builds a CPU WhisperEngine via stt::build_engine, confirming supports_word_timestamps(); align_words transcribes for native timed words then relabels onto the known history transcript via map_timings_to_text (use-our-words tier), exactly mirroring server/.../word_aligner.py. Load outcome is cached (Some/Some(None)) so failures degrade to no-highlight without retry-storm. word_timestamps.rs: removed the now-dead TimestampedDecoder trait/TimestampedDecodeOutput stub and updated the module docs to reflect that collection lives in the engine. The align_words command (wordts.rs) and all wiring already existed and need no changes — the integrator does NOT need to touch any shared file. No signature changes are required of callers: WordAligner::align_words(&[f32], &str) -> Result<Vec<WordResult>, String> is unchanged; Transcriber::transcribe is unchanged (the word path is internal, gated by TranscribeOptions.return_word_timestamps).

## RISK
MODERATE-HIGH on numerical fidelity; LOW on compile/wiring. (1) Cross-attention shape assumption: each per-step `cross_attentions.{i}` ort output is assumed (1, num_heads, dec_step_len, num_enc_frames) row-major, read via shape[1]=heads, shape[3]=frames — this matches the onnx-asr _hf.py reference (np.stack axis=1 over per-layer, concat axis=2 over steps). If a given timestamped export emits a transposed/extra-dim layout, frames/heads would be swapped; gated behind WINSTT_STT_DEBUG logging but only confirmable on a live session. (2) Merged-decoder multi-token cache bug (memory project_onnx_whisper_cache_bug): the bug scrambles all-but-last predictions on use_cache_branch=TRUE with K>1. Our step-0 prompt pass (the ONLY K>1 step) runs with use_cache_branch=FALSE (empty past), so its prompt-row cross-attentions are computed on the correct non-cache branch — same path Python uses successfully. NOT a blocker, but if a specific export routes the prompt through the cache branch the prompt anchor rows could be corrupted (would degrade word boundaries, not crash). (3) Requires onnx-community/whisper-tiny_timestamped to actually expose cross_attentions.* outputs; try_load_engine self-checks supports_word_timestamps() and degrades to no-highlight (empty vec) if not — never fatal, transcript intact. (4) host-copy decode (no IoBinding) is slower than the Python reference but correctness-first per spec; word-ts is opt-in post-commit so acceptable. Cannot compile here (needs MSVC+ort); wrote against the same ort/ndarray APIs already proven in the surrounding code.



################################################################################
# AGENT: snippets  (status=implemented)
FILES_EDITED: ['E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/snippets.rs', 'E:/DL/Projects/WinSTT/app/src-tauri/src/winstt/commands/snippets.rs']

## CARGO_ADDITIONS
none (reuses existing strsim = "0.11.0", regex = "1", once_cell = "1"; double-metaphone is ported in-file since no metaphone crate exists)

## LIB_MOD_REGISTRATION
In src/lib.rs:

1) Register the read-only command — add this line inside the `collect_commands![ ... ]` list (around line 503, next to the other `winstt::commands::dictation::*` entries):

            winstt::commands::snippets::winstt_expand_snippets,

2) Warm + keep the snippet cache in sync — add this call in the setup body right after the existing bridge installers (after line 197 `winstt::commands::tray_menu::install_tray_menu_lifecycle(app_handle);`, and after `seed_defaults` at line 170 has run so the store exists):

    winstt::commands::snippets::install_snippet_reload_bridge(app_handle);

No new `pub mod` is needed in lib.rs itself (the module is declared under winstt/mod.rs + winstt/commands/mod.rs via the shared_file_instructions above). No `.manage(...)` is required — the snippet cache is a process-wide static, not Tauri-managed state.

## SUMMARY
Implemented the entirely-absent snippet/text-expansion backend for the Rust/Tauri port, at functional parity with the Electron+Python reference. The reference behavior lives in frontend/src/shared/lib/fuzzy-match.ts (replaceWithSnippets/findSnippetMatches + doubleMetaphone) and electron/lib/text-processing.ts (applyPostProcessing/rebuildSnippets), called from relay.ts after each transcription; snippets have NO dedicated IPC commands — the array rides the settings tree (winstt_set_settings({ snippets })) and the renderer's SnippetsTable is fully controlled.\n\nNew file snippets.rs ports the full fuzzy engine 1:1: a faithful Rust double_metaphone (verified against the npm package on 44 words, 0 mismatches), jaro_winkler via strsim, a sliding-window matcher gated on BOTH SNIPPET_JW_THRESHOLD=0.92 AND a double-metaphone phonetic overlap (so 'my email adress' fuzzily expands but unrelated text doesn't), reverse byte-offset splice that preserves surrounding punctuation and does non-overlapping left-to-right replacement, plus a thread-safe SnippetStore (mirrors cachedSnippets/rebuildSnippets, drops empty trigger/expansion entries) with expand_cached (warm hot path) and expand_snippets (reads live settings). New file commands/snippets.rs exposes one read-only command winstt_expand_snippets (preview/playground seam) and install_snippet_reload_bridge, which warms the cache at startup and rebuilds it on every settings:changed broadcast (the in-proc equivalent of the TS onDidChange watcher).\n\nThe integrator must: declare pub mod snippets in winstt/mod.rs and winstt/commands/mod.rs; register winstt_expand_snippets + call install_snippet_reload_bridge in lib.rs; and add the snippet-expansion line in actions.rs::process_transcription_output as the last step before building ProcessedTranscription (after Chinese convert + LLM cleanup = the 'custom-word correction' analogue), matching the reference 'snippets last' ordering. No new crates required.

## RISK
Low–medium. (1) The double-metaphone port (the only non-trivial new logic, ~600 lines) was verified byte-for-byte against the `double-metaphone` npm package via a standalone rustc harness on 44 reference words incl. all the tricky negative-slice/Germanic/Greek cases (michael, school, thomas, through, arch, orchestra, schermerhorn, filipowicz, zhao, etc.) — 0 mismatches. The full sliding-window matcher (byte-offset reverse splice, non-overlap cursor, empty-filter, JW+phonetic gate) was verified against the 7 reference text-processing.test.ts cases — all pass; non-Latin scripts correctly do NOT expand (matches reference, empty metaphone → no phonetic overlap). (2) strsim::jaro_winkler is byte-based vs the TS char-based Jaro — divergence only on multi-byte unicode windows, which the phonetic gate already rejects (empty codes), so no behavioral difference. (3) The shared actions.rs edit runs snippet expansion on the LLM-cleaned text; if a future dictionary/replacement-pair step lands in actions.rs it must run BEFORE this snippet step to preserve reference order. (4) Could not run `cargo check` (MSVC + ~6min); imports/APIs (regex \\p{L} unicode default-on, once_cell Lazy, tauri Listener::listen, RwLock) were matched against installed crate sources + existing port code.

### SHARED_EDIT[0] FILE: src/winstt/mod.rs
ANCHOR:
/// RealtimeSTT-faithful preview stabilizer + committed-watermark accumulator.
pub mod realtime_stabilizer;
CHANGE:
Add a new module declaration immediately AFTER the `pub mod realtime_stabilizer;` line (it belongs in WAVE 1 pure-logic, no new crates):

/// Deterministic snippet / text-expansion engine (fuzzy trigger→expansion with
/// Jaro-Winkler + double-metaphone gates). Ports frontend fuzzy-match.ts +
/// text-processing.ts. Applied as the LAST post-processing step before paste.
pub mod snippets;

### SHARED_EDIT[1] FILE: src/winstt/commands/mod.rs
ANCHOR:
pub mod onboarding;
CHANGE:
Add a new commands-submodule declaration AFTER the `pub mod onboarding;` line:

/// Snippet expansion: `winstt_expand_snippets` (read-only preview/playground seam,
/// the in-proc analogue of running applyPostProcessing over IPC) + the
/// `install_snippet_reload_bridge` setup hook that keeps the snippet cache warm
/// from settings:changed. CRUD has no dedicated command (snippets ride the
/// settings tree via winstt_set_settings). Register winstt_expand_snippets in
/// lib.rs collect_commands![]; call install_snippet_reload_bridge once in setup.
pub mod snippets;

### SHARED_EDIT[2] FILE: src/actions.rs
ANCHOR:
    } else if final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    ProcessedTranscription {
CHANGE:
Apply snippet expansion to `final_text` as the LAST post-processing step, AFTER the Chinese-variant convert and the LLM cleanup block (matching the reference order where applyPostProcessing runs snippets last, after the dictionary/replacement-pair 'custom-word correction'). Replace the block:

    } else if final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    ProcessedTranscription {

WITH:

    } else if final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    // WinSTT snippet expansion: deterministic fuzzy trigger→expansion on the
    // finalized text, the last step before paste (mirrors applyPostProcessing's
    // replaceWithSnippets, which runs AFTER dictionary + replacement-pairs). Uses
    // the warm in-memory cache (kept in sync by install_snippet_reload_bridge), so
    // no store read on the hot path. No-op when there are no snippets.
    let expanded = crate::winstt::snippets::expand_cached(&final_text);
    if expanded != final_text {
        final_text = expanded;
        // Surface the change as a post-processed result even when no LLM ran, so
        // history/feed reflect the expanded text (mirrors the `final_text != transcription` branch above).
        post_processed_text = Some(final_text.clone());
    }

    ProcessedTranscription {

NOTE: `expand_cached` is synchronous + pure (reads a static cache, takes no AppHandle), so it is safe to call inline in this async fn without `.await`.



################################################################################
# AGENT: renderer_sync  (status=implemented)
FILES_EDITED: ['E:/DL/Projects/WinSTT/app/src/features/update-settings/lib/sync-actions.ts']

## CARGO_ADDITIONS
none

## LIB_MOD_REGISTRATION
No NEW Rust commands are strictly required for the two main knobs (custom_words + threshold) — `update_custom_words` and `change_word_correction_threshold_setting` are already registered in src/lib.rs collect_commands!.

OPTIONAL (only needed to also push custom_filler_words): add a new command in src/shortcut/mod.rs:

#[tauri::command]
#[specta::specta]
pub fn change_custom_filler_words_setting(app: AppHandle, words: Vec<String>) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.custom_filler_words = if words.is_empty() { None } else { Some(words) };
    settings::write_settings(&app, settings);
    Ok(())
}

Then register it in src/lib.rs collect_commands! next to `shortcut::update_custom_words,` by adding the line:
    shortcut::change_custom_filler_words_setting,

After that, run the bindings generator (tauri-specta) so commands.changeCustomFillerWordsSetting appears in app/src/bindings.ts, and uncomment the changeCustomFillerWords wiring in use-sync-settings.ts (shared_file_instructions above).

## SUMMARY
Mirrored Electron's installCustomWordsSync into the Tauri port's renderer-side syncToServer. sync-actions.ts now: (1) extends SyncDeps with three optional ports — updateCustomWords, changeWordCorrectionThreshold, changeCustomFillerWords; (2) adds pure derivation helpers deriveCustomWords (dictionary entries WITHOUT a `replacement`, trimmed+deduped — the vocab-bias terms; replacement pairs are excluded to avoid double-correcting), deriveCustomFillerWords (trim+dedupe), and resolveWordCorrectionThreshold (default 0.18, matching the server TextCorrectionConfig + renderer schema); (3) adds syncDictionaryParams, called from syncToServer, which pushes custom_words / word_correction_threshold / custom_filler_words on initial connect or when the derived value changes. These are NOT AllowedParameters/set_parameter knobs — the Rust backend persists them to its settings store and reads them at transcription time, so the renderer routes them through dedicated Tauri commands (commands.updateCustomWords + commands.changeWordCorrectionThresholdSetting, both already in bindings.ts/lib.rs).\n\nINTEGRATOR WIRING (shared file use-sync-settings.ts): import { commands } from \"@/bindings\" and add updateCustomWords + changeWordCorrectionThreshold to the DEPS object (exact edits in shared_file_instructions). That alone makes custom_words + threshold take effect.\n\nMISSING BACKEND COMMAND: custom_filler_words has the settings field (settings.custom_filler_words: Option<Vec<String>>, consumed by filter_transcription_output) but NO renderer-callable command/binding. Integrator should add shortcut::change_custom_filler_words_setting (code in lib_mod_registration), register it in collect_commands!, regenerate bindings, then uncomment the changeCustomFillerWords wiring. Until then that one push is a guarded no-op.\n\nSNIPPETS: intentionally NOT pushed to the STT backend — in the reference, snippets are post-transcription text expansion (text-processing.ts replaceWithSnippets / store.onDidChange(\"snippets\")), never an STT-engine input; the server has no snippet concept. Documented inline.

## RISK
Low. sync-actions.ts only gained pure helpers + one new sync step; the three new SyncDeps ports are OPTIONAL and guarded, so the existing sync-actions.test.ts makeDeps() (which omits them) still type-checks and passes, and use-sync-settings.ts compiles even before the integrator wires the commands (the feature just stays inert until then). syncDictionaryParams change-gates on the derived value (initial connect OR actual change) so it won't churn backend file writes on unrelated settings edits. The Tauri backend reads settings.custom_words / word_correction_threshold / custom_filler_words directly off the persisted settings store at transcription time (managers/transcription.rs lines ~980-995: apply_custom_words + filter_transcription_output), so writing via these commands is sufficient for them to take effect with no engine restart. NOTE: custom_filler_words has NO existing binding/command — it stays a no-op until the integrator adds change_custom_filler_words_setting (see lib_mod_registration). snippets are deliberately NOT pushed (renderer/main-side text-expansion concern in the reference, never sent to the STT engine).

### SHARED_EDIT[0] FILE: app/src/features/update-settings/api/use-sync-settings.ts
ANCHOR:
import {
	autostartSet,
	onSettingsChanged,
	settingsLoad,
	settingsSave,
	sttRequestDiarizationToggle,
	sttSetParameter,
} from "@/shared/api/ipc-client";
CHANGE:
Add an import of the generated Tauri bindings right after this ipc-client import block (alias resolves via tsconfig "@/bindings" -> ./src/bindings.ts):

import { commands } from "@/bindings";

These commands already exist: commands.updateCustomWords(words: string[]) (cmd "update_custom_words") and commands.changeWordCorrectionThresholdSetting(threshold: number) (cmd "change_word_correction_threshold_setting"). Both return Promise<Result<null,string>> and are fire-and-forget here.

### SHARED_EDIT[1] FILE: app/src/features/update-settings/api/use-sync-settings.ts
ANCHOR:
const DEPS: SyncDeps = {
	autostartSet,
	sttRequestDiarizationToggle,
	sttSetParameter,
};
CHANGE:
Extend the DEPS object so the three new (optional) SyncDeps ports are wired to the Tauri commands:

const DEPS: SyncDeps = {
	autostartSet,
	sttRequestDiarizationToggle,
	sttSetParameter,
	updateCustomWords: (words) => {
		void commands.updateCustomWords(words);
	},
	changeWordCorrectionThreshold: (threshold) => {
		void commands.changeWordCorrectionThresholdSetting(threshold);
	},
	// Wire this once the backend `change_custom_filler_words_setting` command + binding exist (see cargo/lib + summary):
	// changeCustomFillerWords: (words) => {
	//	void commands.changeCustomFillerWordsSetting(words);
	// },
};

Leave changeCustomFillerWords commented out until the new command/binding lands; syncDictionaryParams guards on the dep being present so the dictionary + threshold pushes work immediately without it.



################################################################################
# AGENT: hub_planner  (status=implemented)
FILES_EDITED: []

## CARGO_ADDITIONS
none (hound, reqwest, tauri::async_runtime, serde_json already present; CloudSttManager/LlmManager/WakeWordManager/ContextManager already managed in lib.rs)

## LIB_MOD_REGISTRATION
none — all five managers (TranscriptionManager, CloudSttManager, LlmManager, WakeWordManager, ContextManager, LoopbackManager) are already `.manage(Arc::new(..))`'d in lib.rs (lines 164-186) and TranscriptionCoordinator at line 697. No new commands are added by this hub-wiring plan (the gaps are internal pipeline wiring, not new tauri::command entry points), so collect_commands! is unchanged. The only pub-visibility tweak is making winstt::commands::llm::dictation_presets_for / to_llm_effort_for pub(crate) (covered in shared_file_instructions); winstt::commands::llm is already a pub module under winstt/commands/mod.rs.

## SUMMARY
Produced exact, anchored integration instructions for 5 live-pipeline gaps the integrator applies to SHARED files (no files edited by me — planning role).

(1) DICTIONARY BRIDGE: transcription.rs::transcribe reads Handy's empty settings.custom_words. Wired to read the WinSTT dictionary terms + general.word_correction_threshold + filter_fillers/custom_filler_words from winstt::commands::settings::read_settings and feed them into apply_custom_words, filter_transcription_output, and the Whisper initial_prompt seed — so the real fuzzy matcher runs on the user's actual word list. (2 anchored edits.)

(2) LLM POST-PROCESS ON PASTE: dictation uses TranscribeAction{post_process:false} so the WinSTT LLM never ran. Added maybe_run_winstt_dictation_llm (Ollama/OpenRouter/AppleIntelligence via LlmManager, with presets + dictionary/snippets folded into the prompt via build_dictation_system_prompt + focused-window context via ContextManager) and called it inside process_transcription_output before paste, gated on llm.dictation.enabled, soft-failing to the original — mirroring relay.ts processText(text,context). (actions.rs + 1 pub(crate) exposure in winstt/commands/llm.rs.)

(3) CLOUD STT BRANCH: transcription.rs had no cloud path. Added is_cloud_model_id (provider prefix on `<provider>:<id>`), a load-side short-circuit (no local engine, mark current model), and a transcribe-side short-circuit calling new transcribe_cloud → CloudSttManager.transcribe with in-memory 16k WAV bytes (encode_wav_bytes via hound) + per-provider key from integrations settings. (4 anchored edits.)

(4) WAKEWORD + LOOPBACK triggers: identified that the Handy recorder only exposes a spectrum-level callback — no raw-chunk tap. Specified adding with_chunk_callback to AudioRecorder (recorder.rs) firing per raw 16k chunk before VAD, then wiring it in managers/audio.rs to WakeWordManager.feed_chunk (while armed) → coordinator.send_input("transcribe",..,true,false) on a hit. Listen/loopback producer-injection flagged as an owned-file (LoopbackManager) follow-up.

(5) SNIPPET/DICTIONARY EXPANSION: applied deterministic dictionary replacement-pairs via winstt::llm::apply_replacement_pairs to the final text in process_transcription_output before paste (the guaranteed-fire safety net), plus snippets folded into the LLM prompt via the gap-2 Vocab.

Each instruction gives the exact file, a unique anchor snippet, and the literal code to insert/replace, with integration order + risks in the risk field.

## RISK
INTEGRATION ORDER (do in this sequence; each compiles independently):
1. DICTIONARY BRIDGE (transcription.rs, 2 edits) — lowest risk, pure local-var swap; the only subtlety is the closure-capture of winstt_custom_words (clone a `_for_correct` copy before the catch_unwind closure since the closure moves its copy). Verify filter_transcription_output's 3rd arg type is `&Option<Vec<String>>` (it is).
2. CLOUD STT BRANCH (transcription.rs, 3 edits: is_cloud_model_id helper + load branch + transcribe short-circuit + transcribe_cloud method + encode_wav_bytes helper) — medium risk. CRITICAL: the cloud short-circuit in transcribe() MUST come before the local-engine `engine_guard.is_none()` guard or cloud returns 'Model is not loaded'. tauri::async_runtime::block_on inside the sync transcribe() runs on the spawn_blocking-ish thread actions.rs uses (tm.transcribe is called from an async task but is itself sync — block_on there is the same pattern load_winstt_model already uses for resolver::resolve, so it's proven safe). Confirm WinsttSettings.integrations.openai/elevenlabs.api_key are PLAINTEXT here (read_settings opens secrets — yes).
3. LLM POST-PROCESS + SNIPPET/DICT EXPANSION (actions.rs maybe_run_winstt_dictation_llm + process_transcription_output insert; llm.rs pub(crate) exposure) — highest risk. It adds network I/O (Ollama/OpenRouter) to EVERY dictation paste when llm.dictation.enabled. Soft-fail is built in (unwrap_or_else(|_| text)). The replacement-pairs block fires regardless. process_transcription_output is already async and already awaits LLM (post_process branch), so no new await-context issues. WATCH: don't double-apply replacement pairs — process_text (the command path) applies them too, but actions.rs calls maybe_run_winstt_dictation_llm directly (NOT process_text), so there's exactly one application here. Also the overlay 'thinking' pill is not auto-shown (cosmetic gap vs relay.ts; optional follow-up).
4. WAKEWORD MIC TAP (recorder.rs with_chunk_callback + audio.rs wire) — structural. recorder.rs is a Handy-owned audio file; the new always-on raw-chunk callback fires per chunk (~10-32ms) so the wakeword feed_chunk + coordinator hop must stay cheap (feed_chunk is a no-op until sherpa KWS lands; is_armed gate keeps it free otherwise). CONFIRM the exact binding name of the resampled 16k mono Vec<f32> in the consumer loop before VAD (the var fed to handle_frame) — name it precisely when applying.

OUTSTANDING GAPS (not fully closable in shared files alone):
- LISTEN/LOOPBACK producer injection: making listen mode actually transcribe requires LoopbackManager::start() (an OWNED managers/* file, currently a SPIKE) to push AGC'd blocks into the recorder consumer mpsc AND start_listen to call coordinator.send_input — that's an owned-file change for the loopback slice owner, not this hub plan. The wakeword mic-tap IS wired here.
- WAKEWORD ARMING: set_armed(true) must be called when the user selects wakeword recordingMode (mode-change handler) — owned by the recording-mode slice, not this plan.
- Cloud cancel on PTT/swap: CloudSttManager.cancel_all() should be called from the existing cancel path; the request_id used here ('cloud-<ts>') isn't surfaced to the renderer, so only cancel_all reaches it.

### SHARED_EDIT[0] FILE: app/src-tauri/src/managers/transcription.rs
ANCHOR:
        // Get current settings for configuration
        let settings = get_settings(&self.app_handle);
CHANGE:
DICTIONARY BRIDGE (gap 1). Insert a WinSTT-settings read RIGHT AFTER `let settings = get_settings(&self.app_handle);` and use it to override the dictionary inputs Handy's `settings.custom_words` / `word_correction_threshold` / `custom_filler_words` would otherwise carry. The cleanest non-invasive form: derive three locals from `read_settings(app)` and feed them into the existing correction/filter calls + the Whisper initial_prompt instead of `settings.custom_words` etc.

INSERT after that line:
```rust
        // WinSTT dictionary bridge: the picker's dictionary (custom words) + fuzzy
        // threshold + filler list live in the WinSTT settings store, NOT Handy's
        // `settings.custom_words`. Read them here so the real fuzzy matcher
        // (apply_custom_words) and the filler/hallucination filter run on the user's
        // ACTUAL word list (mirrors Electron set_parameter forwarding
        // custom_words/word_correction_threshold/custom_filler_words to the recorder).
        let ws_dict = {
            let ws = crate::winstt::commands::settings::read_settings(&self.app_handle);
            // Dictionary `term`s = the vocab-bias / fuzzy-correction word list.
            let custom_words: Vec<String> = ws
                .dictionary
                .iter()
                .map(|d| d.term.clone())
                .filter(|t| !t.trim().is_empty())
                .collect();
            let threshold = ws.general.word_correction_threshold;
            // filter_fillers gate: when off, pass an explicit empty list so the
            // default-language filler table is NOT applied (Some([]) == no patterns).
            let custom_filler_words: Option<Vec<String>> = if ws.general.filter_fillers {
                if ws.general.custom_filler_words.is_empty() {
                    None // fall back to the language default table
                } else {
                    Some(ws.general.custom_filler_words.clone())
                }
            } else {
                Some(Vec::new())
            };
            (custom_words, threshold, custom_filler_words)
        };
        let (winstt_custom_words, winstt_word_threshold, winstt_filler_words) = ws_dict;
```

Then in the Whisper engine arm replace the `initial_prompt` block (which currently reads `settings.custom_words`) so it seeds from the WinSTT dictionary. Original:
```rust
                                initial_prompt: if settings.custom_words.is_empty() {
                                    None
                                } else {
                                    Some(settings.custom_words.join(", "))
                                },
```
NOTE: this lives inside the `catch_unwind` closure which currently only borrows `settings`/`audio`/`validated_language`/`winstt_opts`. Add `winstt_custom_words` to the closure's captured set by referencing it (it is `Send`/`Clone`). Replace with:
```rust
                                initial_prompt: if winstt_custom_words.is_empty() {
                                    None
                                } else {
                                    Some(winstt_custom_words.join(", "))
                                },
```
(Capture note: `winstt_custom_words` is moved into the `AssertUnwindSafe` closure; clone it before the closure if it's also needed by the post-engine correction block below — see next edit — i.e. `let winstt_custom_words_for_correct = winstt_custom_words.clone();` declared alongside the derivation, and use the `_for_correct` copy in the correction block.)

### SHARED_EDIT[1] FILE: app/src-tauri/src/managers/transcription.rs
ANCHOR:
        let corrected_result = if !settings.custom_words.is_empty() && !is_whisper {
            apply_custom_words(
                &result.text,
                &settings.custom_words,
                settings.word_correction_threshold,
            )
        } else {
            result.text
        };
CHANGE:
DICTIONARY BRIDGE (gap 1, second half). Replace the post-engine correction + filter blocks to use the WinSTT dictionary locals instead of Handy's `settings.*`. Replace the `corrected_result` block with:
```rust
        let corrected_result = if !winstt_custom_words_for_correct.is_empty() && !is_whisper {
            apply_custom_words(
                &result.text,
                &winstt_custom_words_for_correct,
                winstt_word_threshold,
            )
        } else {
            result.text
        };
```
And replace the immediately-following filter call:
```rust
        let filtered_result = filter_transcription_output(
            &corrected_result,
            &settings.app_language,
            &settings.custom_filler_words,
        );
```
with:
```rust
        let filtered_result = filter_transcription_output(
            &corrected_result,
            &settings.app_language,
            &winstt_filler_words,
        );
```
(`settings.app_language` stays from Handy — it only selects the default-language filler table when `winstt_filler_words` is None. `filter_transcription_output`'s 3rd param is `&Option<Vec<String>>`, so pass `&winstt_filler_words`.)

### SHARED_EDIT[2] FILE: app/src-tauri/src/managers/transcription.rs
ANCHOR:
        let desired = self_clone.desired_model_id();
            let result = if crate::winstt::catalog::find(&desired).is_some() {
                self_clone.load_winstt_model(&desired)
            } else {
                self_clone.load_model(&desired)
            };
CHANGE:
CLOUD STT BRANCH (gap 3, load side). A cloud model id is `<provider>:<id>` (e.g. `openai:whisper-1`, `elevenlabs:scribe_v1`) and is NOT in the catalog, so today it falls into `self_clone.load_model(&desired)` which fails (Handy registry has no such id). Add a cloud short-circuit BEFORE the catalog branch so a cloud selection loads nothing (no local engine) but is treated as 'ready'. Replace the block with:
```rust
            let desired = self_clone.desired_model_id();
            let result = if is_cloud_model_id(&desired) {
                // Cloud STT: no local ORT engine. Unload any local engine and mark
                // the cloud id as current so transcribe() routes to the cloud manager.
                {
                    let mut current = self_clone.current_model_id.lock().unwrap();
                    *current = Some(desired.clone());
                }
                self_clone.touch_activity();
                let _ = self_clone.app_handle.emit(
                    "model-state-changed",
                    ModelStateEvent {
                        event_type: "loading_completed".to_string(),
                        model_id: Some(desired.clone()),
                        model_name: Some(desired.clone()),
                        error: None,
                    },
                );
                Ok(())
            } else if crate::winstt::catalog::find(&desired).is_some() {
                self_clone.load_winstt_model(&desired)
            } else {
                self_clone.load_model(&desired)
            };
```
Also add a free helper near `family_policy_slug` (module scope):
```rust
/// `true` when the selected model id is a cloud provider id (`<provider>:<rest>`)
/// with a known provider prefix. Mirrors the WinSTT `<provider>:<id>` model.model
/// convention (openai: / elevenlabs:).
fn is_cloud_model_id(id: &str) -> bool {
    crate::winstt::cloud_stt::CloudSttProvider::from_id(id.split(':').next().unwrap_or("")).is_some()
        && id.contains(':')
}
```
NOTE: `initiate_model_load`'s early-return `if self.is_model_loaded() && current == desired` must NOT block cloud (a cloud id never sets a local engine, so `is_model_loaded()` is false → it proceeds; correct). And `current_model_id` IS settable from the spawned thread here (it's `Arc<Mutex<Option<String>>>`).

### SHARED_EDIT[3] FILE: app/src-tauri/src/managers/transcription.rs
ANCHOR:
        // Check if model is loaded, if not try to load it
        {
            // If the model is loading, wait for it to complete.
            let mut is_loading = self.is_loading.lock().unwrap();
            while *is_loading {
                is_loading = self.loading_condvar.wait(is_loading).unwrap();
            }

            let engine_guard = self.lock_engine();
            if engine_guard.is_none() {
                return Err(anyhow::anyhow!("Model is not loaded for transcription."));
            }
        }
CHANGE:
CLOUD STT BRANCH (gap 3, transcribe side). The current guard returns Err when no LOCAL engine is loaded — but a cloud model has no local engine. Insert a cloud short-circuit BEFORE this guard (right after the `if audio.is_empty()` block and the `self.touch_activity()`), so cloud ids never reach the local-engine guard.

INSERT (immediately before the `// Check if model is loaded` block):
```rust
        // Cloud STT route: when the selected model is a cloud provider id there is
        // no local ORT engine — wait out any in-flight load, then ship the audio to
        // the cloud manager (mirrors the Electron RemoteTranscriber path). Cancellation
        // + typed errors are owned by CloudSttManager.
        {
            let mut is_loading = self.is_loading.lock().unwrap();
            while *is_loading {
                is_loading = self.loading_condvar.wait(is_loading).unwrap();
            }
        }
        if let Some(model_id) = self.get_current_model() {
            if is_cloud_model_id(&model_id) {
                return self.transcribe_cloud(&model_id, &audio);
            }
        }
```

Then add the `transcribe_cloud` method inside `impl TranscriptionManager` (place it just above `pub fn transcribe`):
```rust
    /// Transcribe one utterance via the cloud provider (no local engine). Encodes
    /// the f32 samples to 16k mono WAV bytes in-memory, splits the `<provider>:<id>`
    /// model id, reads the per-provider key from the WinSTT integrations settings,
    /// and blocks on CloudSttManager::transcribe. Errors surface as a transcriber
    /// error (actions.rs emits transcription_failed).
    fn transcribe_cloud(&self, model_id: &str, audio: &[f32]) -> Result<String> {
        use crate::winstt::cloud_stt::{CloudSttProvider, CloudTranscribeRequest};
        let (provider_str, cloud_model) = model_id
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("bad cloud model id: {model_id}"))?;
        let provider = CloudSttProvider::from_id(provider_str)
            .ok_or_else(|| anyhow::anyhow!("unknown cloud provider: {provider_str}"))?;
        let ws = crate::winstt::commands::settings::read_settings(&self.app_handle);
        let api_key = match provider {
            CloudSttProvider::OpenAi => ws.integrations.openai.api_key.clone(),
            CloudSttProvider::ElevenLabs => ws.integrations.elevenlabs.api_key.clone(),
        };
        // language: WinSTT model.language (""/auto = None; zh-Hans/Hant -> zh).
        let language = {
            let l = ws.model.language.trim();
            if l.is_empty() || l == "auto" {
                None
            } else if l == "zh-Hans" || l == "zh-Hant" {
                Some("zh".to_string())
            } else {
                Some(l.to_string())
            }
        };
        // Encode samples -> 16k mono i16 WAV bytes (mirrors save_wav_file, in memory).
        let audio_wav = encode_wav_bytes(audio)
            .map_err(|e| anyhow::anyhow!("cloud wav encode failed: {e}"))?;
        let req = CloudTranscribeRequest {
            provider,
            model_id: cloud_model.to_string(),
            api_key,
            language,
            media_type: "audio/wav".to_string(),
            audio_wav,
        };
        let request_id = format!("cloud-{}", Self::now_ms());
        let mgr = self
            .app_handle
            .state::<std::sync::Arc<crate::winstt::managers::CloudSttManager>>()
            .inner()
            .clone();
        let result = tauri::async_runtime::block_on(mgr.transcribe(&request_id, req));
        self.maybe_unload_immediately("cloud transcription");
        match result {
            Ok(t) => Ok(t.text),
            Err(e) => Err(anyhow::anyhow!("Cloud STT failed: {}", e.message)),
        }
    }
```

And add a free helper next to `peak_normalize` (module scope) for in-memory WAV encoding:
```rust
/// Encode f32 samples to 16 kHz mono 16-bit WAV bytes in memory (same spec as
/// audio_toolkit::save_wav_file, but to a Vec for the cloud multipart upload).
fn encode_wav_bytes(samples: &[f32]) -> anyhow::Result<Vec<u8>> {
    use hound::{SampleFormat, WavSpec, WavWriter};
    use std::io::Cursor;
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer = WavWriter::new(&mut cursor, spec)?;
        for s in samples {
            let v = (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            writer.write_sample(v)?;
        }
        writer.finalize()?;
    }
    Ok(cursor.into_inner())
}
```
NOTE: `hound` is already a dependency (audio_toolkit uses it). `tauri::Manager` (for `.state()`) and `Emitter` are already imported in transcription.rs.

### SHARED_EDIT[4] FILE: app/src-tauri/src/actions.rs
ANCHOR:
pub(crate) async fn process_transcription_output(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
) -> ProcessedTranscription {
    let settings = get_settings(app);
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut post_process_prompt: Option<String> = None;

    if let Some(converted_text) = maybe_convert_chinese_variant(&settings, transcription).await {
        final_text = converted_text;
    }
CHANGE:
LLM POST-PROCESS ON PASTE (gap 2) + SNIPPET/DICTIONARY EXPANSION (gap 5). Dictation runs `TranscribeAction{post_process:false}`, so the Handy `post_process` branch never fires the WinSTT LLM. Wire the WinSTT dictation-LLM compose + deterministic replacement-pairs into `process_transcription_output` so EVERY dictation paste gets the WinSTT cleanup (mirrors relay.ts: processText(text, context) BEFORE paste, with dictionary/snippets folded into the prompt and replacement-pairs as the guaranteed-fire safety net).

INSERT a call to a new async helper `maybe_run_winstt_dictation_llm` right AFTER the Chinese-variant block (after the `if let Some(converted_text) ... { final_text = converted_text; }`):
```rust
    // WinSTT dictation LLM cleanup (gap 2) — runs on the dictation paste path even
    // though Handy's `post_process` flag is false for the plain transcribe binding.
    // Gated on llm.dictation.enabled; folds the user's dictionary + snippets into the
    // system prompt + captures focused-window context, exactly like relay.ts. On any
    // failure / no-op it returns the input unchanged (soft-fail), then the
    // deterministic replacement-pairs below still fire.
    if let Some(cleaned) = maybe_run_winstt_dictation_llm(app, &final_text).await {
        if cleaned != final_text {
            post_processed_text = Some(cleaned.clone());
            final_text = cleaned;
        }
    }
    // Deterministic dictionary replacement-pairs (snippet/expansion safety net, gap 5)
    // — guaranteed fire regardless of LLM provider, applied to the final text before
    // paste (mirrors process_text's apply_replacement_pairs tail).
    {
        let ws = crate::winstt::commands::settings::read_settings(app);
        let pairs: Vec<(String, String)> = ws
            .dictionary
            .iter()
            .filter_map(|d| {
                d.replacement
                    .as_ref()
                    .filter(|r| !r.is_empty())
                    .map(|r| (d.term.clone(), r.clone()))
            })
            .collect();
        if !pairs.is_empty() {
            let expanded = crate::winstt::llm::apply_replacement_pairs(&final_text, &pairs);
            if expanded != final_text {
                post_processed_text = Some(expanded.clone());
                final_text = expanded;
            }
        }
    }
```

Then add the helper function at module scope in actions.rs (place near `post_process_transcription`):
```rust
/// Run the WinSTT dictation LLM compose (Ollama / OpenRouter / Apple Intelligence)
/// over `text`, folding the user's presets + dictionary/snippets + focused-window
/// context into the system prompt. Returns `Some(cleaned)` when the LLM ran (or
/// `Some(text)` on soft-fail so the caller still applies replacement pairs);
/// returns `None` when dictation LLM is disabled. Mirrors relay.ts maybeRunLlm +
/// resolveLlmContext + processText.
async fn maybe_run_winstt_dictation_llm(app: &AppHandle, text: &str) -> Option<String> {
    use crate::winstt::llm::{self, build_dictation_system_prompt, Vocab};
    use crate::winstt::settings_schema::LlmProvider;
    let ws = crate::winstt::commands::settings::read_settings(app);
    if !ws.llm.dictation.enabled {
        return None;
    }
    // Build the preset list (builtins + enabled custom modifiers) the same way the
    // process_text command does. The conversion helpers live in winstt::commands::llm;
    // re-derive inline here to avoid a cross-command dependency.
    let presets = crate::winstt::commands::llm::dictation_presets_for(&ws);
    // Focused-window context (deny-list gated). Empty when context_awareness is off
    // or the sidecar is missing.
    let context = if ws.general.context_awareness {
        app.try_state::<std::sync::Arc<crate::winstt::managers::ContextManager>>()
            .map(|cm| {
                cm.capture_fragment(
                    crate::winstt::context::ContextMode::Focused,
                    &ws.general.context_deny_list,
                )
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    let vocab = Vocab {
        dictionary: ws.dictionary.iter().map(|d| d.term.clone()).collect(),
        replacement_pairs: ws
            .dictionary
            .iter()
            .filter_map(|d| d.replacement.as_ref().filter(|r| !r.is_empty()).map(|r| (d.term.clone(), r.clone())))
            .collect(),
        snippets: ws.snippets.iter().map(|s| (s.trigger.clone(), s.expansion.clone())).collect(),
    };
    let system_prompt = build_dictation_system_prompt(&presets, &context, &vocab);
    let effort = crate::winstt::commands::llm::to_llm_effort_for(ws.llm.dictation.base.thinking_effort);
    let mgr = app
        .try_state::<std::sync::Arc<crate::winstt::managers::LlmManager>>()?
        .inner()
        .clone();
    let request_id = mgr.next_request_id();
    let answer = match ws.llm.dictation.base.provider {
        LlmProvider::Openrouter => {
            let user_prompt = llm::dictation_user_prompt(text);
            mgr.openrouter_chat(
                &ws.llm.openrouter_api_key,
                &ws.llm.dictation.base.openrouter_model,
                &system_prompt,
                &user_prompt,
                text,
            )
            .await
            .unwrap_or_else(|_| text.to_string())
        }
        LlmProvider::AppleIntelligence => text.to_string(),
        LlmProvider::Ollama => mgr
            .ollama_dictation(
                &ws.llm.endpoint,
                &ws.llm.dictation.base.model,
                &system_prompt,
                text,
                effort,
                &request_id,
            )
            .await
            .unwrap_or_else(|_| text.to_string()),
    };
    Some(answer)
}
```
DEPENDENCY: this references two small reusable helpers that must be made `pub(crate)` in `winstt/commands/llm.rs` (see shared edit on that file): `pub(crate) fn dictation_presets_for(settings:&WinsttSettings)->Vec<LlmPresetEntry>` (rename/expose the existing private `dictation_presets`) and `pub(crate) fn to_llm_effort_for(e:SettingsEffort)->LlmEffort` (expose the existing private `to_llm_effort`). If you prefer zero edits to llm.rs, inline both conversions in actions.rs instead (the preset→prompt mapping + the 4-arm effort match). RISK: this makes `process_transcription_output` await network I/O on the dictation paste path; it already awaits `post_process_transcription` for the post_process binding, so the async signature + spawn context (it's called inside the `tauri::async_runtime::spawn` block in TranscribeAction::stop) is unchanged. The overlay 'thinking' pill is NOT auto-shown here (relay.ts shows it via maybeRunLlm); optionally emit LLM_PROCESSING_START/END around the call if the renderer needs it.

### SHARED_EDIT[5] FILE: app/src-tauri/src/winstt/commands/llm.rs
ANCHOR:
fn dictation_presets(settings: &WinsttSettings) -> Vec<LlmPresetEntry> {
CHANGE:
Expose the two conversion helpers actions.rs reuses (gap 2 dependency). Rename `fn dictation_presets` -> `pub(crate) fn dictation_presets_for` (update the one call site in `process_text` from `dictation_presets(&settings)` to `dictation_presets_for(&settings)`), and add a thin pub re-export for the effort mapping. Concretely:
1. Change the signature line to:
```rust
pub(crate) fn dictation_presets_for(settings: &WinsttSettings) -> Vec<LlmPresetEntry> {
```
2. In `process_text`, change `let presets = dictation_presets(&settings);` to `let presets = dictation_presets_for(&settings);`.
3. Add next to `to_llm_effort`:
```rust
pub(crate) fn to_llm_effort_for(e: SettingsEffort) -> LlmEffort {
    to_llm_effort(e)
}
```
(Alternatively keep llm.rs untouched and inline both in actions.rs — see the note on the actions.rs edit.)

### SHARED_EDIT[6] FILE: app/src-tauri/src/audio_toolkit/audio/recorder.rs
ANCHOR:
    pub fn with_level_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(Vec<f32>) + Send + Sync + 'static,
    {
        self.level_cb = Some(Arc::new(cb));
        self
    }
CHANGE:
WAKEWORD + LOOPBACK per-chunk tap (gap 4) — STRUCTURAL PREREQUISITE. The recorder currently exposes ONLY a spectrum-level callback (`with_level_callback`, passes `Vec<f32>` LEVELS not raw samples). Wakeword `feed_chunk(&[f32])` and listen-mode loopback consumption need the raw 16 kHz mono f32 chunks. Add a second optional callback that fires with the RAW resampled chunk in the consumer loop.

1. Add a field on the struct (next to `level_cb`):
```rust
    chunk_cb: Option<Arc<dyn Fn(&[f32]) + Send + Sync + 'static>>,
```
and initialize it `chunk_cb: None,` in `AudioRecorder::new()`.
2. Add the builder right after `with_level_callback`:
```rust
    /// Fires with each raw 16 kHz mono f32 chunk as it arrives (BEFORE VAD gating),
    /// for wake-word KWS feed + listen-mode taps. Always-on so wakeword/listen can
    /// observe audio even when not 'recording'.
    pub fn with_chunk_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(&[f32]) + Send + Sync + 'static,
    {
        self.chunk_cb = Some(Arc::new(cb));
        self
    }
```
3. In `open()`, clone it alongside `let level_cb = self.level_cb.clone();` → add `let chunk_cb = self.chunk_cb.clone();` and move it into the worker.
4. In the consumer loop, where each `raw` chunk is obtained from `sample_rx.recv()` (around recorder.rs line ~450, the `let raw = match chunk { ... }` that yields the resampled `Vec<f32>` fed to `handle_frame`), invoke the tap right before VAD:
```rust
            if let Some(cb) = chunk_cb.as_ref() {
                cb(&raw);
            }
```
(Use the variable that holds the 16 kHz mono f32 samples for this chunk — confirm the exact binding name in the consumer match arm; it is the `Vec<f32>` passed into `handle_frame`.) This callback fires for EVERY chunk while the stream is open (independent of `recording`), which is what wakeword/listen need.

### SHARED_EDIT[7] FILE: app/src-tauri/src/managers/audio.rs
ANCHOR:
        .with_level_callback({
            let app_handle = app_handle.clone();
            move |levels| {
CHANGE:
WAKEWORD + LOOPBACK trigger consumers (gap 4) — wire the raw-chunk tap to the wakeword detector + listen-mode start. In `create_audio_recorder`, chain a `.with_chunk_callback` onto the `AudioRecorder` builder (after `.with_level_callback({...})`). It feeds each chunk to the WakeWordManager while wakeword mode is armed and starts the dictation pipeline on a hit; for listen mode the LoopbackManager is the producer (separate path), but the mic chunk tap is where wakeword triggers.

ADD after the `.with_level_callback({...})` closing block:
```rust
        .with_chunk_callback({
            let app_handle = app_handle.clone();
            move |chunk| {
                // Wakeword: while armed (recorder in wakeword mode), feed each chunk
                // to the KWS detector. On a hit, start the shared dictation pipeline
                // (recording -> transcribe -> paste) via the coordinator, exactly as a
                // hotkey press would, then disarm for `wakeWordTimeout` (the manager
                // owns the timeout). Mirrors the server wakeword backend trigger.
                if let Some(ww) = app_handle.try_state::<std::sync::Arc<crate::winstt::managers::WakeWordManager>>() {
                    if ww.is_armed() {
                        let result = ww.feed_chunk(chunk);
                        if result.detected {
                            if let Some(coordinator) = app_handle.try_state::<crate::TranscriptionCoordinator>() {
                                // Start a dictation session (toggle-style: a single
                                // explicit start; VAD silence ends it). push_to_talk:false
                                // + is_pressed:true => Stage::Idle -> start.
                                coordinator.send_input("transcribe", "", true, false);
                            }
                        }
                    }
                }
            }
        })
```
NOTE on listen/loopback: the loopback stream is a SEPARATE producer (LoopbackManager owns its own WASAPI worker — see its `start()` SPIKE), not the mic recorder. To make listen-mode actually drive transcription, the LoopbackManager's worker must push its AGC'd 16 kHz f32 blocks into the SAME recording pipeline (the recorder consumer mpsc as a 2nd producer) and the listen session must be started via `coordinator.send_input("transcribe", "", true, false)` when `start_listen` runs; that producer-injection is internal to LoopbackManager::start (a managers/* OWNED file edit, not this shared file). The shared-file hook here is ONLY the wakeword mic tap. Also: `WakeWordResult` must expose `.detected` (it does) — confirm `is_armed()`/`feed_chunk` are the manager's public API (they are). The wakeword arming itself (set_armed(true) on entering wakeword mode) is driven by the mode-change handler in the recording-mode slice, not this callback.

IMPORT NOTE: `crate::TranscriptionCoordinator` is re-exported from lib.rs; `coordinator.send_input` takes `(binding_id, hotkey_string, is_pressed, push_to_talk)`.

