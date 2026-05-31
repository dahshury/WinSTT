// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/06_tts.md + lib_wiring.md §2,
// frontend/electron/ipc/{tts,tts-reader,tts-cloud}.ts. Tauri-state wrapper around winstt::tts.
//
// The `tts` slice already defines the engine port (`TtsEngine`), the local Kokoro
// + cloud ElevenLabs engines, the 54-voice catalog, sentence splitter, and a
// facade `tts::TtsManager` that drives gap-free sentence reads. This wrapper is
// the *Tauri-state* object: constructed with `new(&AppHandle)`, it re-picks the
// active engine from `tts.source` (+ key changes), bridges synthesis chunks to
// the `tts://chunk` event, and owns the per-request cancel set.
//
// Kept separate from `tts::TtsManager` (whose `new(source, engine)` is the
// pure-logic facade) so the Tauri-state object can hold the AppHandle + emit.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use crate::winstt::tts::{
    split_sentences, ChunkSink, ElevenLabsEngine, Format, KokoroLocalEngine, LocalTtsConfig,
    SynthesisChunk, TtsEngine, TtsError, TtsResult, TtsSource, CloudVoiceSettings,
    DEFAULT_MAX_SENTENCE_LEN, KOKORO_VOICE_CATALOG, clamp_speed,
};
use crate::winstt::tts::VoiceInfo;

/// Live engine + the source it was built for. Re-picked when `tts.source` or the
/// cloud key changes (the command layer calls `reload_engine`).
struct ActiveEngine {
    source: TtsSource,
    engine: Arc<dyn TtsEngine>,
}

/// Tauri-state TTS manager. Owns the active engine, serializes synthesis, drives
/// sentence-by-sentence reads, and forwards chunks to the renderer.
pub struct TtsManager {
    app: AppHandle,
    active: Mutex<ActiveEngine>,
    /// request_id → cancelled.
    cancelled: Mutex<HashMap<String, bool>>,
    seq: AtomicU64,
    /// Serializes synthesis (Kokoro sessions are not re-entrant).
    synth_lock: Mutex<()>,
    /// Live read-aloud speed (f32 bits). `read_aloud` samples this PER SENTENCE so
    /// a mid-read speed change from the pill's control applies to the NEXT sentence
    /// at natural pitch ("next-sentence" semantics — `tts.ts` `handleSetSpeed`).
    /// Stored as bits in an atomic so `tts_set_speed` can mutate it lock-free while
    /// the synthesis worker reads it.
    current_speed: AtomicU32,
}

impl TtsManager {
    pub fn new(app: &AppHandle) -> Self {
        // Default to the local Kokoro engine; the command layer reloads from
        // settings (source + voice + key) before the first real read.
        let engine: Arc<dyn TtsEngine> = Arc::new(KokoroLocalEngine::new(LocalTtsConfig::default()));
        Self {
            app: app.clone(),
            active: Mutex::new(ActiveEngine {
                source: TtsSource::Local,
                engine,
            }),
            cancelled: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
            synth_lock: Mutex::new(()),
            // Kokoro's natural rate is 1.0×; the command layer overrides this from
            // the persisted `tts.speed` before the first read.
            current_speed: AtomicU32::new(1.0_f32.to_bits()),
        }
    }

    pub fn next_request_id(&self) -> String {
        format!("tts-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    /// Set the live read-aloud speed (clamped to the engine's range). Applies to the
    /// active read's UPCOMING sentences (the playing sentence finishes at its current
    /// speed — natural-pitch "next-sentence" change) and to every subsequent read
    /// until changed. Mirrors `tts.ts` `handleSetSpeed`. Persisting the value to the
    /// settings store is the command layer's job (so a plain speed write doesn't flip
    /// the engine-active edge / re-fire warm-up).
    pub fn set_speed(&self, speed: f32) {
        self.current_speed
            .store(clamp_speed(speed).to_bits(), Ordering::Relaxed);
    }

    /// The live read-aloud speed sampled by `read_aloud` per sentence.
    pub fn current_speed(&self) -> f32 {
        f32::from_bits(self.current_speed.load(Ordering::Relaxed))
    }

    /// Emit a plain string lifecycle event with the EXACT WinSTT IPC shape so the
    /// reused renderer's `onTtsStarted` / `onTtsCompleted` / `onTtsFailed` listeners
    /// (which the adapter maps `TTS_STARTED`→`tts:started`, etc.) fire unchanged.
    /// camelCase keys to match `TtsStartedPayload` / `TtsCompletedPayload` /
    /// `TtsFailedPayload` in `ipc-client.ts`.
    fn emit_event(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }

    /// Rebuild the active engine for `source`. For local, `config` carries the
    /// cache dir + voice + device; for cloud, `cloud` carries the key/model/settings.
    pub fn reload_engine(
        &self,
        source: TtsSource,
        config: LocalTtsConfig,
        cloud: Option<(String, String, CloudVoiceSettings)>,
    ) {
        let engine: Arc<dyn TtsEngine> = match source {
            TtsSource::Local => Arc::new(KokoroLocalEngine::new(config)),
            TtsSource::Cloud => {
                let (key, model, settings) = cloud.unwrap_or_else(|| {
                    (String::new(), "eleven_multilingual_v2".into(), CloudVoiceSettings::default())
                });
                Arc::new(ElevenLabsEngine::new(key, model, settings))
            }
        };
        if let Ok(mut a) = self.active.lock() {
            a.source = source;
            a.engine = engine;
        }
    }

    fn engine(&self) -> Arc<dyn TtsEngine> {
        self.active.lock().map(|a| a.engine.clone()).unwrap()
    }

    pub fn source(&self) -> TtsSource {
        self.active
            .lock()
            .map(|a| a.source)
            .unwrap_or(TtsSource::Local)
    }

    /// Static 54-voice catalog (local picker). Cloud voices are fetched live.
    pub fn list_voices(&self) -> Vec<VoiceInfo> {
        KOKORO_VOICE_CATALOG.to_vec()
    }

    /// Force engine warm-up off the UI thread (download + session create / key
    /// check). The command layer calls this via `spawn_blocking`.
    pub fn warm_up(&self) -> TtsResult<()> {
        self.engine().warm_up()
    }

    /// Cancel one in-flight read. Sets the cooperative cancel flag AND optimistically
    /// emits a cancelled `tts:completed` so the renderer's Web Audio queue stops
    /// IMMEDIATELY — important when the engine already finished generating and the
    /// audio is only buffered client-side (the cooperative flag is a no-op then, but
    /// the buffered audio must still stop). Mirrors `tts.ts` `cancel(requestId)`.
    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut m) = self.cancelled.lock() {
            m.insert(request_id.to_string(), true);
        }
        self.emit_event(
            "tts:completed",
            serde_json::json!({ "requestId": request_id, "cancelled": true, "elapsedMs": null }),
        );
    }

    /// Cancel every in-flight read (STT force-stop / app exit / the stop gesture).
    /// Emits a cancelled `tts:completed` per tracked request plus a wildcard (empty
    /// id) completed so a queue that never saw a `tts:started` still stops. Mirrors
    /// `tts.ts` `cancel()` (no id).
    pub fn cancel_all(&self) {
        let ids: Vec<String> = if let Ok(mut m) = self.cancelled.lock() {
            for v in m.values_mut() {
                *v = true;
            }
            m.keys().cloned().collect()
        } else {
            Vec::new()
        };
        for id in ids {
            self.emit_event(
                "tts:completed",
                serde_json::json!({ "requestId": id, "cancelled": true, "elapsedMs": null }),
            );
        }
        // Wildcard fallback for the case where no id was ever tracked (the stop
        // gesture fires before the first `tts:started`).
        self.emit_event(
            "tts:completed",
            serde_json::json!({ "requestId": "", "cancelled": true, "elapsedMs": null }),
        );
    }

    fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled
            .lock()
            .map(|m| m.get(request_id).copied().unwrap_or(false))
            .unwrap_or(true)
    }

    /// Read `text` aloud sentence-by-sentence under ONE `request_id` so the
    /// renderer plays it gap-free. Each chunk is forwarded to the `tts://chunk`
    /// event. `get_speed` is sampled per sentence (mid-read speed change applies
    /// to the NEXT sentence). Blocking — the command runs it on a worker.
    ///
    /// Emits the three plain lifecycle events the reused renderer's
    /// `useTtsPlayback` hook subscribes to (`tts:started` before the first chunk,
    /// then exactly one terminal `tts:completed` / `tts:failed`), with the
    /// camelCase payload shapes of `TtsStartedPayload` / `TtsCompletedPayload` /
    /// `TtsFailedPayload`. Mirrors `tts.ts` `runRead` (`beginRequest` →
    /// `TTS_STARTED`, `endRequest` → `TTS_COMPLETED`/`TTS_FAILED`).
    pub fn read_aloud(
        &self,
        request_id: &str,
        text: &str,
        voice: &str,
        lang: &str,
        get_speed: impl Fn() -> f32,
    ) -> TtsResult<()> {
        // Register the request in the cancel set BEFORE emitting `tts:started` so a
        // cancel arriving immediately after start can name it (and `cancel_all`
        // enumerates it).
        if let Ok(mut m) = self.cancelled.lock() {
            m.entry(request_id.to_string()).or_insert(false);
        }
        let started = std::time::Instant::now();
        self.emit_event("tts:started", serde_json::json!({ "requestId": request_id }));

        let _guard = self.synth_lock.lock().map_err(|_| {
            TtsError::Engine("tts synth lock poisoned".into())
        })?;
        let sink = EmitChunkSink::new(self.app.clone(), request_id.to_string(), self);
        let engine = self.engine();
        let sentences = split_sentences(text, DEFAULT_MAX_SENTENCE_LEN);
        let mut result = Ok(());
        for sentence in sentences {
            if self.is_cancelled(request_id) || sink.is_cancelled() {
                result = Err(TtsError::Cancelled);
                break;
            }
            let speed = clamp_speed(get_speed());
            if let Err(e) = engine.synthesize_stream(&sentence, voice, lang, speed, &sink) {
                result = Err(e);
                break;
            }
        }
        // Mark the stream complete (one final lifecycle event) and clear cancel.
        if let Ok(mut m) = self.cancelled.lock() {
            m.remove(request_id);
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(()) => self.emit_event(
                "tts:completed",
                serde_json::json!({
                    "requestId": request_id,
                    "cancelled": false,
                    "elapsedMs": elapsed_ms,
                }),
            ),
            Err(TtsError::Cancelled) => self.emit_event(
                "tts:completed",
                serde_json::json!({
                    "requestId": request_id,
                    "cancelled": true,
                    "elapsedMs": elapsed_ms,
                }),
            ),
            Err(e) => self.emit_event(
                "tts:failed",
                serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
            ),
        }
        result
    }

    /// Play a cloud voice's FREE pre-generated sample (`preview_url`) instead of
    /// synthesizing — browsing voices costs no ElevenLabs credits. Fetches the mp3
    /// (key-free, https-only) and forwards it as ONE `tts://chunk` (mp3) under the
    /// same `tts:started` / `tts:completed` / `tts:failed` lifecycle a real read
    /// uses, so the settings UI's play/stop affordance tracks it identically.
    /// Mirrors `tts.ts` `handleCloudPreview` + `previewCloudClip`. Blocking — the
    /// command runs it on a worker.
    pub fn read_preview_url(&self, request_id: &str, preview_url: &str) {
        if let Ok(mut m) = self.cancelled.lock() {
            m.entry(request_id.to_string()).or_insert(false);
        }
        let started = std::time::Instant::now();
        self.emit_event("tts:started", serde_json::json!({ "requestId": request_id }));

        // The CDN preview is key-free; build a throwaway cloud engine just for the
        // https GET (refuses non-https). No synth lock — this is a plain download.
        let engine = ElevenLabsEngine::new(
            String::new(),
            "eleven_multilingual_v2".to_string(),
            CloudVoiceSettings::default(),
        );
        let result = engine.fetch_preview(preview_url);
        // Snapshot the cancel flag BEFORE clearing the entry so a cancel that landed
        // mid-fetch is still honored (drops the buffered preview).
        let was_cancelled = self.is_cancelled(request_id);
        if let Ok(mut m) = self.cancelled.lock() {
            m.remove(request_id);
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(bytes) if !was_cancelled => {
                let sink = EmitChunkSink::new(self.app.clone(), request_id.to_string(), self);
                sink.push(SynthesisChunk::mp3(bytes, 0, true));
                self.emit_event(
                    "tts:completed",
                    serde_json::json!({
                        "requestId": request_id,
                        "cancelled": false,
                        "elapsedMs": elapsed_ms,
                    }),
                );
            }
            Ok(_) => self.emit_event(
                "tts:completed",
                serde_json::json!({
                    "requestId": request_id,
                    "cancelled": true,
                    "elapsedMs": elapsed_ms,
                }),
            ),
            Err(e) => self.emit_event(
                "tts:failed",
                serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
            ),
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

/// A `ChunkSink` that emits each synthesized chunk to the renderer over the
/// `tts://chunk` event and polls the manager's cancel set between chunks.
struct EmitChunkSink {
    app: AppHandle,
    request_id: String,
    cancelled: Arc<Mutex<bool>>,
}

impl EmitChunkSink {
    fn new(app: AppHandle, request_id: String, _mgr: &TtsManager) -> Self {
        Self {
            app,
            request_id,
            cancelled: Arc::new(Mutex::new(false)),
        }
    }
}

impl ChunkSink for EmitChunkSink {
    fn push(&self, chunk: SynthesisChunk) -> bool {
        // Mirror the renderer playback-queue wire shape: `TtsChunkPayload.pcm` is a
        // byte buffer the renderer interprets PER FORMAT —
        //   - "f32le": `new Float32Array(pcm)` reads it as little-endian f32 PCM.
        //   - "mp3":   `decodeAudioData(pcm)` decodes the mp3 container.
        // So BOTH formats put their RAW BYTES into `pcm` (one field, uniform
        // recovery). For f32le we serialize the f32 samples to LE bytes; for mp3
        // we forward the encoded container bytes. The adapter reshapes the emitted
        // `number[]` back to an `ArrayBuffer` (see WU-5 libWiringNeeded / risks).
        let pcm_bytes: Vec<u8> = match chunk.format {
            Format::F32le => {
                let mut bytes = Vec::with_capacity(chunk.audio.len() * 4);
                for sample in chunk.audio.iter() {
                    bytes.extend_from_slice(&sample.to_le_bytes());
                }
                bytes
            }
            Format::Mp3 => chunk.encoded.to_vec(),
        };
        let payload = serde_json::json!({
            "requestId": self.request_id,
            "sampleRate": chunk.sample_rate,
            "seq": chunk.seq,
            "isFinal": chunk.is_final,
            "format": chunk.format.as_str(),
            "channels": chunk.channels,
            "pcm": pcm_bytes,
        });
        self.app.emit("tts://chunk", payload).is_ok()
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.lock().map(|c| *c).unwrap_or(true)
    }
}
