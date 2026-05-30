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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use crate::winstt::tts::{
    split_sentences, ChunkSink, ElevenLabsEngine, KokoroLocalEngine, LocalTtsConfig, SynthesisChunk,
    TtsEngine, TtsError, TtsResult, TtsSource, CloudVoiceSettings, DEFAULT_MAX_SENTENCE_LEN,
    KOKORO_VOICE_CATALOG, clamp_speed,
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
        }
    }

    pub fn next_request_id(&self) -> String {
        format!("tts-{}", self.seq.fetch_add(1, Ordering::Relaxed))
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

    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut m) = self.cancelled.lock() {
            m.insert(request_id.to_string(), true);
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut m) = self.cancelled.lock() {
            for v in m.values_mut() {
                *v = true;
            }
        }
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
    pub fn read_aloud(
        &self,
        request_id: &str,
        text: &str,
        voice: &str,
        lang: &str,
        get_speed: impl Fn() -> f32,
    ) -> TtsResult<()> {
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
        result
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
        // Mirror the renderer playback-queue wire shape (06_* §SynthesisChunk).
        let pcm: &[f32] = &chunk.audio;
        let encoded: &[u8] = &chunk.encoded;
        let payload = serde_json::json!({
            "requestId": self.request_id,
            "sampleRate": chunk.sample_rate,
            "seq": chunk.seq,
            "isFinal": chunk.is_final,
            "format": chunk.format.as_str(),
            "channels": chunk.channels,
            "pcm": pcm,
            "encoded": encoded,
        });
        self.app.emit("tts://chunk", payload).is_ok()
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.lock().map(|c| *c).unwrap_or(true)
    }
}
