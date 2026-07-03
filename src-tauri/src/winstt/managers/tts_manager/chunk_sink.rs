// The renderer chunk-emit unit: `EmitChunkSink` (immediate per-sentence emit +
// shared cancel flag) with its `ChunkSink` impl and the `chunk_payload`
// `tts:chunk` wire builder. Self-contained — referenced only where `read_aloud`
// constructs the sink.

use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::winstt::tts::{ChunkSink, Format, SynthesisChunk};

fn base64_padded_len(byte_len: usize) -> usize {
    byte_len.div_ceil(3) * 4
}

fn encode_base64(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(base64_padded_len(bytes.len()));
    base64::engine::general_purpose::STANDARD.encode_string(bytes, &mut encoded);
    encoded
}

/// Build the `tts:chunk` event payload. `pcm` carries the raw bytes BASE64-
/// encoded (Tauri events are JSON — a `Vec<u8>` would serialize as one JSON
/// number per byte, ~4× the size and far slower to stringify/parse than one
/// base64 string). The renderer's port boundary (`native-bridge-adapter.ts
/// reshape`) decodes it back to the `ArrayBuffer` the playback queue consumes:
///   - "f32le": `new Float32Array(pcm)` reads it as little-endian f32 PCM.
///   - "mp3":   `decodeAudioData(pcm)` decodes the mp3 container.
pub(super) fn chunk_payload(request_id: &str, chunk: &SynthesisChunk) -> serde_json::Value {
    let pcm_b64 = match chunk.format {
        Format::F32le => {
            let mut bytes = vec![0u8; chunk.audio.len() * 4];
            for (sample, slot) in chunk.audio.iter().zip(bytes.chunks_exact_mut(4)) {
                slot.copy_from_slice(&sample.to_le_bytes());
            }
            encode_base64(&bytes)
        }
        Format::Mp3 => encode_base64(chunk.encoded.as_ref()),
    };
    serde_json::json!({
        "requestId": request_id,
        "sampleRate": chunk.sample_rate,
        "seq": chunk.seq,
        "isFinal": chunk.is_final,
        "format": chunk.format.as_str(),
        "channels": chunk.channels,
        "pcm": pcm_b64,
    })
}

/// A `ChunkSink` that emits each synthesized chunk to the renderer over the
/// `tts:chunk` event AS SOON AS it is produced, and polls a shared cancel flag
/// between sentences. Chunks are never held back: the renderer ignores the
/// per-chunk `isFinal` flag and closes the request on the `tts:completed`
/// lifecycle event (emitted after the last chunk on the same thread, so
/// ordering is preserved) — holding a chunk until the NEXT sentence finished
/// synthesizing delayed first-audio by a whole sentence for no benefit.
pub(super) struct EmitChunkSink {
    pub(super) app: AppHandle,
    pub(super) request_id: String,
    pub(super) cancelled: CancellationToken,
    /// Monotonic per-read seq for the chunk stream.
    pub(super) seq: AtomicU64,
}

impl ChunkSink for EmitChunkSink {
    fn push(&self, mut chunk: SynthesisChunk) -> bool {
        if self.cancelled.is_cancelled() {
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
        let _ = self
            .app
            .emit("tts:chunk", chunk_payload(&self.request_id, &chunk));
        true
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.is_cancelled()
    }
}
