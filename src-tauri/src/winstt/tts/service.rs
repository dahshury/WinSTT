use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::winstt::cancel_registry::CancelRegistry;

use super::cloud::{CloudVoiceSettings, ElevenLabsEngine};
use super::local::KokoroLocalEngine;
use super::splitter::{split_sentences, DEFAULT_MAX_SENTENCE_LEN};
use super::types::{
    clamp_cloud_speed, clamp_speed, ChunkSink, Format, LocalTtsConfig, SentenceAudio,
    SynthesisChunk, TtsEngine, TtsError, TtsResult, VoiceInfo,
};

// ---------------------------------------------------------------------------
// TtsManager — host-facing facade (engine selection, sentence streaming, cancel)
// ---------------------------------------------------------------------------

/// Which source the user picked (`tts.source`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsSource {
    Local,
    Cloud,
}

/// Facade the Tauri command layer calls. Owns the active engine, serializes
/// synthesis, and drives sentence-by-sentence reads under one parent request id
/// (gap-free playback). Mirrors `tts_handler.py` (server) + `tts-reader.ts`.
pub struct TtsManager {
    source: TtsSource,
    engine: Arc<dyn TtsEngine>,
    /// Per-request cancel flags (set by a stop gesture / STT override / app exit).
    cancelled: CancelRegistry,
    /// Monotonic request-id counter (the command layer correlates the chunk
    /// stream + cancel by this id).
    next_id: AtomicU64,
}

impl TtsManager {
    pub fn new(source: TtsSource, engine: Arc<dyn TtsEngine>) -> Self {
        Self {
            source,
            engine,
            cancelled: CancelRegistry::new(),
            next_id: AtomicU64::new(1),
        }
    }

    /// A fresh, process-unique request id (`tts-<n>`). The renderer uses it to
    /// correlate the `tts://chunk` stream and to cancel the read.
    pub fn next_request_id(&self) -> String {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("tts-{n}")
    }

    /// Build a manager for the local Kokoro engine.
    pub fn local(config: LocalTtsConfig) -> Self {
        Self::new(TtsSource::Local, Arc::new(KokoroLocalEngine::new(config)))
    }

    /// Build a manager for the cloud ElevenLabs engine.
    pub fn cloud(api_key: String, model_id: String, settings: CloudVoiceSettings) -> Self {
        Self::new(
            TtsSource::Cloud,
            Arc::new(ElevenLabsEngine::new(api_key, model_id, settings)),
        )
    }

    pub fn source(&self) -> TtsSource {
        self.source
    }

    pub fn engine(&self) -> Arc<dyn TtsEngine> {
        self.engine.clone()
    }

    /// Voice catalog for the renderer picker. Local → static 54-voice catalog;
    /// cloud → live `/v2/voices` (host fetches separately, not via this method).
    pub fn list_voices(&self) -> Vec<VoiceInfo> {
        self.engine.list_voices()
    }

    /// Force engine warm-up off the UI thread (download + session create / key
    /// check). Idempotent.
    pub fn warm_up(&self) -> TtsResult<()> {
        self.engine.warm_up()
    }

    /// Mark a request cancelled — polled between sentences in `read_aloud`.
    pub fn cancel(&self, request_id: &str) {
        self.cancelled.cancel(request_id);
    }

    /// Cancel every in-flight read (stop-all gesture / STT force-stop / exit).
    pub fn cancel_all(&self) {
        self.cancelled.cancel_all();
    }

    pub(super) fn is_cancelled(&self, request_id: &str) -> bool {
        // Fail safe: a poisoned lock is treated as cancelled so a stuck read stops.
        self.cancelled.is_cancelled(request_id, true)
    }

    /// Read `text` aloud sentence-by-sentence under ONE `request_id` so the
    /// renderer plays it gap-free. `get_speed` is sampled per sentence (a
    /// mid-read speed change applies to the NEXT sentence; the playing one
    /// finishes at its own speed — re-synthesis, not playbackRate, so pitch
    /// stays natural). Mirrors `runSentenceRead` in tts-reader.ts.
    ///
    /// The LAST emitted chunk is flagged `is_final` (we delay one chunk to know
    /// which is last, mirroring the Python adapter). Returns `Cancelled` if a
    /// stop gesture fired between sentences. Empty / whitespace text → Ok no-op.
    pub fn read_aloud(
        &self,
        request_id: &str,
        text: &str,
        voice: &str,
        lang: &str,
        get_speed: impl Fn() -> f32,
        sink: &dyn ChunkSink,
    ) -> TtsResult<()> {
        self.cancelled.track(request_id);
        let sentences = split_sentences(text, DEFAULT_MAX_SENTENCE_LEN);
        if sentences.is_empty() {
            // Nothing to say — still resolve cleanly so the renderer queue closes.
            self.clear_cancel(request_id);
            return Ok(());
        }

        let mut seq: u64 = 0;
        // Delay-one-chunk buffer so the final chunk can carry is_final = true.
        let mut pending: Option<SynthesisChunk> = None;

        for sentence in &sentences {
            if self.is_cancelled(request_id) || sink.is_cancelled() {
                self.clear_cancel(request_id);
                return Err(TtsError::Cancelled);
            }
            let speed = self.clamp_for_source(get_speed());
            let rendered = self
                .engine
                .synthesize_sentence(sentence, voice, lang, speed)?;
            let chunk = match rendered {
                SentenceAudio::F32le {
                    samples,
                    sample_rate,
                } => {
                    if samples.is_empty() {
                        continue; // silent sentence → skip (no empty chunk)
                    }
                    SynthesisChunk::f32le(samples, sample_rate, seq, false)
                }
                SentenceAudio::Mp3 { bytes } => {
                    if bytes.is_empty() {
                        continue;
                    }
                    SynthesisChunk::mp3(bytes, seq, false)
                }
            };
            // Flush the previously-pending chunk (NOT final — another came after).
            if let Some(prev) = pending.take() {
                if !sink.push(prev) {
                    self.clear_cancel(request_id);
                    return Err(TtsError::Cancelled);
                }
            }
            pending = Some(chunk);
            seq += 1;
        }

        // Emit the last chunk with is_final = true.
        if let Some(mut last) = pending.take() {
            last.is_final = true;
            if !sink.push(last) {
                self.clear_cancel(request_id);
                return Err(TtsError::Cancelled);
            }
        }
        self.clear_cancel(request_id);
        Ok(())
    }

    fn clamp_for_source(&self, speed: f32) -> f32 {
        match self.source {
            TtsSource::Local => clamp_speed(speed),
            TtsSource::Cloud => clamp_cloud_speed(speed),
        }
    }

    fn clear_cancel(&self, request_id: &str) {
        self.cancelled.clear(request_id);
    }
}

// ---------------------------------------------------------------------------
// Tauri-event bridge — the sink-less entry point the command layer calls.
//
// The renderer's Web-Audio playback queue is byte-identical to WinSTT's the reference
// contract; only the transport swaps (`IPC.TTS_CHUNK` → the `tts://chunk` Tauri
// event). `read_aloud_emit` drives `read_aloud` with a sink that forwards each
// chunk as a `tts://chunk` event and fires the lifecycle events around it.
// ---------------------------------------------------------------------------

/// The `tts://chunk` event payload — the exact JSON field shape the renderer
/// playback queue already consumes. `pcm` carries the f32le
/// samples re-interpreted as bytes (local) or the encoded mp3 bytes (cloud).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TtsChunkPayload {
    pub request_id: String,
    pub sample_rate: u32,
    pub seq: u64,
    pub is_final: bool,
    pub format: &'static str,
    pub channels: u8,
    /// f32le bytes (little-endian) for local, or mp3 container bytes for cloud.
    pub pcm: Vec<u8>,
}

impl TtsChunkPayload {
    pub(super) fn from_chunk(request_id: &str, chunk: &SynthesisChunk) -> Self {
        let pcm = match chunk.format {
            Format::F32le => {
                // pack f32 samples as little-endian bytes
                let mut bytes = Vec::with_capacity(chunk.audio.len() * 4);
                for s in chunk.audio.iter() {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                bytes
            }
            Format::Mp3 => chunk.encoded.to_vec(),
        };
        Self {
            request_id: request_id.to_string(),
            sample_rate: chunk.sample_rate,
            seq: chunk.seq,
            is_final: chunk.is_final,
            format: chunk.format.as_str(),
            channels: chunk.channels,
            pcm,
        }
    }
}

/// Minimal emitter the host implements over Tauri's event bus. Keeps `mod.rs`
/// free of a hard `tauri` event-API dependency at this boundary (the command
/// layer wires a real `AppHandle`-backed impl) and makes the bridge unit-testable.
pub trait TtsEventEmitter: Send + Sync {
    /// Emit one `tts://chunk` event.
    fn emit_chunk(&self, payload: &TtsChunkPayload);
    /// Emit a lifecycle event (`tts://started` / `tts://completed` /
    /// `tts://failed`) by name with a JSON payload.
    fn emit_lifecycle(&self, event: &str, payload: serde_json::Value);
}

/// A `ChunkSink` that forwards chunks to a `TtsEventEmitter` as `tts://chunk`
/// events and polls a shared cancel flag (set by `TtsManager::cancel*`). The
/// manager's own per-request cancel map is the authority; this flag mirrors a
/// renderer-side "discard" that arrived after the sink was created.
struct EmitSink<'a> {
    request_id: String,
    emitter: &'a dyn TtsEventEmitter,
    cancel: &'a std::sync::atomic::AtomicBool,
}

impl ChunkSink for EmitSink<'_> {
    fn push(&self, chunk: SynthesisChunk) -> bool {
        if self.cancel.load(Ordering::Acquire) {
            return false;
        }
        let payload = TtsChunkPayload::from_chunk(&self.request_id, &chunk);
        self.emitter.emit_chunk(&payload);
        true
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }
}

impl TtsManager {
    /// Sink-less read: drive `read_aloud`, forwarding chunks to `emitter` as
    /// `tts://chunk` events and firing `tts://started` / `tts://completed` /
    /// `tts://failed` around the run. This is the entry point the Tauri command
    /// layer calls (it already runs on a `spawn_blocking` worker). `get_speed`
    /// is sampled per sentence (mid-read speed change → next sentence).
    pub fn read_aloud_emit(
        &self,
        request_id: &str,
        text: &str,
        voice: &str,
        lang: &str,
        get_speed: impl Fn() -> f32,
        emitter: &dyn TtsEventEmitter,
    ) {
        let started = std::time::Instant::now();
        emitter.emit_lifecycle(
            "tts://started",
            serde_json::json!({ "request_id": request_id }),
        );
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let sink = EmitSink {
            request_id: request_id.to_string(),
            emitter,
            cancel: &cancel,
        };
        let result = self.read_aloud(request_id, text, voice, lang, get_speed, &sink);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(()) => emitter.emit_lifecycle(
                "tts://completed",
                serde_json::json!({
                    "request_id": request_id,
                    "cancelled": false,
                    "elapsed_ms": elapsed_ms,
                }),
            ),
            Err(TtsError::Cancelled) => emitter.emit_lifecycle(
                "tts://completed",
                serde_json::json!({
                    "request_id": request_id,
                    "cancelled": true,
                    "elapsed_ms": elapsed_ms,
                }),
            ),
            Err(e) => emitter.emit_lifecycle(
                "tts://failed",
                serde_json::json!({
                    "request_id": request_id,
                    "reason": e.to_string(),
                    "category": tts_error_category(&e),
                }),
            ),
        }
    }
}

/// Coarse error category for the renderer's failure pill (mirrors WinSTT's
/// `category` field: NETWORK / ENGINE / CLOUD / INPUT).
pub fn tts_error_category(e: &TtsError) -> &'static str {
    match e {
        TtsError::Download(_) | TtsError::Paused => "NETWORK",
        TtsError::Engine(_) => "ENGINE",
        TtsError::Cloud(_) => "CLOUD",
        TtsError::Invalid(_) => "INPUT",
        TtsError::Cancelled => "CANCELLED",
    }
}
