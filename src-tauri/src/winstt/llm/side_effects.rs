// Dictation side-effect extraction.
//
// Privacy markers, history tag, learned snippets, modifier presets, learned
// proper nouns, dictionary cleanup, and structured-text salvage. Owns
// HISTORY_TAGS/PRIVACY_MARKERS/OLLAMA_DICTIONARY_TOOL_NAME (re-exported as
// pub(super) where needed for the ollama request builder).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::answer::strip_markdown_fences;

/// Optional learned-proper-nouns extraction from the envelope (≤10, ≤60
/// chars each). Mirrors extractLearnedProperNouns + cleanupRawNouns.
pub fn extract_learned_proper_nouns(content: &str) -> Vec<String> {
    let trimmed = strip_markdown_fences(content);
    if !trimmed.starts_with('{') {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&trimmed) else {
        return Vec::new();
    };
    let Some(arr) = value.get("learned_proper_nouns").and_then(|n| n.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str() {
            let v = s.trim();
            if !v.is_empty() && v.chars().count() <= 60 {
                out.push(v.to_string());
                if out.len() >= 10 {
                    break;
                }
            }
        }
    }
    out
}

pub(super) fn cleanup_dictionary_terms<I>(raw_terms: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for raw in raw_terms {
        let term = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if term.is_empty() || term.chars().count() > 60 {
            continue;
        }
        if term.split_whitespace().count() > 6 {
            continue;
        }
        let lower = term.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") || term.contains('@') {
            continue;
        }
        if !seen.insert(lower) {
            continue;
        }
        out.push(term);
        if out.len() >= 10 {
            break;
        }
    }
    out
}

pub fn merge_dictionary_suggestions<I>(raw_terms: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    cleanup_dictionary_terms(raw_terms)
}

pub const OLLAMA_DICTIONARY_TOOL_NAME: &str = "suggest_dictionary_terms";

pub const HISTORY_TAGS: &[&str] = &[
    "ai_prompt",
    "task",
    "personal_message",
    "email",
    "work_message",
    "document",
    "code",
    "meeting",
    "note",
    "other",
];

pub const PRIVACY_MARKERS: &[&str] = &[
    "personal",
    "credential",
    "financial",
    "medical",
    "legal",
    "contact",
    "location",
    "secret",
    "other",
];

pub(super) const OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_ENABLED: &str = concat!(
    "Side-channel extraction: return the cleaned dictation only in the JSON `text` field. ",
    "Fill every side-channel field from the same dictated text in this one response; multiple items are allowed. ",
    "`learned_proper_nouns`: proper nouns, acronyms, product names, project names, technical jargon, or domain-specific terms to remember for future speech recognition; use canonical spelling/capitalization; never include common words, full sentences, URLs, emails, passwords, or secrets. ",
    "`learned_snippets`: only explicit snippet/text-expansion commands such as \"when I say X, expand to Y\" or \"add snippet X expands to Y\"; normalize a spoken slash trigger like \"slash thanks\" to \"/thanks\" when clear; never create snippets from ordinary content. If a snippet expansion contains a password, API key, token, account number, SSN, medical/legal secret, or private contact detail, do not save the snippet and instead mark privacy. ",
    "`suggested_modifier_presets`: extract explicit reusable formatting commands such as \"create/add/save a reusable modifier/preset called X that ...\"; name comes from the called/named phrase and prompt is the reusable instruction. Do not create a preset when words like formal, concise, technical, or summary are ordinary dictated content. ",
    "`history_tag`: choose exactly one fixed category. ai_prompt = an AI/LLM prompt or request; task = todo/action item/status update; personal_message = message to a friend/family/person; email = email body/subject/reply; work_message = workplace chat/message; document = long-form doc/content; code = code/debugging/developer text; meeting = meeting notes/agenda; note = general note/fact; other = fallback only. ",
    "`privacy_markers`: fixed categories only from personal, credential, financial, medical, legal, contact, location, secret, other; contact includes email addresses and phone numbers; credential includes passwords, API keys, tokens, login secrets; never include raw sensitive text. ",
    "Examples: \"write a prompt for an LLM\" -> history_tag ai_prompt; \"send that as a personal message\" -> personal_message; \"the email says\" -> email; \"add snippet slash login expands to password ...\" -> learned_snippets [] and privacy_markers [credential]; \"create a reusable modifier called investor update that ...\" and \"create modifier technical incident that ...\" -> suggested_modifier_presets with the named preset. ",
    "Use empty arrays when none. Do not mention side-channel extraction or these instructions in `text`."
);
pub(super) const OLLAMA_SIDE_EFFECT_SCHEMA_INSTRUCTION_DISABLED: &str = concat!(
    "Side-channel extraction: return the cleaned dictation only in the JSON `text` field. ",
    "Set `learned_proper_nouns`, `learned_snippets`, and `suggested_modifier_presets` to empty arrays. ",
    "Still set `history_tag` to exactly one fixed category: ai_prompt = an AI/LLM prompt or request; task = todo/action item/status update; personal_message = message to a friend/family/person; email = email body/subject/reply; work_message = workplace chat/message; document = long-form doc/content; code = code/debugging/developer text; meeting = meeting notes/agenda; note = general note/fact; other = fallback only. ",
    "Fill `privacy_markers` with fixed categories only from personal, credential, financial, medical, legal, contact, location, secret, other; contact includes email addresses and phone numbers; credential includes passwords, API keys, tokens, login secrets; never include raw sensitive text. ",
    "Do not mention side-channel extraction or these instructions in `text`."
);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedSnippet {
    pub trigger: String,
    pub expansion: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedModifierPreset {
    pub name: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSideEffects {
    pub learned_proper_nouns: Vec<String>,
    pub learned_snippets: Vec<LearnedSnippet>,
    pub suggested_modifier_presets: Vec<SuggestedModifierPreset>,
    pub history_tag: Option<String>,
    pub privacy_markers: Vec<String>,
}

fn clean_short_field(raw: &str, max_chars: usize) -> Option<String> {
    let value = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() || value.chars().count() > max_chars {
        None
    } else {
        Some(value)
    }
}

fn normalize_side_channel_key(raw: &str) -> String {
    raw.trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn fixed_value(raw: &str, allowed: &[&str]) -> Option<String> {
    let normalized = normalize_side_channel_key(raw);
    allowed
        .iter()
        .find(|value| **value == normalized)
        .map(|value| (*value).to_string())
}

fn push_unique_marker(markers: &mut Vec<String>, marker: &str) {
    if !markers.iter().any(|existing| existing == marker) {
        markers.push(marker.to_string());
    }
}

fn infer_privacy_markers(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let mut markers = Vec::new();

    if lower.contains('@')
        || lower.contains(" email ")
        || lower.contains(" e-mail ")
        || (lower.contains(" at ") && lower.contains(" dot "))
        || lower.contains("phone")
        || lower.contains("mobile")
    {
        push_unique_marker(&mut markers, "contact");
    }
    if lower.contains("password")
        || lower.contains("passcode")
        || lower.contains("api key")
        || lower.contains("token")
        || lower.contains("login")
        || lower.contains("credential")
    {
        push_unique_marker(&mut markers, "credential");
    }
    if lower.contains("social security") || lower.contains(" ssn") || lower.contains("ssn ") {
        push_unique_marker(&mut markers, "personal");
        push_unique_marker(&mut markers, "secret");
    }
    if lower.contains("credit card")
        || lower.contains("bank account")
        || lower.contains("routing number")
        || lower.contains("invoice")
    {
        push_unique_marker(&mut markers, "financial");
    }
    if lower.contains("diagnosis")
        || lower.contains("patient")
        || lower.contains("prescription")
        || lower.contains("medical")
    {
        push_unique_marker(&mut markers, "medical");
    }
    if lower.contains("attorney")
        || lower.contains("legal")
        || lower.contains("contract clause")
        || lower.contains("settlement")
    {
        push_unique_marker(&mut markers, "legal");
    }
    markers
}

fn infer_history_tag(text: &str, llm_tag: Option<String>) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let inferred = if lower.contains("prompt for")
        || lower.contains("write a prompt")
        || lower.contains(" llm ")
        || lower.contains(" ai prompt")
    {
        Some("ai_prompt")
    } else if lower.contains("personal message") {
        Some("personal_message")
    } else if lower.contains("task update")
        || lower.starts_with("task ")
        || lower.contains("todo")
        || lower.contains("to-do")
        || lower.contains("action item")
    {
        Some("task")
    } else if lower.contains("email")
        || lower.contains("e-mail")
        || lower.contains('@')
        || lower.starts_with("subject:")
    {
        Some("email")
    } else if lower.contains("meeting notes")
        || lower.contains("meeting agenda")
        || lower.contains("standup")
    {
        Some("meeting")
    } else if lower.contains("debug")
        || lower.contains("oauth")
        || lower.contains("callback")
        || lower.contains("function")
        || lower.contains("stack trace")
    {
        Some("code")
    } else {
        None
    };

    inferred
        .map(str::to_string)
        .or_else(|| llm_tag.filter(|tag| !tag.is_empty()))
        .or_else(|| Some("other".to_string()))
}

fn snippet_has_sensitive_expansion(expansion: &str) -> bool {
    infer_privacy_markers(expansion)
        .iter()
        .any(|marker| !matches!(marker.as_str(), "location" | "other"))
}

fn looks_like_bad_snippet(trigger: &str, expansion: &str) -> bool {
    let trigger_lower = trigger.to_ascii_lowercase();
    let expansion_lower = expansion.to_ascii_lowercase();
    expansion_lower == "modifier"
        || expansion_lower == "preset"
        || trigger_lower.contains("modifier")
        || trigger_lower.contains("preset")
        || snippet_has_sensitive_expansion(expansion)
}

fn trim_modifier_piece(raw: &str) -> &str {
    raw.trim()
        .trim_matches(|ch: char| matches!(ch, '.' | ',' | ':' | ';' | '"' | '\''))
        .trim()
}

fn first_sentence(raw: &str) -> &str {
    raw.split(['.', '?', '!'])
        .next()
        .map_or(raw.trim(), str::trim)
}

fn normalize_modifier_prompt(raw: &str) -> Option<String> {
    let prompt = trim_modifier_piece(first_sentence(raw));
    if prompt.is_empty() || prompt.chars().count() > 1200 {
        return None;
    }
    let lower = prompt.to_ascii_lowercase();
    let normalized = if let Some(rest) = lower.strip_prefix("makes ") {
        format!("Make {}", &prompt[prompt.len() - rest.len()..])
    } else {
        prompt.to_string()
    };
    Some(normalized)
}

fn infer_modifier_presets(text: &str) -> Vec<SuggestedModifierPreset> {
    let lower = text.to_ascii_lowercase();
    let triggers = [
        "create a reusable modifier called ",
        "create reusable modifier called ",
        "add a reusable modifier called ",
        "save a reusable modifier called ",
        "create a modifier called ",
        "add a modifier called ",
        "save a modifier called ",
        "create modifier ",
        "add modifier ",
        "save modifier ",
        "create preset ",
        "add preset ",
        "save preset ",
    ];

    let mut out = Vec::new();
    for trigger in triggers {
        let Some(start) = lower.find(trigger) else {
            continue;
        };
        let after_start = start + trigger.len();
        let after = &text[after_start..];
        let after_lower = &lower[after_start..];
        let delimiter = after_lower
            .find(" that ")
            .map(|idx| (idx, 6usize))
            .or_else(|| after_lower.find(" to ").map(|idx| (idx, 4usize)));
        let Some((delimiter_idx, delimiter_len)) = delimiter else {
            continue;
        };
        let name = trim_modifier_piece(&after[..delimiter_idx]);
        let prompt_raw = &after[delimiter_idx + delimiter_len..];
        let Some(name) = clean_short_field(name, 60) else {
            continue;
        };
        let Some(prompt) = normalize_modifier_prompt(prompt_raw) else {
            continue;
        };
        out.push(SuggestedModifierPreset { name, prompt });
        break;
    }
    out
}

fn extract_string_array_field(
    value: &serde_json::Value,
    field: &str,
    allowed: Option<&[&str]>,
    max_len: usize,
) -> Vec<String> {
    let Some(arr) = value.get(field).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for item in arr {
        let Some(raw) = item.as_str() else {
            continue;
        };
        let Some(value) = clean_short_field(raw, 60) else {
            continue;
        };
        let value = match allowed {
            Some(allowed) => {
                let Some(fixed) = fixed_value(&value, allowed) else {
                    continue;
                };
                fixed
            }
            None => value,
        };
        if seen.insert(value.to_ascii_lowercase()) {
            out.push(value);
            if out.len() >= max_len {
                break;
            }
        }
    }
    out
}

pub fn extract_dictation_side_effects(content: &str) -> DictationSideEffects {
    let trimmed = strip_markdown_fences(content);
    if !trimmed.starts_with('{') {
        return DictationSideEffects::default();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&trimmed) else {
        return DictationSideEffects::default();
    };

    let learned_proper_nouns = merge_dictionary_suggestions(extract_learned_proper_nouns(content));
    let learned_snippets = value
        .get("learned_snippets")
        .and_then(|v| v.as_array())
        .map(|arr| {
            let mut seen = BTreeSet::new();
            let mut out = Vec::new();
            for item in arr {
                let trigger = item
                    .get("trigger")
                    .and_then(|v| v.as_str())
                    .and_then(|v| clean_short_field(v, 80));
                let expansion = item
                    .get("expansion")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|v| !v.is_empty() && v.chars().count() <= 2000)
                    .map(str::to_string);
                let (Some(trigger), Some(expansion)) = (trigger, expansion) else {
                    continue;
                };
                if trigger.eq_ignore_ascii_case(&expansion)
                    || looks_like_bad_snippet(&trigger, &expansion)
                {
                    continue;
                }
                if seen.insert(trigger.to_ascii_lowercase()) {
                    out.push(LearnedSnippet { trigger, expansion });
                    if out.len() >= 5 {
                        break;
                    }
                }
            }
            out
        })
        .unwrap_or_default();

    let mut suggested_modifier_presets = value
        .get("suggested_modifier_presets")
        .and_then(|v| v.as_array())
        .map(|arr| {
            let mut seen = BTreeSet::new();
            let mut out = Vec::new();
            for item in arr {
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .and_then(|v| clean_short_field(v, 60));
                let prompt = item
                    .get("prompt")
                    .or_else(|| item.get("instructions"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|v| !v.is_empty() && v.chars().count() <= 1200)
                    .map(str::to_string);
                let (Some(name), Some(prompt)) = (name, prompt) else {
                    continue;
                };
                let key = format!(
                    "{}:{}",
                    name.to_ascii_lowercase(),
                    prompt.to_ascii_lowercase()
                );
                if seen.insert(key) {
                    out.push(SuggestedModifierPreset { name, prompt });
                    if out.len() >= 3 {
                        break;
                    }
                }
            }
            out
        })
        .unwrap_or_default();

    let cleaned_text = value
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let mut modifier_seen: BTreeSet<String> = suggested_modifier_presets
        .iter()
        .map(|preset| {
            format!(
                "{}:{}",
                preset.name.to_ascii_lowercase(),
                preset.prompt.to_ascii_lowercase()
            )
        })
        .collect();
    let mut modifier_seen_names: BTreeSet<String> = suggested_modifier_presets
        .iter()
        .map(|preset| preset.name.to_ascii_lowercase())
        .collect();
    for inferred in infer_modifier_presets(cleaned_text) {
        let key = format!(
            "{}:{}",
            inferred.name.to_ascii_lowercase(),
            inferred.prompt.to_ascii_lowercase()
        );
        if modifier_seen_names.insert(inferred.name.to_ascii_lowercase())
            && modifier_seen.insert(key)
        {
            suggested_modifier_presets.push(inferred);
            if suggested_modifier_presets.len() >= 3 {
                break;
            }
        }
    }
    let llm_history_tag = value
        .get("history_tag")
        .and_then(|v| v.as_str())
        .and_then(|v| fixed_value(v, HISTORY_TAGS));
    let history_tag = infer_history_tag(cleaned_text, llm_history_tag);
    let mut privacy_markers =
        extract_string_array_field(&value, "privacy_markers", Some(PRIVACY_MARKERS), 6);
    for marker in infer_privacy_markers(cleaned_text) {
        push_unique_marker(&mut privacy_markers, &marker);
    }
    for snippet in &learned_snippets {
        for marker in infer_privacy_markers(&snippet.expansion) {
            push_unique_marker(&mut privacy_markers, &marker);
        }
    }
    privacy_markers.truncate(6);

    DictationSideEffects {
        learned_proper_nouns,
        learned_snippets,
        suggested_modifier_presets,
        history_tag,
        privacy_markers,
    }
}

/// Salvage the `text` value from a near-miss envelope (smart-quote close,
/// dropped brace, truncation). Mirrors salvageStructuredText +
/// peelSalvageScaffold + unescapeJsonStringBody. Returns None if empty.
pub(super) fn salvage_structured_text(content: &str) -> Option<String> {
    // Find `"text"` then the opening quote of the value.
    let key_pos = content.find("\"text\"")?;
    let after_key = &content[key_pos + "\"text\"".len()..];
    let colon_pos = after_key.find(':')?;
    let after_colon = &after_key[colon_pos + 1..];
    let quote_rel = after_colon.find('"')?;
    let body_start = quote_rel + 1;
    // Take up to the first unescaped closing quote, else to end.
    let body = &after_colon[body_start..];
    let raw = take_until_unescaped_quote(body);
    let peeled = peel_salvage_scaffold(raw);
    let out = unescape_json_string_body(&peeled);
    let out = out.trim();
    if out.is_empty() {
        None
    } else {
        Some(out.to_string())
    }
}

fn take_until_unescaped_quote(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return &s[..i];
        }
        i += 1;
    }
    s
}

fn peel_salvage_scaffold(raw: &str) -> String {
    let mut s = raw.trim_end_matches('\\').to_string();
    // Peel an optional trailing `}` then a trailing quote (straight or smart).
    s = s.trim_end().to_string();
    if let Some(rest) = s.strip_suffix('}') {
        s = rest.trim_end().to_string();
    }
    for q in ['"', '\u{201d}', '\u{201c}'] {
        if let Some(rest) = s.strip_suffix(q) {
            s = rest.trim_end().to_string();
            break;
        }
    }
    s
}

fn unescape_json_string_body(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('/') => out.push('/'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('u') => {
                let hex: String = (0..4).filter_map(|_| chars.next()).collect();
                if let Ok(cp) = u32::from_str_radix(&hex, 16) {
                    if let Some(ch) = char::from_u32(cp) {
                        out.push(ch);
                    }
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn learned_proper_nouns_extracted_and_capped() {
        let content = r#"{"text":"x","learned_proper_nouns":["Ollama","BaseUI","","ok"]}"#;
        let nouns = extract_learned_proper_nouns(content);
        // empty string dropped
        assert_eq!(nouns, vec!["Ollama", "BaseUI", "ok"]);
    }

    #[test]
    fn extracts_and_sanitizes_dictation_side_effects() {
        let effects = extract_dictation_side_effects(
            r#"{
                "text": "Email Sam about NovaScribe.",
                "learned_proper_nouns": ["NovaScribe", "NovaScribe", "https://example.com"],
                "learned_snippets": [
                    { "trigger": "/sig", "expansion": "Regards, Sam" },
                    { "trigger": "/sig", "expansion": "Duplicate" },
                    { "trigger": "same", "expansion": "same" }
                ],
                "suggested_modifier_presets": [
                    { "name": "Meeting Summary", "prompt": "Turn this into concise meeting notes." },
                    { "name": "Meeting Summary", "prompt": "Turn this into concise meeting notes." },
                    { "name": "", "prompt": "Ignore" }
                ],
                "history_tag": "sales_followup",
                "privacy_markers": ["contact", "phone number 555-0101", "credential", "credential"]
            }"#,
        );

        assert_eq!(effects.learned_proper_nouns, vec!["NovaScribe"]);
        assert_eq!(
            effects.learned_snippets,
            vec![LearnedSnippet {
                trigger: "/sig".into(),
                expansion: "Regards, Sam".into(),
            }]
        );
        assert_eq!(
            effects.suggested_modifier_presets,
            vec![SuggestedModifierPreset {
                name: "Meeting Summary".into(),
                prompt: "Turn this into concise meeting notes.".into(),
            }]
        );
        assert_eq!(effects.history_tag.as_deref(), Some("email"));
        assert_eq!(
            effects.privacy_markers,
            vec!["contact".to_string(), "credential".to_string()]
        );
    }

    #[test]
    fn drops_sensitive_snippets_and_infers_privacy_markers() {
        let effects = extract_dictation_side_effects(
            r#"{
                "text": "Add snippet slash login expands to password hunter two.",
                "learned_proper_nouns": [],
                "learned_snippets": [
                    { "trigger": "/login", "expansion": "password hunter two" }
                ],
                "suggested_modifier_presets": [],
                "history_tag": "note",
                "privacy_markers": []
            }"#,
        );

        assert!(effects.learned_snippets.is_empty());
        assert_eq!(effects.privacy_markers, vec!["credential".to_string()]);
    }

    #[test]
    fn infers_explicit_modifier_command_when_model_omits_array() {
        let effects = extract_dictation_side_effects(
            r#"{
                "text": "Create modifier technical incident that makes updates precise and technical.",
                "learned_proper_nouns": [],
                "learned_snippets": [],
                "suggested_modifier_presets": [],
                "history_tag": "task",
                "privacy_markers": []
            }"#,
        );

        assert_eq!(
            effects.suggested_modifier_presets,
            vec![SuggestedModifierPreset {
                name: "technical incident".into(),
                prompt: "Make updates precise and technical".into(),
            }]
        );
    }

    #[test]
    fn modifier_inference_does_not_duplicate_existing_model_suggestion() {
        let effects = extract_dictation_side_effects(
            r#"{
                "text": "Create modifier technical incident that makes updates precise and technical.",
                "learned_proper_nouns": [],
                "learned_snippets": [],
                "suggested_modifier_presets": [
                    { "name": "technical incident", "prompt": "makes updates precise and technical" }
                ],
                "history_tag": "task",
                "privacy_markers": []
            }"#,
        );

        assert_eq!(effects.suggested_modifier_presets.len(), 1);
        assert_eq!(
            effects.suggested_modifier_presets[0],
            SuggestedModifierPreset {
                name: "technical incident".into(),
                prompt: "makes updates precise and technical".into(),
            }
        );
    }

    #[test]
    fn dictionary_suggestions_merge_and_dedupe() {
        let merged = merge_dictionary_suggestions(vec![
            " WinSTT ".to_string(),
            "winstt".to_string(),
            "Base UI".to_string(),
            "someone@example.test".to_string(),
        ]);
        assert_eq!(merged, vec!["WinSTT", "Base UI"]);
    }
}
