// Word-timestamps. Wraps managers::WordAligner.
//
// align_words: lazy cross-attention DTW for history playback (karaoke highlight).
// Loads the history entry's recording + transcript, runs the timestamped whisper
// export, and returns per-word start/end seconds.
//
// The audio-load-by-id is wired here.
// The renderer's `alignTranscriptionHistoryAudio(id)` passes the
// STRING id from the legacy `TranscriptionHistoryEntry` (= the DB row's integer
// id rendered as a string — see winstt/commands/history.rs `to_transcription_entry`).
// We resolve that row via `HistoryManager`, read its WAV (16 kHz mono i16
// → f32 normalised), and feed the aligner with the entry's raw transcript
// text so playback follows the words the user actually spoke, not any LLM
// rewrite rendered as the row's default text.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::managers::history::HistoryManager;
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
/// Returns `[]` when the entry has no audio on disk or alignment isn't available
/// yet (documented degrade: history playback falls back to no highlight).
#[tauri::command]
#[specta::specta]
pub async fn align_words(
    aligner: State<'_, Arc<WordAligner>>,
    history_manager: State<'_, Arc<HistoryManager>>,
    entry_id: String,
) -> Result<Vec<WordResultPayload>, String> {
    let Some((audio, text)) =
        load_history_audio(history_manager.inner().as_ref(), &entry_id).await?
    else {
        return Ok(Vec::new());
    };
    if audio.is_empty() {
        return Ok(Vec::new());
    }

    let mgr = aligner.inner().clone();
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

/// Resolve the history entry's recording (mono 16 kHz f32) + spoken transcript.
/// `entry_id` is the DB row id rendered as a string. Returns `None` when the row
/// or its WAV is missing (no highlight, text intact).
async fn load_history_audio(
    history_manager: &HistoryManager,
    entry_id: &str,
) -> Result<Option<(Vec<f32>, String)>, String> {
    let Ok(numeric) = entry_id.parse::<i64>() else {
        return Ok(None);
    };
    let Some(entry) = history_manager
        .get_entry_by_id(numeric)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    if entry.file_name.is_empty() {
        return Ok(None);
    }
    let path = history_manager.get_audio_file_path(&entry.file_name);
    if !path.exists() {
        return Ok(None);
    }
    let audio =
        crate::audio_toolkit::read_wav_samples(&path).map_err(|e| format!("load audio: {e}"))?;
    let text = playback_alignment_text(&entry);
    Ok(Some((audio, text)))
}

fn playback_alignment_text(entry: &crate::managers::history::HistoryEntry) -> String {
    entry.transcription_text.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managers::history::HistoryEntry;

    fn history_entry(raw: &str, processed: Option<&str>) -> HistoryEntry {
        HistoryEntry {
            id: 7,
            file_name: "entry.wav".to_string(),
            timestamp: 1_767_220_000,
            saved: false,
            title: "Entry".to_string(),
            transcription_text: raw.to_string(),
            post_processed_text: processed.map(str::to_string),
            post_process_prompt: None,
            post_process_requested: processed.is_some(),
            llm_meta: None,
            dictionary_fixes: None,
            history_tag: None,
            privacy_markers_json: None,
            stt_model: None,
        }
    }

    #[test]
    fn playback_alignment_prefers_raw_transcript_over_llm_text() {
        let entry = history_entry("raw words the user said", Some("Clean LLM rewrite."));

        assert_eq!(playback_alignment_text(&entry), "raw words the user said");
    }
}
