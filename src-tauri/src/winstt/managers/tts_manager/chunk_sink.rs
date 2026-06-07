// The renderer chunk-emit unit: `EmitChunkSink` (a delay-one-chunk buffer that
// stamps `is_final` on the true last chunk + polls the shared cancel flag) with
// its `ChunkSink` impl, the `chunk_payload` `tts:chunk` wire builder, and the
// `kitten_model_filename` catalog helper. Self-contained — referenced only where
// `read_aloud` constructs the sink.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use crate::winstt::tts::{ChunkSink, Format, SynthesisChunk};

/// The Kitten ONNX graph filename for a catalog id (both nano models share the
/// `voices.npz`; only the graph file differs per version). Kept in sync with the
/// download manager's `kitten_model_file`.
pub(super) fn kitten_model_filename(model_id: &str) -> &'static str {
    match model_id {
        "kitten-nano-0.2" => "kitten_tts_nano_v0_2.onnx",
        _ => "kitten_tts_nano_v0_1.onnx",
    }
}

/// Build the `tts:chunk` event payload. `pcm` carries RAW BYTES the renderer
/// interprets PER FORMAT:
///   - "f32le": `new Float32Array(pcm)` reads it as little-endian f32 PCM.
///   - "mp3":   `decodeAudioData(pcm)` decodes the mp3 container.
///
/// (Serde serializes the `Vec<u8>` as a JSON number array; the adapter reshapes
/// it back to an `ArrayBuffer` — see WU-5 risks.)
pub(super) fn chunk_payload(request_id: &str, chunk: &SynthesisChunk) -> serde_json::Value {
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
    serde_json::json!({
        "requestId": request_id,
        "sampleRate": chunk.sample_rate,
        "seq": chunk.seq,
        "isFinal": chunk.is_final,
        "format": chunk.format.as_str(),
        "channels": chunk.channels,
        "pcm": pcm_bytes,
    })
}

/// A `ChunkSink` that emits each synthesized chunk to the renderer over the
/// `tts:chunk` event, with a DELAY-ONE-CHUNK buffer so the LAST chunk of the
/// whole read can carry `is_final = true` (the renderer's queue `markComplete()`s
/// exactly once on that flag). Polls a shared cancel flag between sentences.
pub(super) struct EmitChunkSink {
    pub(super) app: AppHandle,
    pub(super) request_id: String,
    pub(super) cancelled: Arc<AtomicBool>,
    /// The previously-pushed chunk, held back until the next one arrives so we can
    /// stamp `is_final` on the true last chunk.
    pub(super) last_chunk: Mutex<Option<SynthesisChunk>>,
    /// Monotonic per-read seq for the chunk stream.
    pub(super) seq: AtomicU64,
}

impl EmitChunkSink {
    fn emit(&self, chunk: &SynthesisChunk) {
        let _ = self
            .app
            .emit("tts:chunk", chunk_payload(&self.request_id, chunk));
    }

    /// Emit the held-back chunk (if any) with `is_final = true`. Called once at the
    /// end of a read so the renderer queue closes the request exactly once.
    pub(super) fn flush_final(&self) {
        if let Ok(mut held) = self.last_chunk.lock() {
            if let Some(mut chunk) = held.take() {
                chunk.is_final = true;
                self.emit(&chunk);
            }
        }
    }
}

impl ChunkSink for EmitChunkSink {
    fn push(&self, mut chunk: SynthesisChunk) -> bool {
        if self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        // Skip empty (silent) chunks so the renderer never schedules a zero-length
        // buffer — matches the facade's `samples.is_empty() → continue`.
        let empty = match chunk.format {
            Format::F32le => chunk.audio.is_empty(),
            Format::Mp3 => chunk.encoded.is_empty(),
        };
        if empty {
            return true;
        }
        chunk.seq = self.seq.fetch_add(1, Ordering::Relaxed);
        chunk.is_final = false;
        // Delay-one-chunk: flush the previously-held chunk (NOT final — another came
        // after), and hold THIS one until the next push / flush_final.
        if let Ok(mut held) = self.last_chunk.lock() {
            if let Some(prev) = held.replace(chunk) {
                self.emit(&prev);
            }
        }
        true
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}
