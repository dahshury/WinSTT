// Listen-session post-processing (`history_post_process`).
//
// Runs the CONFIGURED post-processing LLM (`llm.dictation.base` — same
// provider/model the dictation post-processor uses) over a saved history
// transcript with listening-specific instructions (meeting notes, summary,
// action items, or free-form custom instructions from the renderer's preset
// dialog), then stores the result as the entry's `post_processed_text` —
// OVERWRITING any previous run, so re-processing always leaves exactly one
// processed variant next to the untouched raw transcript. The existing
// history UI's original/processed swap then works unchanged.
//
// Unlike live dictation post-processing this path:
//   * has no paste/selection side effects — it is a pure text → text pass;
//   * uses its OWN system prompt (the captured audio is other people's speech,
//     not the user's dictation — the caveman cleanup contract does not apply);
//   * chunks long transcripts (a 2 h podcast far exceeds the Ollama
//     `num_ctx = 16384` window) with a map → reduce pass;
//   * runs under a generous per-call timeout — long-form summarization on a
//     local model is legitimately slow.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, State, WebviewWindow};

use crate::command_auth;
use crate::managers::history::HistoryManager;
use crate::winstt::managers::LlmManager;
use crate::winstt::settings_schema::{LlmProvider, WinsttSettings};

use super::llm as llm_commands;
use super::llm::conversions::{openrouter_options, to_llm_effort};
use super::settings::read_settings;

/// Per-LLM-call timeout. Long transcripts on local models are slow by nature;
/// the playground's 60 s would abort legitimate meeting-notes runs.
const LISTEN_POST_PROCESS_TIMEOUT: Duration = Duration::from_secs(300);
/// Transcript budget per LLM call (chars). Local Ollama runs at
/// `num_ctx = 16384`; ~4 chars/token keeps chunk + instructions + output
/// comfortably inside that window (cloud models only get faster).
const CHUNK_CHARS: usize = 24_000;
/// Guard against runaway custom instructions.
const MAX_INSTRUCTION_CHARS: usize = 4_000;

const LISTEN_SYSTEM_PROMPT: &str = "You process transcripts of audio the user listened to - meetings, calls, lectures, podcasts, videos. The transcript may interleave several speakers (lines may carry 'Speaker N:' labels) and may contain recognition errors; read through them. Apply the user's instructions to the transcript faithfully. Output ONLY the result - no preamble, no commentary, no code fences around the whole answer. Use Markdown headings and bullet lists when they make the result clearer. Respond in the transcript's language unless the instructions say otherwise.";

/// Where the transcript text is split when it exceeds one call's budget:
/// prefer caption-line boundaries; a single oversized line hard-splits.
fn split_transcript(text: &str, max_chars: usize) -> Vec<String> {
    if text.len() <= max_chars {
        return vec![text.to_string()];
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.split('\n') {
        // A single line larger than the budget is hard-split on char
        // boundaries (degenerate transcripts only).
        if line.len() > max_chars {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            let mut piece = String::new();
            for ch in line.chars() {
                piece.push(ch);
                if piece.len() >= max_chars {
                    chunks.push(std::mem::take(&mut piece));
                }
            }
            if !piece.is_empty() {
                current = piece;
            }
            continue;
        }
        if !current.is_empty() && current.len() + 1 + line.len() > max_chars {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn chunk_user_prompt(instructions: &str, index: usize, total: usize, chunk: &str) -> String {
    if total <= 1 {
        return format!("{instructions}\n\nTranscript:\n{chunk}");
    }
    format!(
        "{instructions}\n\nThis is part {part} of {total} of one long transcript. Process this part on its own and output only this part's result; the parts are merged afterwards.\n\nTranscript (part {part}/{total}):\n{chunk}",
        part = index + 1,
    )
}

fn reduce_user_prompt(instructions: &str, partials: &[String]) -> String {
    let joined = partials
        .iter()
        .enumerate()
        .map(|(i, part)| format!("--- Part {} ---\n{}", i + 1, part.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "{instructions}\n\nBelow are partial results produced from consecutive parts of ONE long transcript. Merge them into a single coherent final result that follows the instructions, removing duplication across parts.\n\n{joined}"
    )
}

/// Post-processing availability mirrors the dictation gate: the feature toggle
/// AND a usable model for the configured provider.
fn post_processing_ready(settings: &WinsttSettings) -> Result<(), String> {
    if !settings.llm.dictation.enabled {
        return Err("AI post-processing is disabled in Settings".to_string());
    }
    let base = &settings.llm.dictation.base;
    let ready = match base.provider {
        LlmProvider::Openrouter => !settings.llm.openrouter_api_key.trim().is_empty(),
        LlmProvider::AppleIntelligence => true,
        LlmProvider::Ollama => !base.model.trim().is_empty(),
    };
    if ready {
        Ok(())
    } else {
        Err("No post-processing model is configured".to_string())
    }
}

/// One LLM call over the configured post-processing provider, with the
/// listen-specific system prompt and timeout. Pure text → text.
async fn run_listen_llm(
    settings: &WinsttSettings,
    mgr: &Arc<LlmManager>,
    user_prompt: &str,
) -> Result<String, String> {
    let base = &settings.llm.dictation.base;
    let call = async {
        match base.provider {
            LlmProvider::AppleIntelligence => llm_commands::apple_intelligence_chat(
                LISTEN_SYSTEM_PROMPT,
                user_prompt,
                base.max_output_tokens.filter(|v| *v > 0),
            ),
            LlmProvider::Openrouter => {
                mgr.openrouter_chat(
                    &settings.llm.openrouter_api_key,
                    &base.openrouter_model,
                    LISTEN_SYSTEM_PROMPT,
                    user_prompt,
                    &base.openrouter_fallback_model,
                    openrouter_options(base),
                    Some(&mgr.next_request_id()),
                )
                .await
            }
            LlmProvider::Ollama => {
                mgr.ollama_transform(
                    &settings.llm.endpoint,
                    &base.model,
                    LISTEN_SYSTEM_PROMPT,
                    user_prompt,
                    "",
                    to_llm_effort(base.thinking_effort),
                    &mgr.next_request_id(),
                )
                .await
            }
        }
    };
    match tokio::time::timeout(LISTEN_POST_PROCESS_TIMEOUT, call).await {
        Ok(Ok(answer)) if !answer.trim().is_empty() => Ok(answer.trim().to_string()),
        Ok(Ok(_)) => Err("The model returned an empty result".to_string()),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(format!(
            "Post-processing timed out after {} seconds. Try a smaller model or lower thinking effort.",
            LISTEN_POST_PROCESS_TIMEOUT.as_secs()
        )),
    }
}

fn selected_post_process_model(settings: &WinsttSettings) -> String {
    let base = &settings.llm.dictation.base;
    match base.provider {
        LlmProvider::Openrouter => {
            let primary = base.openrouter_model.trim();
            if primary.is_empty() {
                base.openrouter_fallback_model.trim().to_string()
            } else {
                primary.to_string()
            }
        }
        LlmProvider::AppleIntelligence => "apple-intelligence".to_string(),
        LlmProvider::Ollama => base.model.trim().to_string(),
    }
}

/// `history_post_process` — apply `instructions` to a history entry's RAW
/// transcript with the configured post-processing LLM and store the result as
/// the entry's processed text (overwriting a previous run). Emits the standard
/// history `Updated` event, so every history surface refreshes itself. Returns
/// the processed text.
#[tauri::command]
#[specta::specta]
pub async fn history_post_process(
    app: AppHandle,
    webview: WebviewWindow,
    llm_manager: State<'_, Arc<LlmManager>>,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
    instructions: String,
) -> Result<String, String> {
    command_auth::authorize_webview(
        &webview,
        "history",
        "post-process history",
        &["settings", "history"],
        "",
    )?;

    let instructions = instructions.trim().to_string();
    if instructions.is_empty() {
        return Err("Post-processing instructions are empty".to_string());
    }
    if instructions.len() > MAX_INSTRUCTION_CHARS {
        return Err("Post-processing instructions are too long".to_string());
    }

    let settings = read_settings(&app);
    post_processing_ready(&settings)?;

    let entry = history_manager
        .get_entry_by_id(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("History entry {id} not found"))?;
    // Always process the ORIGINAL transcript, never a previous LLM pass —
    // re-running with different instructions must not compound.
    let transcript = entry.transcription_text.trim().to_string();
    if transcript.is_empty() {
        return Err("This entry has no transcript to process".to_string());
    }

    let mgr = llm_manager.inner().clone();
    let started = Instant::now();

    let chunks = split_transcript(&transcript, CHUNK_CHARS);
    let processed = if chunks.len() == 1 {
        run_listen_llm(
            &settings,
            &mgr,
            &chunk_user_prompt(&instructions, 0, 1, &chunks[0]),
        )
        .await?
    } else {
        log::info!(
            "[listen-postprocess] transcript of {} chars split into {} chunks",
            transcript.len(),
            chunks.len()
        );
        let total = chunks.len();
        let mut partials = Vec::with_capacity(total);
        for (index, chunk) in chunks.iter().enumerate() {
            let partial = run_listen_llm(
                &settings,
                &mgr,
                &chunk_user_prompt(&instructions, index, total, chunk),
            )
            .await
            .map_err(|err| format!("Part {}/{total} failed: {err}", index + 1))?;
            partials.push(partial);
        }
        run_listen_llm(
            &settings,
            &mgr,
            &reduce_user_prompt(&instructions, &partials),
        )
        .await
        .map_err(|err| format!("Combining the {total} parts failed: {err}"))?
    };

    let processing_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
    let llm_meta = serde_json::json!({
        "model": selected_post_process_model(&settings),
        "processingMs": processing_ms,
    })
    .to_string();

    history_manager
        .update_post_processed(id, processed.clone(), Some(instructions), Some(llm_meta))
        .map_err(|e| e.to_string())?;

    Ok(processed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_transcripts_stay_in_one_chunk() {
        let chunks = split_transcript("hello\nworld", CHUNK_CHARS);
        assert_eq!(chunks, vec!["hello\nworld".to_string()]);
    }

    #[test]
    fn long_transcripts_split_on_line_boundaries() {
        let line = "a".repeat(100);
        let text = std::iter::repeat_n(line, 12).collect::<Vec<_>>().join("\n");
        let chunks = split_transcript(&text, 350);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.len() <= 350));
        // Nothing lost: rejoining recovers every caption line.
        let rejoined = chunks.join("\n");
        assert_eq!(
            rejoined.split('\n').filter(|l| !l.is_empty()).count(),
            12,
            "all lines survive chunking"
        );
    }

    #[test]
    fn oversized_single_line_hard_splits() {
        let text = "b".repeat(1000);
        let chunks = split_transcript(&text, 300);
        assert!(chunks.len() >= 4);
        assert_eq!(chunks.iter().map(String::len).sum::<usize>(), 1000);
    }

    #[test]
    fn chunk_prompts_mention_part_numbers_only_when_split() {
        let single = chunk_user_prompt("Summarize.", 0, 1, "text");
        assert!(!single.contains("part"));
        let multi = chunk_user_prompt("Summarize.", 1, 3, "text");
        assert!(multi.contains("part 2 of 3"));
    }

    #[test]
    fn apple_intelligence_is_ready_without_a_model_id() {
        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.provider = LlmProvider::AppleIntelligence;

        assert!(post_processing_ready(&settings).is_ok());
        assert_eq!(selected_post_process_model(&settings), "apple-intelligence");
    }
}
