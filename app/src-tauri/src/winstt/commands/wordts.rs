// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/05_*.md (Word-timestamps)
// + lib_wiring.md §3, memory project_word_highlight_playback. Wraps managers::WordAligner.
//
// align_words: lazy cross-attention DTW for history playback (karaoke highlight).
// Loads the history entry's recording + transcript, runs the timestamped whisper
// export, and returns per-word start/end seconds.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::winstt::managers::WordAligner;

/// One word with start/end seconds (the renderer's highlight sweep input).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WordResultPayload {
    pub text: String,
    pub start: f32,
    pub end: f32,
}

/// `align_words` — per-word timings for a history entry (lazy on first play).
#[tauri::command]
#[specta::specta]
pub async fn align_words(
    aligner: State<'_, Arc<WordAligner>>,
    entry_id: String,
) -> Result<Vec<WordResultPayload>, String> {
    let mgr = aligner.inner().clone();
    // SPIKE: load the entry's recorded WAV (16 kHz mono f32) + transcript text via
    // the HistoryManager. Until that load path is wired, run the aligner with an
    // empty buffer (it returns no words until the timestamped engine is built).
    let (audio, text) = load_history_audio(&entry_id);

    let words = tauri::async_runtime::spawn_blocking(move || mgr.align_words(&audio, &text))
        .await
        .map_err(|e| e.to_string())??;

    Ok(words
        .into_iter()
        .map(|w| WordResultPayload {
            text: w.text,
            start: w.start,
            end: w.end,
        })
        .collect())
}

/// SPIKE: resolve the history entry's recording + transcript. Returns an empty
/// buffer until the HistoryManager wav/text load is wired (the aligner then
/// yields no words — history playback falls back to no highlight).
fn load_history_audio(_entry_id: &str) -> (Vec<f32>, String) {
    (Vec::new(), String::new())
}
