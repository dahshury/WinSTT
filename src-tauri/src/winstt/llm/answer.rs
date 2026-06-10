// Chat-answer / chain-of-thought leakage parsing.
//
// PURE parsers, ported 1:1 from the Ollama finalize path in llm.ts. These
// run on the assembled `content` buffer when Ollama didn't honor `format`
// and the model leaked reasoning into the content channel. Priority order
// matches finalizeChatAnswer: structured envelope → inline <think> →
// harmony `final` → \boxed{} → raw.

use super::side_effects::salvage_structured_text;

/// Result of a leakage extraction: the reasoning (for the pill) and the
/// final answer. Mirrors the `{ thinking, answer }` shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leakage {
    pub thinking: String,
    pub answer: String,
}

/// Strip leading/trailing ```json fences (and bare ```), trimmed. Mirrors
/// stripMarkdownFences.
pub(super) fn strip_markdown_fences(content: &str) -> String {
    let mut s = content.trim();
    // open fence: ```json or ``` then optional whitespace
    if let Some(rest) = s.strip_prefix("```json") {
        s = rest.trim_start();
    } else if let Some(rest) = s.strip_prefix("```") {
        s = rest.trim_start();
    }
    if let Some(rest) = s.strip_suffix("```") {
        s = rest.trim_end();
    }
    s.trim().to_string()
}

/// Extract `final` channel text from an OpenAI-harmony stream that leaked
/// into content. Mirrors extractHarmonyAnswer + collectHarmonyAnalysisChunks.
pub fn extract_harmony_answer(content: &str) -> Option<Leakage> {
    // Find a `final` channel message segment.
    let lower = content;
    let final_text = harmony_segment(lower, "final")?;
    if final_text.trim().is_empty() {
        return None;
    }
    let analysis = harmony_all_segments(lower, "analysis").join("\n\n");
    Some(Leakage {
        thinking: analysis,
        answer: final_text.trim().to_string(),
    })
}

/// Find the message body following `<|channel|> <name> <|message|>` up to
/// the next channel/end/start/return marker. Case-insensitive on the name.
fn harmony_segment(content: &str, name: &str) -> Option<String> {
    harmony_all_segments(content, name).into_iter().next()
}

fn harmony_all_segments(content: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = content.to_lowercase();
    let chan = "<|channel|>";
    let msg = "<|message|>";
    let mut idx = 0usize;
    while let Some(rel) = lower[idx..].find(chan) {
        let chan_start = idx + rel;
        let after_chan = chan_start + chan.len();
        // The channel name segment up to <|message|>.
        let Some(msg_rel) = lower[after_chan..].find(msg) else {
            break;
        };
        let name_seg = lower[after_chan..after_chan + msg_rel].trim();
        let body_start = after_chan + msg_rel + msg.len();
        // Body ends at the next end/return/start/channel marker.
        let end = ["<|end|>", "<|return|>", "<|start|>", chan]
            .iter()
            .filter_map(|m| lower[body_start..].find(m).map(|r| body_start + r))
            .min()
            .unwrap_or(lower.len());
        if name_seg == name {
            out.push(content[body_start..end].to_string());
        }
        idx = end;
    }
    out
}

/// Pull the LAST `\boxed{…}` payload. Mirrors extractBoxedAnswer. Handles
/// one level of brace nesting (`\boxed{\frac{a}{b}}`).
pub fn extract_boxed_answer(content: &str) -> Option<Leakage> {
    let mut last: Option<(usize, usize, String)> = None; // (start, end, inner)
    let needle = "\\boxed{";
    let mut search = 0usize;
    while let Some(rel) = content[search..].find(needle) {
        let open = search + rel;
        let inner_start = open + needle.len();
        if let Some(inner_len) = balanced_brace_inner(&content[inner_start..]) {
            let inner_end = inner_start + inner_len;
            // +1 for the closing `}`.
            let full_end = inner_end + 1;
            last = Some((open, full_end, content[inner_start..inner_end].to_string()));
            search = full_end;
        } else {
            search = inner_start;
        }
    }
    let (start, end, inner) = last?;
    let answer = inner.trim().to_string();
    if answer.is_empty() {
        return None;
    }
    let before = content[..start].trim();
    let after = content[end..].trim();
    let thinking = [before, after]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(Leakage { thinking, answer })
}

/// Return the byte length of the inner body of a `{...}` whose opening brace
/// was already consumed, allowing one nested `{...}` pair. None if
/// unbalanced. Cursor is just past the opening brace.
fn balanced_brace_inner(after_open: &str) -> Option<usize> {
    let bytes = after_open.as_bytes();
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                if depth == 0 {
                    return Some(i);
                }
                depth -= 1;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Split inline `<think>…</think>` / `<thinking>…</thinking>`. Mirrors
/// splitInlineThinking.
pub fn split_inline_thinking(content: &str) -> Leakage {
    let mut thinking = String::new();
    let answer = strip_tag_pairs(content, "think", &mut thinking);
    let answer = strip_tag_pairs(&answer, "thinking", &mut thinking);
    Leakage {
        thinking,
        answer: answer.trim().to_string(),
    }
}

fn strip_tag_pairs(content: &str, tag: &str, thinking: &mut String) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::new();
    let mut rest = content;
    while let Some(o) = rest.find(&open) {
        out.push_str(&rest[..o]);
        let after_open = &rest[o + open.len()..];
        if let Some(c) = after_open.find(&close) {
            thinking.push_str(after_open[..c].trim());
            rest = &after_open[c + close.len()..];
        } else {
            // Unterminated tag — drop the open marker, keep the tail.
            rest = after_open;
        }
    }
    out.push_str(rest);
    out
}

/// Parse the structured envelope `{ "text": "..." }`. Returns the inner
/// `text` on success (strict parse first, then near-miss salvage). Mirrors
/// extractStructuredFinalText + salvageStructuredText.
pub fn extract_structured_final_text(content: &str) -> Option<String> {
    let trimmed = strip_markdown_fences(content);
    if !trimmed.starts_with('{') {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&trimmed) {
        if let Some(text) = value.get("text").and_then(|t| t.as_str()) {
            return Some(text.to_string());
        }
    }
    salvage_structured_text(&trimmed)
}

/// Finalize an Ollama chat answer from the assembled content buffer.
/// Priority order mirrors finalizeChatAnswer:
///   structured envelope → inline <think> → harmony final → \boxed{} → raw.
/// Returns (answer, optional reasoning-to-broadcast). Falls back to
/// `fallback` (the original text) when the content yields nothing usable.
pub fn finalize_chat_answer(content: &str, fallback: &str) -> (String, Option<String>) {
    if let Some(structured) = extract_structured_final_text(content) {
        let t = structured.trim();
        if !t.is_empty() {
            return (t.to_string(), None);
        }
        return (fallback.to_string(), None);
    }
    // The Ollama chat path always requests `format: <schema>`, so a well-formed
    // answer is a JSON envelope. When the content opens an object (`{…`) but no
    // `text` could be extracted, it is a truncated or malformed structured
    // response — never natural prose. Falling through to the `<think>`/harmony/
    // boxed/raw passthrough below would paste the bare scaffolding (`{`, `{"text`,
    // `{\n  "text"`). Fall back to the original text instead. (A model that
    // ignored `format` and leaked real prose does not start with `{`, so it still
    // flows through the leakage extractors.)
    if strip_markdown_fences(content).starts_with('{') {
        return (fallback.to_string(), None);
    }
    let inline = split_inline_thinking(content);
    let mut reasoning = if inline.thinking.is_empty() {
        None
    } else {
        Some(inline.thinking.clone())
    };
    // A model may emit its reasoning inline then the JSON envelope after it.
    // Re-run structured extraction on the de-<think>ed remainder so a leaked
    // `<think>…</think>{ "text": … }` still resolves to the clean field.
    if let Some(structured) = extract_structured_final_text(&inline.answer) {
        let t = structured.trim();
        if !t.is_empty() {
            return (t.to_string(), reasoning);
        }
        return (fallback.to_string(), reasoning);
    }
    // Leakage extractors run on the post-<think> answer.
    for extractor in [extract_harmony_answer, extract_boxed_answer] {
        if let Some(leak) = extractor(&inline.answer) {
            if !leak.thinking.is_empty() {
                reasoning = Some(match reasoning {
                    Some(prev) => format!("{prev}\n\n{}", leak.thinking),
                    None => leak.thinking,
                });
            }
            return (leak.answer, reasoning);
        }
    }
    // Defense in depth: a model that ignores `format` despite the prompt
    // grounding can emit the answer as an unwrapped `text:` field (the JSON key
    // as a bare label) instead of the full object. Recover the cleaned text from
    // it. In the fully degenerate case the content is just a scaffolding token
    // (`text`, `{`, a quoted field name) — never a real answer, so fall back.
    if let Some(unwrapped) = salvage_unwrapped_text_field(&inline.answer) {
        return (unwrapped, reasoning);
    }
    // A bare scaffolding token, or a reasoning leak with no recoverable envelope
    // (a thinking-native model whose `<think>` block never closed into an answer)
    // — never a real answer. Paste the original, not the junk. Only an UNCLOSED
    // `<think>` is treated as a pure leak; a closed `<think>…</think>X` already
    // had its X recovered above.
    let unclosed_thinking_leak =
        content.trim_start().starts_with("<think") && !content.contains("</think");
    if is_bare_structured_scaffold(&inline.answer) || unclosed_thinking_leak {
        return (fallback.to_string(), reasoning);
    }
    if !inline.answer.is_empty() {
        return (inline.answer, reasoning);
    }
    (fallback.to_string(), reasoning)
}

/// Recover the cleaned text from an unwrapped `text:` field label. A model that
/// dropped the `format` grammar may prefix the answer with the JSON key
/// (`text: <answer>` or `"text": "<answer>"`) rather than emit the full object.
/// Matches the lowercase field name exactly (so a normal sentence starting with
/// a capitalized "Text" is untouched) and only when a colon follows. Returns the
/// trimmed, unquoted remainder, or None when there is no label / nothing follows.
fn salvage_unwrapped_text_field(answer: &str) -> Option<String> {
    let trimmed = answer.trim_start();
    let rest = trimmed
        .strip_prefix("\"text\"")
        .or_else(|| trimmed.strip_prefix("text"))?;
    let rest = rest.trim_start().strip_prefix(':')?.trim();
    let unquoted = rest
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .unwrap_or(rest)
        .trim();
    if unquoted.is_empty() {
        None
    } else {
        Some(unquoted.to_string())
    }
}

/// True for a bare structured-output scaffolding token a model emits when it
/// abandons `format` (just `text`, `{`, `}`, a quoted field name, or a lone
/// markdown code fence) — never a real answer, so the caller falls back to the
/// original transcription.
fn is_bare_structured_scaffold(answer: &str) -> bool {
    let t = answer.trim().trim_matches('"').trim();
    matches!(
        t,
        "" | "{"
            | "}"
            | "```"
            | "```json"
            | "text"
            | "learned_proper_nouns"
            | "learned_snippets"
            | "suggested_modifier_presets"
            | "history_tag"
            | "privacy_markers"
    )
}

/// Compact provider/transport errors for logs. Keeps status and first-order
/// failure context without dumping full response bodies or prompt/user text.
pub fn compact_error_for_log(message: &str) -> String {
    const MAX_CHARS: usize = 240;

    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= MAX_CHARS {
        return compact;
    }

    let mut out = compact.chars().take(MAX_CHARS).collect::<String>();
    out.push_str("...");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── leakage extractors ──

    #[test]
    fn boxed_extracts_last_answer() {
        let content = "reasoning here \\boxed{42} epilogue text";
        let leak = extract_boxed_answer(content).unwrap();
        assert_eq!(leak.answer, "42");
        assert!(leak.thinking.contains("reasoning here"));
        assert!(leak.thinking.contains("epilogue text"));
    }

    #[test]
    fn boxed_handles_one_level_nesting() {
        let leak = extract_boxed_answer("\\boxed{\\frac{a}{b}}").unwrap();
        assert_eq!(leak.answer, "\\frac{a}{b}");
    }

    #[test]
    fn harmony_extracts_final_channel() {
        let content =
            "<|channel|>analysis<|message|>thinking...<|channel|>final<|message|>The answer<|end|>";
        let leak = extract_harmony_answer(content).unwrap();
        assert_eq!(leak.answer, "The answer");
        assert!(leak.thinking.contains("thinking..."));
    }

    #[test]
    fn inline_think_split() {
        let leak = split_inline_thinking("<think>reasoning</think>final answer");
        assert_eq!(leak.answer, "final answer");
        assert_eq!(leak.thinking, "reasoning");
    }

    // ── structured envelope + salvage ──

    #[test]
    fn structured_strict_parse() {
        let text = extract_structured_final_text(r#"{"text":"hello world"}"#).unwrap();
        assert_eq!(text, "hello world");
    }

    #[test]
    fn structured_strips_markdown_fences() {
        let text = extract_structured_final_text("```json\n{\"text\":\"hi\"}\n```").unwrap();
        assert_eq!(text, "hi");
    }

    #[test]
    fn salvage_smart_quote_close() {
        // model closed the string with a curly quote and dropped the brace
        let text = extract_structured_final_text("{\"text\": \"salvaged answer\u{201d}").unwrap();
        assert_eq!(text, "salvaged answer");
    }

    #[test]
    fn salvage_unescapes_newline() {
        let text = extract_structured_final_text(r#"{"text": "line1\nline2"#).unwrap();
        assert_eq!(text, "line1\nline2");
    }

    // ── finalize priority ──

    #[test]
    fn finalize_prefers_structured_envelope() {
        let (answer, reasoning) = finalize_chat_answer(r#"{"text":"clean output"}"#, "fallback");
        assert_eq!(answer, "clean output");
        assert!(reasoning.is_none());
    }

    #[test]
    fn finalize_empty_structured_envelope_uses_fallback_without_leaking_json() {
        let (answer, reasoning) = finalize_chat_answer(r#"{"text":""}"#, "");
        assert_eq!(answer, "");
        assert!(reasoning.is_none());

        let (answer, reasoning) = finalize_chat_answer(r#"{"text":""}"#, "original text");
        assert_eq!(answer, "original text");
        assert!(reasoning.is_none());
    }

    #[test]
    fn finalize_preserves_structured_translation() {
        let (answer, reasoning) = finalize_chat_answer(
            r#"{"text":"مرحباً، كيف حالك اليوم؟"}"#,
            "Hello, how are you today?",
        );
        assert_eq!(answer, "مرحباً، كيف حالك اليوم؟");
        assert!(reasoning.is_none());
    }

    #[test]
    fn finalize_falls_back_on_empty_content() {
        let (answer, _) = finalize_chat_answer("", "original text");
        assert_eq!(answer, "original text");
    }

    #[test]
    fn finalize_falls_back_on_truncated_json_envelope() {
        // A cancelled / truncated structured-output stream leaves a JSON
        // fragment. None of these must ever be pasted verbatim — they fall back
        // to the original transcription.
        for fragment in ["{", "{\"", "{\"text", "{\"text\":", "{\n  \"text\""] {
            let (answer, reasoning) = finalize_chat_answer(fragment, "original text");
            assert_eq!(answer, "original text", "leaked fragment {fragment:?}");
            assert!(reasoning.is_none());
        }
    }

    #[test]
    fn finalize_falls_back_on_fenced_truncated_envelope() {
        let (answer, _) = finalize_chat_answer("```json\n{\"text\"", "original text");
        assert_eq!(answer, "original text");
    }

    #[test]
    fn finalize_extracts_boxed_when_no_envelope() {
        let (answer, reasoning) = finalize_chat_answer("steps... \\boxed{final}", "fb");
        assert_eq!(answer, "final");
        assert!(reasoning.unwrap().contains("steps..."));
    }

    #[test]
    fn finalize_salvages_unwrapped_text_label() {
        // A thinking model that dropped the `format` grammar emits the key as a
        // label. Recover the cleaned text rather than pasting the label.
        let (answer, _) =
            finalize_chat_answer("text: The meeting was moved to Friday at 3 PM.", "original");
        assert_eq!(answer, "The meeting was moved to Friday at 3 PM.");

        let (answer, _) = finalize_chat_answer("\"text\": \"cleaned output\"", "original");
        assert_eq!(answer, "cleaned output");
    }

    #[test]
    fn finalize_falls_back_on_bare_scaffold_token() {
        // The exact reported symptom: a bare `text` / `{` must never be pasted.
        for token in ["text", "  text  ", "\"text\"", "{", "history_tag"] {
            let (answer, _) = finalize_chat_answer(token, "original transcription");
            assert_eq!(answer, "original transcription", "token {token:?} leaked");
        }
    }

    #[test]
    fn finalize_does_not_strip_capitalized_text_sentence() {
        // A normal dictation starting with "Text" (capital, no JSON colon) is a
        // real answer — never mistaken for the lowercase `text:` field label.
        let (answer, _) = finalize_chat_answer("Text editors are great.", "fb");
        assert_eq!(answer, "Text editors are great.");
    }

    #[test]
    fn finalize_extracts_envelope_after_inline_thinking() {
        // A model that leaks its reasoning inline then emits the JSON envelope.
        let (answer, reasoning) = finalize_chat_answer(
            "<think>let me clean it</think>{\"text\":\"Cleaned result.\"}",
            "original",
        );
        assert_eq!(answer, "Cleaned result.");
        assert_eq!(reasoning.as_deref(), Some("let me clean it"));
    }

    #[test]
    fn finalize_falls_back_on_bare_code_fence() {
        // The exact new symptom: grounding made the model open a ```json block
        // whose fence streamed alone. Never paste the bare fence.
        for fence in ["```", "```json", "  ```  "] {
            let (answer, _) = finalize_chat_answer(fence, "original transcription");
            assert_eq!(answer, "original transcription", "fence {fence:?} leaked");
        }
    }

    #[test]
    fn finalize_falls_back_on_unclosed_thinking_leak() {
        // An always-thinking model (think disabled) can leak an unterminated
        // `<think>` ramble with no JSON envelope — paste the original, not the
        // reasoning.
        let (answer, _) = finalize_chat_answer(
            "<think> Okay, let me tackle this. The user wants me to clean the text",
            "the original words",
        );
        assert_eq!(answer, "the original words");
    }

    // ── ollama transport helpers ──

    #[test]
    fn compact_error_for_log_collapses_whitespace() {
        let msg = compact_error_for_log("OpenRouter HTTP 500:\n\n  provider failed\tbadly");
        assert_eq!(msg, "OpenRouter HTTP 500: provider failed badly");
    }

    #[test]
    fn compact_error_for_log_truncates_long_payloads() {
        let msg = compact_error_for_log(&"x".repeat(400));
        assert!(msg.len() < 280);
        assert!(msg.ends_with("..."));
    }
}
