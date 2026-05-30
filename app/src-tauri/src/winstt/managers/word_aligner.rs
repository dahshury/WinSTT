// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/05_*.md (Word-timestamps),
// onnx-asr/src/onnx_asr/word_timestamps.py (DTW + median filter + alignment heads + word grouping).
//
// WordAligner lazily loads the `whisper-tiny_timestamped` ort session and runs
// cross-attention DTW to produce per-word start/end seconds for history playback
// (karaoke highlight). The session is loaded on the FIRST `align_words` call and
// kept warm. The DTW + alignment-heads base85 table is the heavy bit (ort
// IoBinding gate); the lazy-load lifecycle + result shape compile unconditionally.

use std::sync::Arc;
use std::sync::Mutex;

use tauri::AppHandle;

use crate::winstt::stt::WordResult;

pub struct WordAligner {
    app: AppHandle,
    model_manager: Arc<crate::managers::model::ModelManager>,
    /// Lazily-initialized cross-attention DTW engine. `None` until first use.
    /// Boxed behind the `Transcriber` trait so the alignment engine can be the
    /// same whisper-tiny export with `cross_attentions.*` outputs.
    engine: Mutex<Option<Box<dyn crate::winstt::stt::Transcriber>>>,
}

impl WordAligner {
    pub fn new(app: &AppHandle, model_manager: Arc<crate::managers::model::ModelManager>) -> Self {
        Self {
            app: app.clone(),
            model_manager,
            engine: Mutex::new(None),
        }
    }

    /// Whether the alignment engine has been loaded yet.
    pub fn is_loaded(&self) -> bool {
        self.engine.lock().map(|e| e.is_some()).unwrap_or(false)
    }

    /// Produce per-word timings for `audio` (mono 16 kHz f32) given the known
    /// `text`. Lazily loads the timestamped whisper export on first call.
    ///
    /// Returns an empty vec when the alignment engine isn't available yet (the
    /// documented degrade: history playback falls back to no highlight).
    pub fn align_words(&self, audio: &[f32], text: &str) -> Result<Vec<WordResult>, String> {
        let mut guard = self.engine.lock().map_err(|_| "word aligner poisoned")?;
        if guard.is_none() {
            *guard = self.try_load_engine();
        }
        let Some(engine) = guard.as_mut() else {
            // SPIKE: engine load is gated on the ort cross-attention DTW wiring
            // (05_*.md). Until then, return no words (no highlight, text intact).
            let _ = (audio, text);
            return Ok(Vec::new());
        };

        let opts = crate::winstt::stt::TranscribeOptions {
            return_word_timestamps: true,
            ..Default::default()
        };
        match engine.transcribe(audio, &opts) {
            Ok(t) => Ok(t.words.unwrap_or_default()),
            Err(e) => Err(format!("word alignment failed: {e}")),
        }
    }

    /// Build the `whisper-tiny_timestamped` engine. SPIKE: resolve the model files
    /// via the ModelManager / hf-hub and call `winstt::stt::build_engine` once the
    /// engine factory is implemented. Returns None until then.
    fn try_load_engine(&self) -> Option<Box<dyn crate::winstt::stt::Transcriber>> {
        // SPIKE: resolve whisper-tiny_timestamped through the resolver, build the
        // WhisperHf engine with cross_attentions outputs, confirm
        // supports_word_timestamps(). build_engine currently returns Unsupported
        // (engines spec-only pending the ort de-risking spike).
        let _ = &self.model_manager;
        None
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}
