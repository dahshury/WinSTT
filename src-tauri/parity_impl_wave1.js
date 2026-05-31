export const meta = {
  name: 'winstt-parity-implement-wave1',
  description: 'Implement the stubbed WinSTT-port features in parallel (disjoint file ownership); hub edits returned as instructions',
  phases: [
    { title: 'Implement', detail: '8 parallel implementers on disjoint files + 1 hub-wiring planner' },
  ],
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['feature', 'status', 'files_edited', 'shared_file_instructions', 'cargo_additions', 'lib_mod_registration', 'risk', 'summary'],
  properties: {
    feature: { type: 'string' },
    status: { type: 'string', enum: ['implemented', 'partial', 'blocked'] },
    files_edited: { type: 'array', items: { type: 'string' } },
    shared_file_instructions: {
      type: 'array',
      description: 'EXACT edits the integrator must apply to SHARED files (transcription.rs/actions.rs/coordinator/etc.)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'anchor', 'change'],
        properties: {
          file: { type: 'string' },
          anchor: { type: 'string', description: 'a unique existing snippet to locate the edit point' },
          change: { type: 'string', description: 'the code to insert/replace + how' },
        },
      },
    },
    cargo_additions: { type: 'string', description: 'exact Cargo.toml dep/feature lines to add, or none' },
    lib_mod_registration: { type: 'string', description: 'commands to add to collect_commands! in lib.rs + any pub mod declarations needed, or none' },
    risk: { type: 'string' },
    summary: { type: 'string' },
  },
}

const RULES = [
  'You implement ONE feature in the WinSTT Rust/Tauri PORT to reach functional parity with the Electron+Python REFERENCE. Repo root E:/DL/Projects/WinSTT/.',
  '- PORT backend: app/src-tauri/src/  (Handy base in src/{actions.rs,managers/,shortcut/,lib.rs,commands/}; WinSTT slice in src/winstt/{commands/,managers/,llm/,stt/,tts/, *.rs}).',
  '- REFERENCE Python STT server: server/src/  .  REFERENCE Electron: frontend/ (electron/ipc/*.ts handlers, src/ renderer).',
  'HARD RULES:',
  '1. Edit ONLY the files in OWNED_FILES. Make them REAL, COMPLETE, COMPILING implementations - remove every SPIKE/TODO/not-yet stub in them; no placeholders.',
  '2. NEVER edit these SHARED files: src/lib.rs, src/managers/transcription.rs, src/actions.rs, src/transcription_coordinator.rs, src/winstt/mod.rs, src/winstt/commands/mod.rs, src/winstt/managers/mod.rs, Cargo.toml, and any other file not in OWNED_FILES. For changes those need, return them in shared_file_instructions (exact anchor + code) / cargo_additions / lib_mod_registration.',
  '3. Ground behavior in the REFERENCE: read server/src/ (Python algorithm/params) and frontend/electron/ipc/ (IPC contract) for the CORRECT behavior, plus the existing port code. Match params exactly.',
  '4. You CANNOT compile (build needs MSVC + ~6min). Write against the REAL crate APIs - read installed sources under C:/Users/MASTE/.cargo/registry/src/ when unsure (ort 2.0.0-rc.12, wasapi, symphonia 0.6.0, tokenizers, sherpa-onnx 1.13.2, ndarray 0.17, reqwest). Match the existing code style/imports.',
  '5. Reuse crates already in Cargo.toml; only report a NEW dep in cargo_additions if truly required.',
  'Return the structured result describing exactly what you changed + what the integrator must wire.',
].join('\n')

const AGENTS = [
  {
    key: 'file_transcribe',
    label: 'impl:file-transcribe-decode',
    prompt: [
      'FEATURE: file transcription audio decode (drag-drop files to 16kHz mono f32).',
      'GAP: app/src-tauri/src/winstt/managers/file_transcribe_manager.rs decode_audio_to_pcm() returns Err(file audio decode not yet wired) (~line 679). The queue/progress/VAD-chunk pipeline around it is real; only the decode is stubbed.',
      'OWNED_FILES: app/src-tauri/src/winstt/managers/file_transcribe_manager.rs',
      'TASK: implement decode_audio_to_pcm via symphonia 0.6.0 (features already present: wav/mp3/isomp4/aac/flac/ogg/vorbis): probe format, decode all packets, downmix to mono, resample to 16kHz f32. NOTE symphonia 0.6 reworked the API vs 0.5 (FormatReader::next_packet returns Result of Option of Packet; read the crate src under .cargo for get_probe/get_codecs/SampleBuffer). Use a stateful resampler matching the project recording-resample-quality approach (rubato may be a dep; else linear is acceptable but note it). Reference behavior: server file transcription decodes any audio/video to 16k mono. Make it robust to varied sample rates/channels.',
    ].join('\n'),
  },
  {
    key: 'transforms',
    label: 'impl:transforms-provider',
    prompt: [
      'FEATURE: Transforms (user text rewrites via LLM) - route to the configured provider + real apply.',
      'GAP: app/src-tauri/src/winstt/commands/transforms.rs apply_transform/apply_transform_preview (~lines 297-298, 401-403) ALWAYS call mgr.ollama_transform(...) regardless of provider. Also the global transforms-hotkey listener is absent (reference: frontend/electron/ipc/transform-hotkeys.ts).',
      'OWNED_FILES: app/src-tauri/src/winstt/commands/transforms.rs',
      'TASK: read app/src-tauri/src/winstt/managers/llm_manager.rs (READ ONLY) to find the per-provider transform/compose methods; route apply_transform + apply_transform_preview to the provider selected in settings (Ollama / OpenRouter / OpenAI-compat / AppleIntelligence) instead of hardcoding ollama. Implement the clipboard-sandwich selection-capture fallback (Ctrl+C + read + restore) that is currently a SPIKE (~lines 25,181,188) so selections UIA cannot read still work. For the missing global hotkey (transforms.hotkey, default LCtrl+LShift+T): return shared_file_instructions describing how to register it in src/shortcut/ + an action that captures selection, transforms, pastes (mirror the dictation hotkey path). Reference: frontend/electron/ipc/transform-hotkeys.ts + transforms IPC.',
    ].join('\n'),
  },
  {
    key: 'wakeword',
    label: 'impl:wakeword-detector',
    prompt: [
      'FEATURE: wakeword detection (sherpa-onnx KWS) that triggers dictation.',
      'GAP: app/src-tauri/src/winstt/managers/wakeword_manager.rs rebuild_detector (~168-177) unconditionally sets detector=None (SPIKE); feed_chunk/set_armed (~128-153) have ZERO call sites; the real WakeWordDetector::new (wakeword.rs:429) is never built. Note the cfg(feature=sherpa) gates (~51,65,139,167,179).',
      'OWNED_FILES: app/src-tauri/src/winstt/wakeword.rs, app/src-tauri/src/winstt/managers/wakeword_manager.rs',
      'TASK: make rebuild_detector actually build WakeWordDetector::new from the selected wakeword model (sherpa-onnx KWS - read the sherpa-onnx 1.13.2 crate src under .cargo for the KeywordSpotter API); implement feed_chunk to run detection on 16k f32 chunks and return a detected-keyword signal; honor set_armed. Resolve the cfg(feature=sherpa) gates - if the sherpa feature must be enabled, report it in cargo_additions (the sherpa-onnx dep is already present, linked shared). Reference: server/src/recorder/infrastructure for the OWW/Porcupine-to-onnx wakeword behavior + the model/threshold params. For wiring feed_chunk into the live audio loop + firing the wake_word_detected event to start dictation, return shared_file_instructions for transcription_coordinator.rs/actions.rs (the audio consumer must call feed_chunk while wakeword mode is active and start the recording pipeline on detect).',
    ].join('\n'),
  },
  {
    key: 'loopback',
    label: 'impl:loopback-capture',
    prompt: [
      'FEATURE: system-audio listen/loopback capture (transcribe what is playing).',
      'GAP: app/src-tauri/src/winstt/managers/loopback_manager.rs start() (~93-108) only flips an atomic capturing flag and never opens capture (Until the native loop lands, mark capturing); the real Loopback in loopback.rs is never used.',
      'OWNED_FILES: app/src-tauri/src/winstt/loopback.rs, app/src-tauri/src/winstt/managers/loopback_manager.rs',
      'TASK: implement real WASAPI loopback capture (the wasapi crate is a Windows dep - read its src under .cargo for the loopback/render-endpoint capture API), producing 16kHz mono f32 chunks on a background thread, start/stop controllable, delivered to a callback/channel. Reference: server loopback/listen mode + the project memory on WASAPI loopback (start_loopback must NOT block the async loop). Initialize COM/MTA correctly (loopback.rs already references initialize_mta). For delivering captured audio into the transcription pipeline, return shared_file_instructions (how the coordinator/audio path should consume the loopback stream while listen mode is active).',
    ].join('\n'),
  },
  {
    key: 'cloud_stt',
    label: 'impl:cloud-stt-wiring',
    prompt: [
      'FEATURE: cloud STT (OpenAI whisper-1/gpt-4o-transcribe, ElevenLabs scribe_v1) selectable + invoked.',
      'GAP: app/src-tauri/src/winstt/managers/cloud_stt_manager.rs transcribe/do_upload (multipart upload, ~94-174) is fully implemented but NEVER invoked by the live pipeline; transcription.rs initiate_model_load has no cloud branch; the Rust catalog (catalog_data.rs / catalog.rs) has NO openai/elevenlabs cloud entries (reference ships frontend/electron/ipc/stt-cloud.ts + a cloud-stt-provider catalog).',
      'OWNED_FILES: app/src-tauri/src/winstt/cloud_stt.rs, app/src-tauri/src/winstt/managers/cloud_stt_manager.rs, app/src-tauri/src/winstt/commands/catalog_data.rs',
      'TASK: verify cloud_stt_manager.transcribe is correct vs frontend/electron/ipc/stt-cloud.ts (endpoints, multipart fields, response parsing, scoped-key handling). Add the cloud-STT catalog rows (openai:whisper-1, openai:gpt-4o-transcribe, elevenlabs:scribe_v1, etc. - match the reference cloud provider list) into catalog_data.rs so the picker shows them. The model-id convention is provider:id (settings_schema ModelSettings.model doc). For the LIVE invocation, return shared_file_instructions for transcription.rs: in transcribe()/load path, when the selected model id starts with openai:/elevenlabs: (or is a cloud provider id), route the audio to cloud_stt_manager.transcribe instead of the local engine. Read app/src/shared/api/electron-tauri-adapter.ts to confirm the cloud channels.',
    ].join('\n'),
  },
  {
    key: 'word_ts',
    label: 'impl:word-timestamps-dtw',
    prompt: [
      'FEATURE: word timestamps / karaoke word-highlight (cross-attention DTW). HARDEST item - flag risk honestly.',
      'GAP: app/src-tauri/src/winstt/managers/word_aligner.rs try_load_engine (~70-77) always returns None, so align_words always returns Ok(empty vec); whisper.rs WhisperHf works but the cross_attentions output path the aligner needs is not enabled (mod.rs:222-224 notes the timestamped exports).',
      'OWNED_FILES: app/src-tauri/src/winstt/managers/word_aligner.rs, app/src-tauri/src/winstt/word_timestamps.rs, app/src-tauri/src/winstt/stt/whisper.rs',
      'REFERENCE: the onnx-asr fork at E:/DL/Projects/onnx-asr/src/onnx_asr/models/whisper/_hf.py (_decoding_with_cross_attention, _cross_attention_output_names) + asr.py word-split, and the WinSTT server word-timestamp path (server/src/recorder, the timestamped models + alignment heads + DTW).',
      'TASK: in whisper.rs, when the loaded export exposes cross_attentions.* outputs, collect them across decode steps (the engine already gates has_cross_attention). In word_aligner.rs/word_timestamps.rs, implement the cross-attention DTW: stack per-layer cross-attn, select alignment heads (per model size table), DTW align decoder tokens to encoder frames, per-word start/end seconds (split tokens into words on the leading-space marker). try_load_engine must load a timestamped Whisper variant via the existing engine. HONESTLY assess feasibility: the merged-decoder multi-token cache bug (project memory) can scramble cross-attn; if a correct DTW is not achievable without a re-export, implement what you can and set status=partial with a precise risk note. Return any whisper.rs signature changes the aligner needs.',
    ].join('\n'),
  },
  {
    key: 'snippets',
    label: 'impl:snippets-expansion',
    prompt: [
      'FEATURE: Snippets / text expansion (type a trigger to expand to replacement) - currently entirely absent in the port backend.',
      'GAP: the Snippets settings UI exists (verbatim renderer) but there is NO deterministic snippet-expansion backend; the only replacement-pairs path runs inside the LLM process_text command which has no live caller.',
      'OWNED_FILES: create app/src-tauri/src/winstt/snippets.rs (new) and, if needed, a new app/src-tauri/src/winstt/commands/snippets.rs (new).',
      'TASK: read the REFERENCE snippets behavior in frontend/ (grep snippet) + the snippets settings schema in app/src-tauri/src/winstt/settings_schema.rs and the renderer app/src/widgets/snippets-settings. Implement: a snippets store (load from the winstt settings) + an expansion engine that, given dictated/typed text, applies trigger-to-replacement substitutions (whole-word/boundary rules matching the reference). Expose Tauri commands for CRUD/list if the reference has them. Return lib_mod_registration (pub mod snippets; + commands to register) and shared_file_instructions for actions.rs (apply snippet expansion to the final text before paste, after custom-word correction).',
    ].join('\n'),
  },
  {
    key: 'renderer_sync',
    label: 'impl:dictionary-renderer-sync',
    prompt: [
      'FEATURE: push Dictionary (custom words) + related settings from the renderer to the backend so they take effect.',
      'GAP: app/src/features/update-settings/lib/sync-actions.ts only syncs initial_prompt statics (~245-258); it NEVER pushes custom_words / word_correction_threshold / custom_filler_words / snippets. The generated bindings updateCustomWords + changeWordCorrectionThresholdSetting (app/src/bindings.ts:104,267) have ZERO callers.',
      'OWNED_FILES: app/src/features/update-settings/lib/sync-actions.ts',
      'TASK: read sync-actions.ts + app/src/bindings.ts + the reference frontend sync (frontend/src/features/update-settings + frontend/electron installCustomWordsSync) to mirror the contract. Add sync wiring that, when the relevant settings change, calls the Tauri commands (via the electron-tauri-adapter / bindings) to push custom_words, word_correction_threshold, custom_filler_words, and snippets to the backend - matching how initial_prompt is already synced. Keep it TS, match the file style (no useMemo per project rules). If a backend command is missing, name it in summary so the integrator adds it.',
    ].join('\n'),
  },
  {
    key: 'hub_planner',
    label: 'plan:live-pipeline-wiring',
    prompt: [
      'You are the HUB-WIRING PLANNER. Do NOT edit any files - produce EXACT integration instructions the integrator will apply to the shared live-pipeline files.',
      'Read thoroughly: app/src-tauri/src/managers/transcription.rs, app/src-tauri/src/actions.rs, app/src-tauri/src/transcription_coordinator.rs, app/src-tauri/src/settings.rs, app/src-tauri/src/winstt/commands/settings.rs (read_settings / WinsttSettings), app/src-tauri/src/winstt/llm/ + managers/llm_manager.rs, app/src-tauri/src/winstt/managers/cloud_stt_manager.rs.',
      'Produce shared_file_instructions (exact anchor + code) for these LIVE-PATH gaps the audit found:',
      '1) DICTIONARY BRIDGE: transcription.rs transcribe() reads Handy settings.custom_words (~line 722) but nothing populates it from the WinSTT dictionary. Wire: read the WinSTT dictionary (custom words) + word_correction_threshold + custom_filler_words from read_settings(app) (winstt settings) and feed them into the apply_custom_words / filter_transcription_output calls (and/or the Whisper initial_prompt), so the real fuzzy matcher runs on the user actual word list.',
      '2) LLM POST-PROCESS ON PASTE: dictation runs TranscribeAction{post_process:false} (actions.rs ~761) so raw text is pasted; the WinSTT LLM compose/clean-up is never called. Wire: after transcription + custom-word correction, if the WinSTT LLM post-processing setting is enabled, route the text through the winstt LLM compose path (llm_manager) before paste. Mirror the reference relay.ts processText(text,context)-before-paste.',
      '3) CLOUD STT BRANCH: transcription.rs initiate_model_load/transcribe has no cloud branch; when the selected WinSTT model id is a cloud provider id (openai:/elevenlabs:...), route audio to cloud_stt_manager.transcribe instead of the local ort engine.',
      '4) WAKEWORD + LOOPBACK trigger consumers: where in the audio path the coordinator should call wakeword feed_chunk (while wakeword mode active) and consume the loopback stream (while listen mode active), starting the shared recording-to-transcribe-to-paste pipeline on trigger.',
      '5) SNIPPET EXPANSION: where in actions.rs to apply snippet expansion to the final text before paste.',
      'For EACH, give the precise file, a unique anchor snippet, and the exact code to insert/replace. Mark status=implemented (it is a plan). Put the integration order + risks in risk/summary.',
    ].join('\n'),
  },
]

phase('Implement')
log('Fanning out 8 disjoint-file implementers + 1 hub-wiring planner...')
const results = await parallel(
  AGENTS.map((a) => () =>
    agent(RULES + '\n\n' + a.prompt, { label: a.label, phase: 'Implement', schema: SCHEMA })
      .then((r) => (r ? { ...r, key: a.key } : { key: a.key, status: 'blocked', summary: 'agent returned null' }))
  )
)
const impl = results.filter((r) => r && r.status === 'implemented').length
const part = results.filter((r) => r && r.status === 'partial').length
const blk = results.filter((r) => r && r.status === 'blocked').length
log('Implementers done: ' + impl + ' implemented, ' + part + ' partial, ' + blk + ' blocked.')
return { results }
