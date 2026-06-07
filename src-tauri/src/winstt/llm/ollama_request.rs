// Ollama chat request-body construction and stream-state parsing.
//
// ThinkingEffort, keep-alive, thinking flag, structured-output schema,
// dictionary tool, chunk/tool-call types, and stream-line parsing. Runtime
// HTTP transport lives in `winstt::ollama_client`.

use super::side_effects::{
    cleanup_dictionary_terms, HISTORY_TAGS, OLLAMA_DICTIONARY_TOOL_NAME,
    OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_DISABLED, OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_ENABLED,
    PRIVACY_MARKERS,
};

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

/// Build the `think` field value: `false` when the model can't think or
/// effort is Off, else the effort string. Mirrors thinkingFlagFor.
pub fn thinking_flag_for(effort: ThinkingEffort, supports_thinking: bool) -> serde_json::Value {
    if !supports_thinking || effort == ThinkingEffort::Off {
        return serde_json::Value::Bool(false);
    }
    serde_json::Value::String(effort.as_str().to_string())
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
    serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt },
        ],
        "stream": true,
        "think": thinking_flag_for(effort, supports_thinking),
        "format": ollama_structured_output_schema(),
        "keep_alive": keep_alive,
        "options": {
            "temperature": 0.3,
            "top_p": 0.9,
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
            if let Some(t) = &msg.thinking {
                if !t.is_empty() {
                    self.thinking.push_str(t);
                    deltas.thinking = Some(t.clone());
                }
            }
            if let Some(c) = &msg.content {
                if !c.is_empty() {
                    self.content.push_str(c);
                }
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
            thinking_flag_for(ThinkingEffort::High, false),
            serde_json::Value::Bool(false)
        );
        assert_eq!(
            thinking_flag_for(ThinkingEffort::Off, true),
            serde_json::Value::Bool(false)
        );
        assert_eq!(
            thinking_flag_for(ThinkingEffort::High, true),
            serde_json::Value::String("high".into())
        );
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
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("fill every side-channel field"));
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
