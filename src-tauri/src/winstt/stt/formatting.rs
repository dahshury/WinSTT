use once_cell::sync::Lazy;
use regex::{Captures, Regex};

use crate::winstt::catalog::{find, Family};
use crate::winstt::settings_schema::WinsttSettings;

static QUOTE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b(?:open quote|quote)\s+(.+?)\s+(?:close quote|end quote|unquote)\b"#)
        .expect("quote-command regex")
});
static NEW_PARAGRAPH_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bnew paragraph\b").expect("new paragraph regex"));
static NEW_LINE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(?:new line|newline|line break)\b").expect("new line regex"));
static QUESTION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bquestion mark\b").expect("question regex"));
static EXCLAMATION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bexclamation (?:mark|point)\b").expect("exclamation regex"));
static FULL_STOP_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bfull stop\b").expect("full stop regex"));
static OPEN_PAREN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:open|left) parenthes(?:is|es)\b").expect("open paren regex")
});
static CLOSE_PAREN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:close|right) parenthes(?:is|es)\b").expect("close paren regex")
});
static COMMA_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bcomma\b").expect("comma regex"));
static PERIOD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bperiod\b").expect("period regex"));
static COLON_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bcolon\b").expect("colon regex"));
static SEMICOLON_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bsemicolon\b").expect("semicolon regex"));

static FILLER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:um+|uh+|erm+|ah+|you know|i mean)\b[,\s]*").expect("filler regex")
});
static FLAG_LONG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bdash dash\s+([a-z][a-z0-9_-]*)\b").expect("long flag regex"));
static FLAG_SHORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bdash\s+([a-z])\b").expect("short flag regex"));
static EMAIL_LOCAL_DOT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b([a-z0-9_%+-]+)\s+dot\s+([a-z0-9_%+-]+)\s+at\b")
        .expect("email local dot regex")
});
static EMAIL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b")
        .expect("email regex")
});
static DOMAIN_TLD_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b([a-z0-9-]+)\s+dot\s+(com|org|net|io|ai|dev|app|edu|gov|co|uk)\b")
        .expect("domain regex")
});
static DOMAIN_SLASH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b([a-z0-9.-]+\.(?:com|org|net|io|ai|dev|app|edu|gov|co|uk))\s+slash\s+([a-z0-9._~/-]+)\b",
    )
    .expect("domain slash regex")
});
static ABSOLUTE_SLASH_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\bslash\s+([a-z0-9_.-]+(?:\s+slash\s+[a-z0-9_.-]+)+)\b")
        .expect("absolute slash path regex")
});
static DRIVE_BACKSLASH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b([a-z])\s+colon\s+backslash\s+").expect("drive backslash regex")
});
static PATH_BACKSLASH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)([A-Za-z]:\\(?:[A-Za-z0-9_.-]+\\)*[A-Za-z0-9_.-]+)\s+backslash\s+([A-Za-z0-9_.-]+)",
    )
    .expect("path backslash regex")
});
static SPACE_BEFORE_PUNCT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\s+([,.;:!?])").expect("space before punctuation regex"));
static SPACE_AFTER_PUNCT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"([,;:!?])([^\s\\\]\)}"'])"#).expect("space after punctuation regex")
});
static OPEN_PAREN_SPACE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\(\s+").expect("open paren spacing regex"));
static SPACE_CLOSE_PAREN_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\s+\)").expect("close paren spacing regex"));
static MULTISPACE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[ \t]{2,}").expect("multi-space regex"));
static NEWLINE_SPACE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[ \t]*\n[ \t]*").expect("newline spacing regex"));

pub(crate) fn model_has_native_basic_formatting(model_id: &str) -> bool {
    let Some(entry) = find(model_id) else {
        return false;
    };
    match entry.family {
        Family::Whisper | Family::Cohere | Family::Granite => true,
        Family::Nemo => model_id.to_lowercase().contains("canary"),
        _ => false,
    }
}

pub(crate) fn apply_deterministic_formatting(text: &str, ws: &WinsttSettings) -> String {
    let basic_enabled = ws.quality.format_basic_punctuation_casing
        && !model_has_native_basic_formatting(&ws.model.model);
    if !(basic_enabled
        || ws.quality.format_quote_commands
        || ws.quality.format_filler_repeat_cleanup
        || ws.quality.format_spoken_punctuation_commands
        || ws.quality.format_spoken_symbol_commands)
    {
        return text.to_string();
    }

    let mut out = text.trim().to_string();
    if out.is_empty() {
        return out;
    }
    if ws.quality.format_quote_commands {
        out = apply_quote_commands(&out);
    }
    if ws.quality.format_filler_repeat_cleanup {
        out = collapse_repeated_words(&FILLER_RE.replace_all(&out, "").to_string());
    }
    if ws.quality.format_spoken_punctuation_commands {
        out = apply_spoken_punctuation_commands(&out);
    }
    if ws.quality.format_spoken_symbol_commands {
        out = apply_spoken_symbol_commands(&out);
    }
    if basic_enabled {
        out = apply_basic_punctuation_casing(&out);
    }
    normalize_spacing(&out)
}

fn apply_quote_commands(text: &str) -> String {
    QUOTE_RE
        .replace_all(text, |caps: &Captures<'_>| {
            format!("\"{}\"", caps[1].trim())
        })
        .to_string()
}

fn apply_spoken_punctuation_commands(text: &str) -> String {
    let mut out = text.to_string();
    out = NEW_PARAGRAPH_RE.replace_all(&out, "\n\n").to_string();
    out = NEW_LINE_RE.replace_all(&out, "\n").to_string();
    out = QUESTION_RE.replace_all(&out, "?").to_string();
    out = EXCLAMATION_RE.replace_all(&out, "!").to_string();
    out = FULL_STOP_RE.replace_all(&out, ".").to_string();
    out = OPEN_PAREN_RE.replace_all(&out, "(").to_string();
    out = CLOSE_PAREN_RE.replace_all(&out, ")").to_string();
    out = SEMICOLON_RE.replace_all(&out, ";").to_string();
    out = COMMA_RE.replace_all(&out, ",").to_string();
    out = PERIOD_RE.replace_all(&out, ".").to_string();
    COLON_RE.replace_all(&out, ":").to_string()
}

fn dotted_domain(words: &str) -> String {
    words
        .split_whitespace()
        .filter(|part| !part.eq_ignore_ascii_case("dot"))
        .collect::<Vec<_>>()
        .join(".")
}

fn slash_path(words: &str) -> String {
    words
        .split_whitespace()
        .filter(|part| !part.eq_ignore_ascii_case("slash"))
        .collect::<Vec<_>>()
        .join("/")
}

fn apply_spoken_symbol_commands(text: &str) -> String {
    let mut out = FLAG_LONG_RE.replace_all(text, "--$1").to_string();
    out = FLAG_SHORT_RE.replace_all(&out, "-$1").to_string();
    out = EMAIL_LOCAL_DOT_RE.replace_all(&out, "$1.$2 at").to_string();
    out = EMAIL_RE
        .replace_all(&out, |caps: &Captures<'_>| {
            format!("{}@{}", &caps[1], dotted_domain(&caps[2]))
        })
        .to_string();
    out = DOMAIN_TLD_RE.replace_all(&out, "$1.$2").to_string();
    out = DOMAIN_SLASH_RE.replace_all(&out, "$1/$2").to_string();
    out = ABSOLUTE_SLASH_PATH_RE
        .replace_all(&out, |caps: &Captures<'_>| {
            format!("/{}", slash_path(&caps[1]))
        })
        .to_string();
    out = DRIVE_BACKSLASH_RE
        .replace_all(&out, |caps: &Captures<'_>| {
            format!("{}:\\", caps[1].to_ascii_uppercase())
        })
        .to_string();
    loop {
        let next = PATH_BACKSLASH_RE.replace_all(&out, "$1\\$2").to_string();
        if next == out {
            return out;
        }
        out = next;
    }
}

fn normalize_token(token: &str) -> String {
    token
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
        .to_lowercase()
}

fn collapse_repeated_words(text: &str) -> String {
    let mut words = Vec::new();
    let mut previous = String::new();
    for token in text.split_whitespace() {
        let normalized = normalize_token(token);
        if normalized.len() > 1 && normalized == previous {
            continue;
        }
        previous = normalized;
        words.push(token);
    }
    words.join(" ")
}

fn apply_basic_punctuation_casing(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 1);
    let mut capitalize_next = true;
    for ch in text.chars() {
        if capitalize_next && ch.is_alphabetic() {
            for upper in ch.to_uppercase() {
                out.push(upper);
            }
            capitalize_next = false;
            continue;
        }
        out.push(ch);
        if matches!(ch, '.' | '!' | '?' | '\n') {
            capitalize_next = true;
        } else if !ch.is_whitespace() && !matches!(ch, '"' | '\'' | '(' | '[' | '{') {
            capitalize_next = false;
        }
    }
    if should_append_period(&out) {
        out.push('.');
    }
    out
}

fn should_append_period(text: &str) -> bool {
    let mut chars = text.trim_end().chars().rev();
    let Some(mut last) = chars.next() else {
        return false;
    };
    while matches!(last, '"' | '\'' | ')' | ']' | '}') {
        let Some(next) = chars.next() else {
            return false;
        };
        last = next;
    }
    !matches!(last, '.' | '!' | '?' | ':' | ';')
}

fn normalize_spacing(text: &str) -> String {
    let mut out = SPACE_BEFORE_PUNCT_RE.replace_all(text, "$1").to_string();
    out = SPACE_AFTER_PUNCT_RE.replace_all(&out, "$1 $2").to_string();
    out = OPEN_PAREN_SPACE_RE.replace_all(&out, "(").to_string();
    out = SPACE_CLOSE_PAREN_RE.replace_all(&out, ")").to_string();
    out = NEWLINE_SPACE_RE.replace_all(&out, "\n").to_string();
    out = MULTISPACE_RE.replace_all(&out, " ").to_string();
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_for(model: &str) -> WinsttSettings {
        let mut ws = WinsttSettings::default();
        ws.model.model = model.to_string();
        ws
    }

    #[test]
    fn explicit_quote_commands_become_literal_quotes() {
        let mut ws = settings_for("dolphin-base-ctc");
        ws.quality.format_quote_commands = true;
        assert_eq!(
            apply_deterministic_formatting("click quote Save changes unquote", &ws),
            "click \"Save changes\""
        );
    }

    #[test]
    fn disabled_formatting_preserves_text_byte_for_byte() {
        let ws = settings_for("dolphin-base-ctc");
        assert_eq!(
            apply_deterministic_formatting("  keep   spacing  ", &ws),
            "  keep   spacing  "
        );
    }

    #[test]
    fn spoken_punctuation_commands_become_symbols_and_lines() {
        let mut ws = settings_for("dolphin-base-ctc");
        ws.quality.format_spoken_punctuation_commands = true;
        assert_eq!(
            apply_deterministic_formatting("hello comma world new line done period", &ws),
            "hello, world\ndone."
        );
    }

    #[test]
    fn technical_symbol_commands_cover_flags_email_domains_and_paths() {
        let mut ws = settings_for("dolphin-base-ctc");
        ws.quality.format_spoken_symbol_commands = true;
        assert_eq!(
            apply_deterministic_formatting(
                "npm install dash dash save email john dot smith at example dot com open example dot com slash docs slash usr slash local C colon backslash Users backslash Sam",
                &ws,
            ),
            "npm install --save email john.smith@example.com open example.com/docs /usr/local C:\\Users\\Sam"
        );
    }

    #[test]
    fn filler_cleanup_removes_exact_fillers_and_adjacent_repeats() {
        let mut ws = settings_for("dolphin-base-ctc");
        ws.quality.format_filler_repeat_cleanup = true;
        assert_eq!(
            apply_deterministic_formatting("um the the draft is is ready", &ws),
            "the draft is ready"
        );
    }

    #[test]
    fn basic_punctuation_casing_skips_models_with_native_formatting() {
        let mut raw = settings_for("dolphin-base-ctc");
        raw.quality.format_basic_punctuation_casing = true;
        assert_eq!(
            apply_deterministic_formatting("hello world", &raw),
            "Hello world."
        );

        let mut whisper = settings_for("large-v3");
        whisper.quality.format_basic_punctuation_casing = true;
        assert_eq!(
            apply_deterministic_formatting("hello world", &whisper),
            "hello world"
        );
    }
}
