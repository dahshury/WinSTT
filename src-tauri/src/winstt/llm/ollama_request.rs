// Ollama chat request-body construction and stream-state parsing.
//
// ThinkingEffort, keep-alive, thinking flag, structured-output schema,
// dictionary tool, chunk/tool-call types, and stream-line parsing. Runtime
// HTTP transport lives in `winstt::ollama_client`.

use once_cell::sync::Lazy;
use regex::Regex;

use super::side_effects::{
    HISTORY_TAGS, OLLAMA_DICTIONARY_TOOL_NAME, OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_DISABLED,
    OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_ENABLED, PRIVACY_MARKERS, cleanup_dictionary_terms,
};
use crate::helpers::regex::static_regex;

/// Effort knob for thinking-capable models. Maps to Ollama's `ThinkValue`.
/// Mirrors ThinkingEffort.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingEffort {
    Off,
    Low,
    Medium,
    High,
}

impl ThinkingEffort {
    fn as_str(self) -> &'static str {
        match self {
            ThinkingEffort::Off => "off",
            ThinkingEffort::Low => "low",
            ThinkingEffort::Medium => "medium",
            ThinkingEffort::High => "high",
        }
    }
}

// Ollama keep-alive + structured schema, mirroring buildOllamaChatBody.
const DEFAULT_OLLAMA_KEEP_ALIVE: &str = "5m";

// ── Lite-tier model detection ──────────────────────────────────────────────
//
// Models below `LITE_MODEL_MAX_PARAMS_B` effective parameters get the LITE
// request shape: a `{text}`-only structured-output schema, a matching compact
// grounding block, greedy decoding, a compact system-prompt base (see
// `prompts::build_dictation_system_prompt_for_model`), and NO side-channel
// extraction instruction. Rationale: the full six-field envelope (text +
// dictionary terms + snippets + modifier suggestions + history tag + privacy
// markers) makes the model do transformation, classification, and extraction
// in ONE pass — on sub-4B models that multi-task load is what breaks
// instruction-following on the text itself. Lite models trade the
// auto-learning / history-tag / privacy-marker side channels (the renderer
// disables those capabilities for them — see `isLiteOllamaModel` in
// `entities/llm-catalog`) for reliable text transforms.
//
// The threshold is deliberately `< 4.0`, not `<= 4.0`: gemma4:e4b (effective
// 4B) is the smallest model verified to handle the FULL envelope, so 4B-class
// models keep it; everything smaller goes lite.
const LITE_MODEL_MAX_PARAMS_B: f64 = 4.0;

/// Param-size token inside a tag's variant part: `2b`, `0.8b`, `135m`, and
/// Gemma MatFormer "effective" sizes (`e2b` → 2B). The token must sit between
/// `-`/`_` boundaries (or the variant edges) so quant markers like `q8_0`
/// never parse as sizes. Mirrors `PARAM_FROM_VARIANT_RE` in
/// `entities/llm-catalog/lib/lite-model.ts` (regex crate has no lookahead, so
/// the trailing boundary is consumed instead).
static PARAM_FROM_VARIANT_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r"(?i)(?:^|[-_])e?(\d+(?:\.\d+)?)([bmk])(?:$|[-_])"));

/// Effective parameter count parsed from an Ollama tag name, in billions.
/// `None` when the name carries no param token (bare bases like `gemma4` or
/// alias tags like `phi3:mini`) — such models are treated as full-tier.
pub fn ollama_effective_params_billions(model: &str) -> Option<f64> {
    let variant = model.split_once(':').map(|(_, v)| v)?;
    let caps = PARAM_FROM_VARIANT_RE.captures(variant)?;
    let value: f64 = caps.get(1)?.as_str().parse().ok()?;
    let unit = caps.get(2)?.as_str().to_ascii_lowercase();
    Some(match unit.as_str() {
        "m" => value / 1_000.0,
        "k" => value / 1_000_000.0,
        _ => value,
    })
}

/// True when this Ollama model runs the LITE request shape (see the tier note
/// above). Unknown sizes are full-tier so behavior for bare/alias names is
/// unchanged.
pub fn is_lite_ollama_model(model: &str) -> bool {
    ollama_effective_params_billions(model).is_some_and(|params| params < LITE_MODEL_MAX_PARAMS_B)
}

/// Context window requested on EVERY Ollama call WinSTT makes — chat AND
/// warmup. Ollama reloads a model whenever a request's `num_ctx` differs from
/// the loaded instance's, so a warmup that omits `options` loads the model at
/// the server default (4096) and the first real dictation at 16384 then pays
/// a full multi-second model reload despite being "warm".
pub const OLLAMA_NUM_CTX: u32 = 16384;

/// Compact JSON-shape grounding appended to the user prompt whenever we send a
/// `format` schema. Ollama's structured-output docs recommend "also pass the
/// JSON schema as a string in the prompt to ground the model's response" — with
/// it, thinking-capable models (gemma, qwen3, …) reliably emit the JSON
/// envelope instead of free-form prose like `text: <answer>`. The explicit
/// "raw JSON, no code fences" clause stops the model wrapping the object in a
/// ```json block, whose opening fence can stream on its own and leak a bare
/// ``` into the paste.
///
/// `history_tag` MUST stay a `<placeholder>`, never a concrete value: a small
/// model reads a literal example like `"history_tag": "note"` as a few-shot
/// default and copies it, collapsing the whole content-category breakdown into
/// "Note". Measured on gemma e4b, hardcoding "note" here dropped `ai_prompt`
/// recall on obvious AI prompts to ~40% (the rest fell to "note"); a neutral
/// placeholder restores it.
const OLLAMA_STRUCTURED_OUTPUT_GROUNDING: &str = concat!(
    "\n\nReturn your answer as a single raw JSON object — no markdown, no ``` code ",
    "fences, no text before or after it — matching this exact shape, with ONLY the ",
    "cleaned, transformed text in the \"text\" field and each placeholder replaced by a ",
    "real value:\n",
    "{\"text\": \"<transformed text>\", \"learned_proper_nouns\": [], \"learned_snippets\": [], ",
    "\"suggested_modifier_presets\": [], \"history_tag\": \"<one history_tag category>\", ",
    "\"privacy_markers\": []}"
);

/// Lite-tier grounding: the `{text}`-only shape, matching
/// `ollama_lite_output_schema`. Same raw-JSON / no-code-fence rules as the
/// full grounding — small models leak ``` fences into the paste just as
/// readily as thinking models do.
const OLLAMA_LITE_STRUCTURED_OUTPUT_GROUNDING: &str = concat!(
    "\n\nReturn your answer as a single raw JSON object — no markdown, no ``` code ",
    "fences, no text before or after it — matching this exact shape, with ONLY the ",
    "cleaned, transformed text in the \"text\" field:\n",
    "{\"text\": \"<transformed text>\"}"
);

/// Map the shared model lifetime setting onto Ollama's keep_alive field.
/// Ollama accepts duration strings, seconds, and negative numeric sentinels.
pub fn ollama_keep_alive_from_core_timeout(
    timeout: crate::settings::ModelUnloadTimeout,
) -> serde_json::Value {
    match timeout {
        crate::settings::ModelUnloadTimeout::Never => serde_json::json!(-1),
        crate::settings::ModelUnloadTimeout::Immediately => serde_json::json!(0),
        crate::settings::ModelUnloadTimeout::Min2 => serde_json::json!("2m"),
        crate::settings::ModelUnloadTimeout::Min5 => serde_json::json!("5m"),
        crate::settings::ModelUnloadTimeout::Min10 => serde_json::json!("10m"),
        crate::settings::ModelUnloadTimeout::Min15 => serde_json::json!("15m"),
        crate::settings::ModelUnloadTimeout::Hour1 => serde_json::json!("1h"),
        crate::settings::ModelUnloadTimeout::Sec15 => serde_json::json!("15s"),
    }
}

/// True iff this model takes thinking *effort levels* (`low`/`medium`/`high`)
/// rather than a boolean. Per the Ollama docs only the GPT-OSS family does;
/// for it `true`/`false` are ignored. Every other thinking model expects a
/// boolean, and handing it an effort string makes it mishandle the request.
fn model_uses_thinking_levels(model: &str) -> bool {
    model.to_ascii_lowercase().contains("gpt-oss")
}

/// True for DEDICATED reasoning models whose chat template ALWAYS emits a
/// `<think>` block — deepseek-r1, QwQ, Magistral, and any `-thinking` /
/// `-reasoning` variant (e.g. `lfm2.5-thinking`, `phi4-mini-reasoning`).
///
/// For these, `think:false` does NOT stop the model reasoning — it only tells
/// Ollama to stop *parsing* the tags, so the `<think>…` leaks into `content`
/// instead of the structured `thinking` field (verified against Ollama's
/// `/api/chat`). They can't be turned off, so we always send `true`: the
/// reasoning is parsed out cleanly and the answer stays uncluttered.
///
/// Kept in sync with the renderer's `isAlwaysOnReasoningModel`
/// (src/entities/llm-catalog/lib/ollama-thinking.ts), which hides the "Off"
/// affordance for the same set.
fn model_is_always_on_reasoning(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("-thinking")
        || m.contains("-reasoning")
        || m.contains("deepseek-r1")
        || m.contains("qwq")
        || m.contains("magistral")
}

/// Build the `think` field value per the Ollama API contract.
///
/// - `false` when the model can't think.
/// - `true` for always-on reasoning models regardless of effort — `false` there
///   is a no-op that just leaks `<think>` into `content` (see
///   {@link model_is_always_on_reasoning}).
/// - For GPT-OSS (the documented exception): ALWAYS an effort string — the
///   ONLY think values it supports are `"low"`/`"medium"`/`"high"`. It cannot
///   stop reasoning: measured live, `think:false` still produced a ~2k-char
///   trace at the DEFAULT length (30s on a 12 GB card) vs ~150 chars for
///   `"low"` (9s). The stored per-feature effort is deliberately NOT rewritten
///   by the renderer (a write-normalization leaked thinking-on across model
///   switches, since the setting is shared per feature); its levels control
///   simply has no Off and DISPLAYS a stored `off` as Low, and this clamp maps
///   that stored `off` to the minimal supported `"low"` on the wire rather
///   than sending the unsupported `false`.
/// - `false` when the user chose Off (for a toggle-able model).
/// - For every other thinking model: a plain boolean `true`. The docs state
///   "most models accept booleans (`true`/`false`)"; passing an effort *string*
///   to such a model is improper and is mishandled — e.g. gemma abandons the
///   grammar-constrained structured output entirely and emits raw `text: …`.
pub fn thinking_flag_for(
    effort: ThinkingEffort,
    supports_thinking: bool,
    model: &str,
) -> serde_json::Value {
    if !supports_thinking {
        return serde_json::Value::Bool(false);
    }
    if model_is_always_on_reasoning(model) {
        return serde_json::Value::Bool(true);
    }
    if model_uses_thinking_levels(model) {
        let level = if effort == ThinkingEffort::Off {
            "low"
        } else {
            effort.as_str()
        };
        return serde_json::Value::String(level.to_string());
    }
    if effort == ThinkingEffort::Off {
        return serde_json::Value::Bool(false);
    }
    serde_json::Value::Bool(true)
}

/// Lite-tier structured-output schema: the transformed text and nothing else.
/// See the lite-tier note at the top of this file.
pub fn ollama_lite_output_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "The transformed text only. No reasoning, no steps, no preambles, no commentary."
            }
        },
        "required": ["text"],
        "additionalProperties": false
    })
}

/// The native structured-output JSON schema enforced via Ollama's `format`.
/// Mirrors OLLAMA_STRUCTURED_OUTPUT_SCHEMA.
pub fn ollama_structured_output_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "The transformed text only. No reasoning, no steps, no preambles, no commentary."
            },
            "learned_proper_nouns": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Dictionary terms learned from the dictated text only: proper nouns, acronyms, product names, project names, technical jargon, or domain-specific terms. Empty when none."
            },
            "learned_snippets": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "trigger": {
                            "type": "string",
                            "description": "The short phrase or slash command the user explicitly asked to save as a snippet trigger."
                        },
                        "expansion": {
                            "type": "string",
                            "description": "The exact text to expand the trigger into. Do not include credentials or private contact details."
                        }
                    },
                    "required": ["trigger", "expansion"],
                    "additionalProperties": false
                },
                "description": "Explicit snippet/text-expansion commands only. Empty when none."
            },
            "suggested_modifier_presets": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Short user-facing name for the reusable formatting modifier."
                        },
                        "prompt": {
                            "type": "string",
                            "description": "Reusable instruction for this formatting modifier."
                        }
                    },
                    "required": ["name", "prompt"],
                    "additionalProperties": false
                },
                "description": "Explicit reusable formatting preferences only. Empty when none."
            },
            "history_tag": {
                "type": "string",
                "enum": HISTORY_TAGS,
                "description": "Exactly one fixed category describing what the dictated text is about."
            },
            "privacy_markers": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": PRIVACY_MARKERS
                },
                "description": "Fixed sensitive-data categories only. Never include raw sensitive text."
            }
        },
        "required": [
            "text",
            "learned_proper_nouns",
            "learned_snippets",
            "suggested_modifier_presets",
            "history_tag",
            "privacy_markers"
        ],
        "additionalProperties": false
    })
}

/// Tool schema for optional dictionary suggestions. The backend treats tool
/// calls as suggestions, sanitizes/dedupes them, and persists accepted-shaped
/// terms through the normal settings dictionary path.
pub fn ollama_dictionary_suggestion_tool() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": OLLAMA_DICTIONARY_TOOL_NAME,
            "description": "Suggest spoken proper nouns, acronyms, product names, technical jargon, or domain-specific terms that WinSTT should offer to remember in its dictionary. Only include words actually present in the user's dictation. Do not include common words, full sentences, URLs, emails, passwords, or secrets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "terms": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "One to five canonical dictionary terms exactly as they should be remembered."
                    }
                },
                "required": ["terms"]
            }
        }
    })
}

pub fn add_ollama_dictionary_tool(body: &mut serde_json::Value) {
    if let Some(obj) = body.as_object_mut() {
        obj.insert(
            "tools".to_string(),
            serde_json::json!([ollama_dictionary_suggestion_tool()]),
        );
    }
}

pub fn add_ollama_side_effect_schema_instruction(
    body: &mut serde_json::Value,
    auto_learning_enabled: bool,
) {
    // Lite-tier bodies carry the `{text}`-only schema — the six-field
    // side-channel instruction would contradict the enforced grammar and
    // re-add the multi-task load the lite tier exists to remove.
    let model_is_lite = body
        .get("model")
        .and_then(serde_json::Value::as_str)
        .is_some_and(is_lite_ollama_model);
    if model_is_lite {
        return;
    }
    let Some(messages) = body
        .as_object_mut()
        .and_then(|obj| obj.get_mut("messages"))
        .and_then(|v| v.as_array_mut())
    else {
        return;
    };
    for message in messages {
        let is_system = message
            .get("role")
            .and_then(|v| v.as_str())
            .is_some_and(|role| role == "system");
        if !is_system {
            continue;
        }
        if let Some(content) = message.get_mut("content") {
            let existing = content.as_str().unwrap_or_default();
            let instruction = if auto_learning_enabled {
                OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_ENABLED
            } else {
                OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_DISABLED
            };
            *content = serde_json::Value::String(format!("{existing}\n\n{instruction}"));
        }
        break;
    }
}

/// Build the /api/chat request body. num_predict floor = max(text_len*4,
/// 8192). Mirrors buildOllamaChatBody.
pub fn build_ollama_chat_body(
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    text_len: usize,
    supports_thinking: bool,
    effort: ThinkingEffort,
) -> serde_json::Value {
    build_ollama_chat_body_with_keep_alive(
        model,
        system_prompt,
        user_prompt,
        text_len,
        supports_thinking,
        effort,
        serde_json::json!(DEFAULT_OLLAMA_KEEP_ALIVE),
    )
}

/// Build the /api/chat request body with an app-selected keep_alive value.
pub fn build_ollama_chat_body_with_keep_alive(
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    text_len: usize,
    supports_thinking: bool,
    effort: ThinkingEffort,
    keep_alive: serde_json::Value,
) -> serde_json::Value {
    // Lite tier (sub-4B models): `{text}`-only schema + grounding and greedy
    // decoding — deterministic rewrites hallucinate less at temperature 0 on
    // small models, while the full tier keeps its tuned 0.3.
    let lite = is_lite_ollama_model(model);
    let grounding = if lite {
        OLLAMA_LITE_STRUCTURED_OUTPUT_GROUNDING
    } else {
        OLLAMA_STRUCTURED_OUTPUT_GROUNDING
    };
    let user_content = format!("{user_prompt}{grounding}");
    let format = if lite {
        ollama_lite_output_schema()
    } else {
        ollama_structured_output_schema()
    };
    let temperature = if lite { 0.0 } else { 0.3 };
    serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content },
        ],
        "stream": true,
        "think": thinking_flag_for(effort, supports_thinking, model),
        "format": format,
        "keep_alive": keep_alive,
        "options": {
            "temperature": temperature,
            "top_p": 0.9,
            "num_ctx": OLLAMA_NUM_CTX,
            "num_predict": std::cmp::max(text_len * 4, 8192),
        }
    })
}

/// One parsed NDJSON chunk from /api/chat. Mirrors ollamaChatStreamChunkSchema.
#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct OllamaChatChunk {
    #[serde(default)]
    pub message: Option<OllamaChunkMessage>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub done_reason: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct OllamaChunkMessage {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<OllamaToolCall>,
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct OllamaToolCall {
    #[serde(default)]
    pub function: OllamaToolFunction,
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct OllamaToolFunction {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
}

/// Accumulated stream state. Mirrors OllamaChatStreamState (content +
/// thinking + done flags). The renderer-streaming cursor is a UI concern
/// and lives in the caller's reasoning-delta sink, not here.
#[derive(Debug, Default)]
pub struct OllamaStreamState {
    pub content: String,
    pub thinking: String,
    pub tool_calls: Vec<OllamaToolCall>,
    pub done: bool,
    pub done_reason: Option<String>,
    pub error: Option<String>,
}

impl OllamaStreamState {
    /// Fold one chunk in, returning the (thinking_delta, content_delta) so
    /// the caller can stream the natural-prose answer to the pill. Mirrors
    /// applyChatStreamChunk + broadcastContentDelta semantics (the delta of
    /// the structured `text` field, never raw JSON scaffolding).
    pub fn apply_chunk(&mut self, chunk: &OllamaChatChunk) -> StreamDeltas {
        let mut deltas = StreamDeltas::default();
        if let Some(msg) = &chunk.message {
            if let Some(t) = &msg.thinking
                && !t.is_empty()
            {
                self.thinking.push_str(t);
                deltas.thinking = Some(t.clone());
            }
            if let Some(c) = &msg.content
                && !c.is_empty()
            {
                self.content.push_str(c);
            }
            if !msg.tool_calls.is_empty() {
                self.tool_calls.extend(msg.tool_calls.iter().cloned());
            }
        }
        if let Some(e) = &chunk.error {
            self.error = Some(e.clone());
        }
        if chunk.done {
            self.done = true;
            if let Some(r) = &chunk.done_reason {
                self.done_reason = Some(r.clone());
            }
        }
        deltas
    }
}

fn collect_tool_terms_from_value(value: &serde_json::Value, terms: &mut Vec<String>) {
    if let Some(text) = value.as_str() {
        terms.push(text.to_string());
        return;
    }
    if let Some(arr) = value.as_array() {
        for item in arr {
            collect_tool_terms_from_value(item, terms);
        }
    }
}

fn collect_dictionary_terms_from_arguments(args: &serde_json::Value, terms: &mut Vec<String>) {
    if let Some(raw) = args.as_str() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
            collect_dictionary_terms_from_arguments(&parsed, terms);
        } else {
            terms.push(raw.to_string());
        }
        return;
    }
    if let Some(obj) = args.as_object() {
        for key in ["terms", "term", "words", "word", "nouns", "proper_nouns"] {
            if let Some(value) = obj.get(key) {
                collect_tool_terms_from_value(value, terms);
            }
        }
        return;
    }
    collect_tool_terms_from_value(args, terms);
}

pub fn extract_dictionary_terms_from_tool_calls(calls: &[OllamaToolCall]) -> Vec<String> {
    let mut raw_terms = Vec::new();
    for call in calls {
        if call.function.name != OLLAMA_DICTIONARY_TOOL_NAME {
            continue;
        }
        collect_dictionary_terms_from_arguments(&call.function.arguments, &mut raw_terms);
    }
    cleanup_dictionary_terms(raw_terms)
}

#[derive(Debug, Default)]
pub struct StreamDeltas {
    pub thinking: Option<String>,
    pub content: Option<String>,
}

/// Parse one NDJSON line into a chunk. None on blank / non-JSON / schema
/// mismatch. Mirrors parseChatStreamLine.
pub fn parse_chat_stream_line(line: &str) -> Option<OllamaChatChunk> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str::<OllamaChatChunk>(trimmed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_flag_off_when_unsupported() {
        assert_eq!(
            thinking_flag_for(ThinkingEffort::High, false, "qwen3"),
            serde_json::Value::Bool(false)
        );
        assert_eq!(
            thinking_flag_for(ThinkingEffort::Off, true, "qwen3"),
            serde_json::Value::Bool(false)
        );
    }

    #[test]
    fn thinking_flag_is_boolean_for_non_gpt_oss_models() {
        // Per the Ollama docs, normal thinking models take a boolean — NOT an
        // effort string. Sending `"medium"` to gemma/qwen3 makes them drop the
        // structured-output grammar and paste raw `text: …`, the reported bug.
        for model in [
            "gemma4:e2b-it-q4_K_M",
            "qwen3",
            "deepseek-r1",
            "lfm2.5-thinking",
        ] {
            assert_eq!(
                thinking_flag_for(ThinkingEffort::Medium, true, model),
                serde_json::Value::Bool(true),
                "{model} should get a boolean think flag"
            );
            assert_eq!(
                thinking_flag_for(ThinkingEffort::High, true, model),
                serde_json::Value::Bool(true),
            );
        }
    }

    #[test]
    fn thinking_flag_uses_effort_levels_only_for_gpt_oss() {
        // GPT-OSS is the documented exception: it tunes the trace by level and
        // ignores booleans.
        assert_eq!(
            thinking_flag_for(ThinkingEffort::High, true, "gpt-oss:20b"),
            serde_json::Value::String("high".into())
        );
        assert_eq!(
            thinking_flag_for(ThinkingEffort::Medium, true, "GPT-OSS:120b"),
            serde_json::Value::String("medium".into())
        );
    }

    #[test]
    fn thinking_flag_clamps_stale_off_to_supported_low_for_gpt_oss() {
        // gpt-oss supports ONLY "low"/"medium"/"high" — it cannot stop
        // reasoning (`false` still yields a default-length ~2k-char trace).
        // The renderer never stores Off for it (no Off in its control + stale
        // values are rewritten), so this arm is a clamp for old persisted
        // state reaching a dictation before the settings UI has healed it.
        assert_eq!(
            thinking_flag_for(ThinkingEffort::Off, true, "gpt-oss:20b"),
            serde_json::Value::String("low".into())
        );
    }

    #[test]
    fn thinking_flag_forces_true_for_always_on_reasoning_even_when_off() {
        // Dedicated reasoning models can't disable thinking — `false` there just
        // leaks `<think>` into `content`. So Off is coerced to `true` (clean,
        // structured reasoning) for every always-on family.
        for model in [
            "lfm2.5-thinking:1.2b",
            "phi4-mini-reasoning:3.8b",
            "deepseek-r1:7b",
            "qwq:32b",
            "magistral:24b",
        ] {
            assert_eq!(
                thinking_flag_for(ThinkingEffort::Off, true, model),
                serde_json::Value::Bool(true),
                "{model} is always-on: Off must coerce to think:true"
            );
        }
        // A genuinely toggle-able hybrid still honours Off.
        assert_eq!(
            thinking_flag_for(ThinkingEffort::Off, true, "qwen3.5:4b"),
            serde_json::Value::Bool(false)
        );
    }

    #[test]
    fn chat_body_grounds_schema_shape_in_user_prompt() {
        // Ollama's structured-output docs: grounding the JSON shape in the prompt
        // keeps thinking-capable models honoring `format` instead of leaking prose.
        // gemma4:12b is FULL-tier (12B ≥ the 4B lite threshold) → six-field shape.
        let body = build_ollama_chat_body(
            "gemma4:12b",
            "sys",
            "usr",
            100,
            true,
            ThinkingEffort::Medium,
        );
        let user = body["messages"][1]["content"].as_str().unwrap();
        assert!(user.starts_with("usr"));
        assert!(user.contains("raw JSON object"));
        assert!(user.contains("no ``` code"));
        assert!(user.contains("\"text\""));
        assert!(user.contains("\"history_tag\""));
        // gemma is not gpt-oss → boolean think
        assert_eq!(body["think"], serde_json::Value::Bool(true));
    }

    #[test]
    fn effective_params_parse_from_tag_names() {
        let close = |name: &str, expected: f64| {
            let got = ollama_effective_params_billions(name).unwrap();
            assert!(
                (got - expected).abs() < 1e-9,
                "{name}: got {got}, expected {expected}"
            );
        };
        close("qwen3.5:0.8b", 0.8);
        close("qwen3.5:2b", 2.0);
        close("smollm2:135m", 0.135);
        close("gemma4:e2b", 2.0);
        close("gemma4:e4b-it-qat", 4.0);
        close("gemma4:12b-it-q4_K_M", 12.0);
        close("phi4-mini:3.8b", 3.8);
        close("lfm2.5:8b-a1b-q4_K_M", 8.0);
        // Quant markers must never parse as sizes.
        close("llama3.2:1b-instruct-q8_0", 1.0);
        // Bare bases / alias tags carry no size → unknown (full tier).
        assert_eq!(ollama_effective_params_billions("gemma4"), None);
        assert_eq!(ollama_effective_params_billions("phi3:mini"), None);
        assert_eq!(ollama_effective_params_billions("qwen3.5:latest"), None);
    }

    #[test]
    fn lite_tier_is_below_4b_effective() {
        for lite in [
            "smollm2:135m",
            "qwen3.5:0.8b",
            "llama3.2:1b",
            "qwen3.5:2b",
            "gemma4:e2b",
            "gemma4:e2b-it-qat",
            "granite4.1:3b",
            "phi4-mini:3.8b",
        ] {
            assert!(is_lite_ollama_model(lite), "{lite} should be lite");
        }
        // gemma4:e4b (effective 4B) is the verified FULL-envelope floor; bigger
        // and unknown-size models stay full too.
        for full in [
            "gemma4:e4b",
            "gemma4:e4b-it-qat",
            "qwen3.5:4b",
            "gemma4:12b",
            "command-r7b:7b",
            "gemma4",
            "phi3:mini",
        ] {
            assert!(!is_lite_ollama_model(full), "{full} should be full-tier");
        }
    }

    #[test]
    fn lite_chat_body_uses_text_only_schema_and_greedy_decoding() {
        let body =
            build_ollama_chat_body("llama3.2:1b", "sys", "usr", 100, false, ThinkingEffort::Off);
        let required = body["format"]["required"].as_array().unwrap();
        assert_eq!(required, &[serde_json::json!("text")]);
        assert!(body["format"]["properties"]["history_tag"].is_null());
        assert_eq!(body["options"]["temperature"], serde_json::json!(0.0));
        let user = body["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains("{\"text\": \"<transformed text>\"}"));
        assert!(!user.contains("history_tag"));
    }

    #[test]
    fn side_effect_instruction_is_noop_for_lite_models() {
        let mut body =
            build_ollama_chat_body("qwen3.5:2b", "sys", "usr", 100, false, ThinkingEffort::Off);
        let before = body["messages"][0]["content"].as_str().unwrap().to_string();
        add_ollama_side_effect_schema_instruction(&mut body, true);
        assert_eq!(body["messages"][0]["content"].as_str().unwrap(), before);
        add_ollama_side_effect_schema_instruction(&mut body, false);
        assert_eq!(body["messages"][0]["content"].as_str().unwrap(), before);
    }

    #[test]
    fn chat_body_has_structured_format_and_floor() {
        let body = build_ollama_chat_body("qwen3", "sys", "usr", 100, true, ThinkingEffort::Medium);
        assert_eq!(body["stream"], serde_json::Value::Bool(true));
        let required = body["format"]["required"].as_array().unwrap();
        for field in [
            "text",
            "learned_proper_nouns",
            "learned_snippets",
            "suggested_modifier_presets",
            "history_tag",
            "privacy_markers",
        ] {
            assert!(required.contains(&serde_json::Value::String(field.to_string())));
        }
        assert_eq!(
            body["format"]["properties"]["history_tag"]["enum"][0],
            "ai_prompt"
        );
        assert_eq!(body["keep_alive"], "5m");
        // Chat must request the shared context size — the warmup path loads the
        // model with the same value, and any mismatch makes Ollama fully reload
        // the model on the first real dictation.
        assert_eq!(body["options"]["num_ctx"], OLLAMA_NUM_CTX);
        // floor is max(100*4, 8192) = 8192
        assert_eq!(body["options"]["num_predict"], 8192);
        let body2 =
            build_ollama_chat_body("qwen3", "sys", "usr", 3000, true, ThinkingEffort::Medium);
        assert_eq!(body2["options"]["num_predict"], 12000);
    }

    #[test]
    fn chat_body_can_attach_dictionary_tool() {
        let mut body =
            build_ollama_chat_body("qwen3", "sys", "usr", 100, true, ThinkingEffort::Medium);
        add_ollama_dictionary_tool(&mut body);
        assert_eq!(
            body["tools"][0]["function"]["name"],
            OLLAMA_DICTIONARY_TOOL_NAME
        );
        assert_eq!(
            body["tools"][0]["function"]["parameters"]["required"][0],
            "terms"
        );
    }

    #[test]
    fn chat_body_can_attach_dictionary_schema_instruction() {
        let mut body =
            build_ollama_chat_body("qwen3", "sys", "usr", 100, true, ThinkingEffort::Medium);
        add_ollama_side_effect_schema_instruction(&mut body, true);
        assert!(
            body["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains(OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_ENABLED)
        );
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn ollama_keep_alive_tracks_global_model_lifetime_policy() {
        use crate::settings::ModelUnloadTimeout as Timeout;

        assert_eq!(
            ollama_keep_alive_from_core_timeout(Timeout::Immediately),
            serde_json::json!(0)
        );
        assert_eq!(
            ollama_keep_alive_from_core_timeout(Timeout::Never),
            serde_json::json!(-1)
        );
        assert_eq!(
            ollama_keep_alive_from_core_timeout(Timeout::Min2),
            serde_json::json!("2m")
        );
        assert_eq!(
            ollama_keep_alive_from_core_timeout(Timeout::Min5),
            serde_json::json!("5m")
        );
        assert_eq!(
            ollama_keep_alive_from_core_timeout(Timeout::Min10),
            serde_json::json!("10m")
        );
        assert_eq!(
            ollama_keep_alive_from_core_timeout(Timeout::Min15),
            serde_json::json!("15m")
        );
        assert_eq!(
            ollama_keep_alive_from_core_timeout(Timeout::Hour1),
            serde_json::json!("1h")
        );
        assert_eq!(
            ollama_keep_alive_from_core_timeout(Timeout::Sec15),
            serde_json::json!("15s")
        );
    }

    #[test]
    fn chat_body_preserves_numeric_ollama_keep_alive_sentinels() {
        let body = build_ollama_chat_body_with_keep_alive(
            "qwen3",
            "sys",
            "usr",
            100,
            true,
            ThinkingEffort::Medium,
            serde_json::json!(-1),
        );
        assert_eq!(body["keep_alive"], serde_json::json!(-1));
    }

    #[test]
    fn parse_chat_stream_line_skips_garbage() {
        assert!(parse_chat_stream_line("").is_none());
        assert!(parse_chat_stream_line("not json").is_none());
        let chunk = parse_chat_stream_line(r#"{"message":{"content":"hi"},"done":false}"#).unwrap();
        assert_eq!(chunk.message.unwrap().content.unwrap(), "hi");
    }

    #[test]
    fn stream_state_accumulates_and_reports_deltas() {
        let mut state = OllamaStreamState::default();
        let c1 = parse_chat_stream_line(r#"{"message":{"thinking":"r1"}}"#).unwrap();
        let d1 = state.apply_chunk(&c1);
        assert_eq!(d1.thinking.unwrap(), "r1");
        let c2 = parse_chat_stream_line(
            r#"{"message":{"content":"answer"},"done":true,"done_reason":"stop"}"#,
        )
        .unwrap();
        state.apply_chunk(&c2);
        assert_eq!(state.thinking, "r1");
        assert_eq!(state.content, "answer");
        assert!(state.done);
        assert_eq!(state.done_reason.unwrap(), "stop");
    }

    #[test]
    fn stream_state_accumulates_tool_calls_and_extracts_terms() {
        let mut state = OllamaStreamState::default();
        let chunk = parse_chat_stream_line(
            r#"{"message":{"tool_calls":[{"function":{"name":"suggest_dictionary_terms","arguments":{"terms":["WinSTT","Ollama","", "https://example.com", "A B C D E F G"]}}}]}}"#,
        )
        .unwrap();
        state.apply_chunk(&chunk);

        let terms = extract_dictionary_terms_from_tool_calls(&state.tool_calls);
        assert_eq!(terms, vec!["WinSTT", "Ollama"]);
    }
}
