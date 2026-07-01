// Ollama chat path: capability probe, dictation/transform compose, the streaming
// drain, dictation-learning persistence, and the model list/detect/delete/pull
// commands. A third `impl LlmManager` block sharing the struct's private fields.

use tauri::Emitter;

use super::{EmitReasoningSink, LlmChatOutput, LlmManager};
use crate::winstt::commands::settings::auto_apply_dictation_learning;
use crate::winstt::llm::{
    self, build_ollama_chat_body_with_keep_alive, finalize_chat_answer, ReasoningSink,
    ThinkingEffort,
};
use crate::winstt::ollama_client::{OllamaCapabilities, OllamaModelInfo, PullOutcome};

/// Classify a chat error as "the model failed to LOAD" — the Ollama runner
/// crashed (`HTTP 5xx` / process `terminated`, e.g. it doesn't fit in VRAM) or
/// the stream `stalled` with no output. Such a failure will recur on the very
/// next call, so the caller marks the model crashed and the following dictation
/// skips it (fails soft INSTANTLY instead of paying the ~16-28s crash again). A
/// user cancellation or a transient transport blip is NOT a load crash.
fn ollama_err_is_load_crash(err: &str) -> bool {
    err.contains("HTTP 5") || err.contains("terminated") || err.contains("stalled")
}

fn ensure_ollama_stream_has_content(state: &llm::OllamaStreamState) -> Result<(), String> {
    if !state.content.trim().is_empty() {
        return Ok(());
    }
    Err(format!(
        "Ollama returned no content (done={}, done_reason={}, thinking_chars={})",
        state.done,
        state.done_reason.as_deref().unwrap_or("none"),
        state.thinking.chars().count()
    ))
}

impl LlmManager {
    // ── Ollama capability probe (`/api/show`) ──────────────────────────────

    /// Probe `/api/show` for a model's capabilities, caching the result.
    /// `endpoint` is the user's Ollama base URL.
    pub async fn ollama_capabilities(
        &self,
        endpoint: &str,
        model: &str,
    ) -> Result<OllamaCapabilities, String> {
        self.ollama.capabilities(endpoint, model).await
    }

    // ── dictation / transform compose ──────────────────────────────────────

    /// Compose the dictation cleanup over Ollama. `system_prompt` is built by the
    /// caller via `winstt::llm::build_dictation_system_prompt` (so context + vocab
    /// are folded in once). Streams reasoning deltas + returns the final answer.
    #[expect(
        clippy::too_many_arguments,
        reason = "dictation request mirrors Ollama chat inputs plus optional reasoning streaming"
    )]
    pub async fn ollama_dictation(
        &self,
        endpoint: &str,
        model: &str,
        system_prompt: &str,
        user_prompt: &str,
        text: &str,
        effort: ThinkingEffort,
        dictionary_auto_add_enabled: bool,
        request_id: &str,
    ) -> Result<LlmChatOutput, String> {
        self.track_cancel(request_id);
        // The model crashed loading within the backoff window (doesn't fit in
        // VRAM) — don't re-trigger a guaranteed ~16-28s crash; fail soft to the
        // original text INSTANTLY. Retries on its own after the window expires.
        if self.ollama_model_recently_crashed(endpoint, model) {
            self.clear_cancel(request_id);
            log::warn!(
                "[llm] dictation post-process skipped — '{model}' recently crashed loading (won't fit in VRAM); keeping original text instantly"
            );
            return Err(format!(
                "Ollama model '{model}' recently failed to load; skipped to avoid a repeat crash"
            ));
        }
        let caps = self
            .ollama_capabilities(endpoint, model)
            .await
            .unwrap_or_default();
        let enable_dictionary_suggestions = dictionary_auto_add_enabled;
        let mut body = build_ollama_chat_body_with_keep_alive(
            model,
            system_prompt,
            user_prompt,
            text.len(),
            caps.supports_thinking,
            effort,
            self.ollama_keep_alive(),
        );
        llm::add_ollama_side_effect_schema_instruction(&mut body, enable_dictionary_suggestions);
        let result = self
            .stream_ollama_chat(
                endpoint,
                body,
                text,
                request_id,
                enable_dictionary_suggestions,
            )
            .await;
        match &result {
            Ok(_) => self.mark_ollama_model_warm(endpoint, model),
            Err(e) if ollama_err_is_load_crash(e) => {
                self.mark_ollama_model_crashed(endpoint, model);
            }
            Err(_) => {}
        }
        result
    }

    /// Run a transform-on-selection over Ollama (system prompt is the transform's
    /// own preset body; no context/vocab folding).
    #[expect(
        clippy::too_many_arguments,
        reason = "transform request mirrors Ollama chat inputs plus optional reasoning streaming"
    )]
    pub async fn ollama_transform(
        &self,
        endpoint: &str,
        model: &str,
        system_prompt: &str,
        user_prompt: &str,
        text: &str,
        effort: ThinkingEffort,
        request_id: &str,
    ) -> Result<String, String> {
        self.track_cancel(request_id);
        if self.ollama_model_recently_crashed(endpoint, model) {
            self.clear_cancel(request_id);
            log::warn!(
                "[llm] transform skipped — '{model}' recently crashed loading (won't fit in VRAM); keeping original text instantly"
            );
            return Err(format!(
                "Ollama model '{model}' recently failed to load; skipped to avoid a repeat crash"
            ));
        }
        let caps = self
            .ollama_capabilities(endpoint, model)
            .await
            .unwrap_or_default();
        let body = build_ollama_chat_body_with_keep_alive(
            model,
            system_prompt,
            user_prompt,
            text.len(),
            caps.supports_thinking,
            effort,
            self.ollama_keep_alive(),
        );
        let result = self
            .stream_ollama_chat(endpoint, body, text, request_id, false)
            .await
            .map(|out| out.text);
        match &result {
            Ok(_) => self.mark_ollama_model_warm(endpoint, model),
            Err(e) if ollama_err_is_load_crash(e) => {
                self.mark_ollama_model_crashed(endpoint, model);
            }
            Err(_) => {}
        }
        result
    }

    fn persist_dictation_learning(&self, side_effects: &llm::DictationSideEffects) {
        if side_effects.learned_proper_nouns.is_empty()
            && side_effects.learned_snippets.is_empty()
            && side_effects.suggested_modifier_presets.is_empty()
        {
            return;
        }
        match auto_apply_dictation_learning(&self.app, side_effects) {
            Ok(applied) if applied.any() => {
                log::info!(
                    "[llm] auto-applied dictation learning: dictionary={}, snippets={}, modifiers={}",
                    applied.dictionary_terms,
                    applied.snippets,
                    applied.modifiers
                );
            }
            Ok(_) => {}
            Err(err) => {
                log::warn!("[llm] failed to auto-apply dictation learning: {err}");
                let _ = self.app.emit(
                    crate::winstt::commands::events::names::LLM_LEARNED_PROPER_NOUNS,
                    serde_json::json!({ "nouns": side_effects.learned_proper_nouns }),
                );
            }
        }
    }

    async fn stream_ollama_chat(
        &self,
        endpoint: &str,
        body: serde_json::Value,
        fallback: &str,
        request_id: &str,
        emit_dictionary_suggestions: bool,
    ) -> Result<LlmChatOutput, String> {
        let sink = EmitReasoningSink {
            app: self.app.clone(),
            request_id: request_id.to_string(),
        };
        let state = self
            .ollama
            .stream_chat(
                endpoint,
                body,
                || self.is_cancelled(request_id),
                |delta| {
                    sink.on_delta(delta);
                },
            )
            .await;
        let state = match state {
            Ok(state) => state,
            Err(err) => {
                self.clear_cancel(request_id);
                return Err(err);
            }
        };

        if let Some(err) = state.error {
            self.clear_cancel(request_id);
            return Err(format!("Ollama stream error: {err}"));
        }
        let mut side_effects = llm::extract_dictation_side_effects(&state.content);
        if emit_dictionary_suggestions {
            side_effects.learned_proper_nouns = llm::merge_dictionary_suggestions(
                llm::extract_dictionary_terms_from_tool_calls(&state.tool_calls)
                    .into_iter()
                    .chain(side_effects.learned_proper_nouns),
            );
        } else {
            side_effects.learned_proper_nouns.clear();
            side_effects.learned_snippets.clear();
            side_effects.suggested_modifier_presets.clear();
        }
        // Persist structured dictionary suggestions immediately. If the settings
        // store cannot be updated, fall back to the legacy review-strip event so
        // the suggestion is not lost.
        if emit_dictionary_suggestions {
            self.persist_dictation_learning(&side_effects);
        }
        if let Err(err) = ensure_ollama_stream_has_content(&state) {
            self.clear_cancel(request_id);
            return Err(err);
        }
        let (answer, reasoning) = finalize_chat_answer(&state.content, fallback);
        if let Some(r) = reasoning {
            if !r.is_empty() {
                let _ = self.app.emit(
                    "llm:reasoning-delta",
                    serde_json::json!({ "requestId": request_id, "delta": r }),
                );
            }
        }
        self.clear_cancel(request_id);
        Ok(LlmChatOutput {
            text: answer,
            side_effects,
        })
    }

    /// List local Ollama models (`/api/tags`). Returns the raw model ids.
    pub async fn ollama_list_models(&self, endpoint: &str) -> Result<Vec<String>, String> {
        self.ollama.list_models(endpoint).await
    }

    /// True iff an Ollama server answers at the endpoint (`GET /api/version`).
    pub async fn ollama_detect(&self, endpoint: &str) -> bool {
        self.ollama.detect(endpoint).await
    }

    /// List local Ollama models (`/api/tags`) as full detail rows (name + size +
    /// modifiedAt + details + enriched capabilities). Mirrors `scanOllamaModels`
    /// in the reference handler: parse `/api/tags`, then per-model `/api/show` to
    /// fill `capabilities`. A single `/api/show` failure leaves that model's caps
    /// empty rather than poisoning the list.
    pub async fn ollama_list_models_detailed(
        &self,
        endpoint: &str,
    ) -> Result<Vec<OllamaModelInfo>, String> {
        self.ollama.list_models_detailed(endpoint).await
    }

    /// Delete a local Ollama model (`DELETE /api/delete { model }`). Returns
    /// `(success, error)`. Mirrors `deleteOllamaModel`.
    pub async fn ollama_delete(&self, endpoint: &str, model: &str) -> (bool, Option<String>) {
        self.ollama.delete(endpoint, model).await
    }

    /// Stream a model pull (`POST /api/pull`, stream=true), emitting
    /// `llm:pull-progress` for every coalesced NDJSON frame (broadcast to all
    /// windows via `self.app`). `is_cancelled` is polled between frames so the
    /// renderer's stop button aborts mid-stream. Mirrors `pullOllamaModel` +
    /// `readPullStream` in the reference handler.
    ///
    /// Returns `PullOutcome` so the command can build the `OllamaPullResult`.
    /// (Emit is done internally rather than via a callback so the future stays
    /// `Send` for the Tauri command runtime — a `&dyn Fn` arg held across an
    /// `.await` would not be.)
    pub async fn ollama_pull_stream<F>(
        &self,
        endpoint: &str,
        model: &str,
        is_cancelled: F,
    ) -> PullOutcome
    where
        F: Fn() -> bool + Send,
    {
        self.ollama
            .pull_stream(endpoint, model, is_cancelled, |payload| {
                self.emit_pull(payload);
            })
            .await
    }

    /// Broadcast one `llm:pull-progress` frame to every renderer.
    fn emit_pull(&self, payload: serde_json::Value) {
        let _ = self.app.emit("llm:pull-progress", payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_ollama_stream_is_provider_error() {
        let state = llm::OllamaStreamState {
            done: true,
            done_reason: Some("stop".to_string()),
            thinking: "reasoning only".to_string(),
            ..Default::default()
        };

        let err = ensure_ollama_stream_has_content(&state).unwrap_err();
        assert!(err.contains("Ollama returned no content"));
        assert!(err.contains("done_reason=stop"));
        assert!(err.contains("thinking_chars=14"));
    }

    #[test]
    fn load_crash_errors_are_classified_for_skip_marking() {
        // Runner crash (VRAM overflow) and stall → mark the model so the next
        // dictation skips it instantly.
        assert!(ollama_err_is_load_crash(
            "Ollama HTTP 500: {\"error\":\"llama-server process has terminated: exit status 0xc0000409\"}"
        ));
        assert!(ollama_err_is_load_crash("Ollama chat stalled after 30s"));
        assert!(ollama_err_is_load_crash("Ollama HTTP 503: busy"));
        // A user cancellation or a transient transport blip is NOT a load crash
        // (don't poison the backoff for those).
        assert!(!ollama_err_is_load_crash("Ollama chat cancelled"));
        assert!(!ollama_err_is_load_crash(
            "Ollama POST failed: connection refused"
        ));
        assert!(!ollama_err_is_load_crash(
            "Ollama HTTP 404: model not found"
        ));
    }

    #[test]
    fn non_empty_ollama_stream_is_usable() {
        let state = llm::OllamaStreamState {
            content: r#"{"text":"changed"}"#.to_string(),
            done: true,
            done_reason: Some("stop".to_string()),
            ..Default::default()
        };

        assert!(ensure_ollama_stream_has_content(&state).is_ok());
    }
}
