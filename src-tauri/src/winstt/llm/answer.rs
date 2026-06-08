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
    let inline = split_inline_thinking(content);
    let mut reasoning = if inline.thinking.is_empty() {
        None
    } else {
        Some(inline.thinking.clone())
    };
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
    if !inline.answer.is_empty() {
        return (inline.answer, reasoning);
    }
    (fallback.to_string(), reasoning)
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
    fn finalize_extracts_boxed_when_no_envelope() {
        let (answer, reasoning) = finalize_chat_answer("steps... \\boxed{final}", "fb");
        assert_eq!(answer, "final");
        assert!(reasoning.unwrap().contains("steps..."));
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
