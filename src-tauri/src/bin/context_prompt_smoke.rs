use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{json, Value};
use winstt_app_lib::winstt::context::{format_context_for_prompt, parse_snapshot};

#[derive(Debug, Default)]
struct Args {
    input: Option<PathBuf>,
    label: Option<String>,
    require_prompt_json: bool,
    dump_prompt: bool,
    context_fixtures: Option<PathBuf>,
}

#[derive(Debug)]
struct ContextFixture {
    index: usize,
    app: String,
    exe: String,
    surface_type: String,
    expected_tier: u8,
    focused_role: String,
    example_ax_html: String,
    example_text_before: String,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args()?;
    if let Some(path) = args.context_fixtures.as_deref() {
        return run_context_fixtures(path);
    }

    let raw = read_input(args.input.as_ref())?;
    let raw_json: Result<Value, _> = serde_json::from_str(&raw);
    let snapshot = parse_snapshot(&raw);
    let prompt = format_context_for_prompt(&snapshot);
    let prompt_json: Result<Value, _> = serde_json::from_str(&prompt);
    let prompt_valid = prompt_json.is_ok();

    // Diagnostic: print the raw emitted prompt fragment (the JSON the LLM would
    // receive) so a re-capture can eyeball the attributed turns. No report.
    if args.dump_prompt {
        println!("{prompt}");
        return Ok(());
    }

    if args.require_prompt_json && !prompt_valid {
        let report = build_report(args.label.as_deref(), &raw_json, &prompt_json, &prompt);
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Err("prompt fragment is not valid JSON".into());
    }

    let report = build_report(args.label.as_deref(), &raw_json, &prompt_json, &prompt);
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn parse_args() -> Result<Args, Box<dyn std::error::Error>> {
    let mut args = Args::default();
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--input" => {
                let value = iter.next().ok_or("--input requires a path")?;
                if value != "-" {
                    args.input = Some(PathBuf::from(value));
                }
            }
            "--label" => {
                args.label = Some(iter.next().ok_or("--label requires a value")?);
            }
            "--require-prompt-json" => args.require_prompt_json = true,
            "--dump-prompt" => args.dump_prompt = true,
            "--context-fixtures" => {
                args.context_fixtures = Some(PathBuf::from(
                    iter.next().ok_or("--context-fixtures requires a path")?,
                ));
            }
            "--help" | "-h" => {
                println!(
                    "Usage: context_prompt_smoke [--input PATH|-] [--label LABEL] [--require-prompt-json] [--context-fixtures PATH]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }
    Ok(args)
}

fn read_input(path: Option<&PathBuf>) -> io::Result<String> {
    let raw = match path {
        Some(path) => fs::read_to_string(path),
        None => {
            let mut raw = String::new();
            io::stdin().read_to_string(&mut raw)?;
            Ok(raw)
        }
    }?;
    Ok(raw.trim_start_matches('\u{feff}').to_string())
}

fn run_context_fixtures(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let source = fs::read_to_string(path)?;
    let fixtures = parse_context_fixtures(&source)?;
    let mut items = Vec::new();
    let mut failed = 0usize;

    for fixture in &fixtures {
        let label = fixture_label(fixture);
        let raw = fixture_raw_snapshot(fixture);
        let raw_json: Result<Value, _> = serde_json::from_str(&raw);
        let snapshot = parse_snapshot(&raw);
        let prompt = format_context_for_prompt(&snapshot);
        let prompt_json: Result<Value, _> = serde_json::from_str(&prompt);
        let report = build_report(Some(&label), &raw_json, &prompt_json, &prompt);
        let validation = validate_fixture_prompt(fixture, &label, &prompt_json);
        if !validation
            .get("passed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            failed += 1;
        }

        items.push(json!({
            "index": fixture.index,
            "app": sanitize_for_report(&fixture.app),
            "exe": fixture.exe,
            "surfaceType": fixture.surface_type,
            "expectedTier": fixture.expected_tier,
            "focusedRole": fixture.focused_role,
            "label": label,
            "report": report,
            "validation": validation,
        }));
    }

    let summary = json!({
        "fixtureCount": fixtures.len(),
        "failedCount": failed,
        "allPassed": failed == 0,
        "source": path.display().to_string(),
        "fixtures": items,
    });
    println!("{}", serde_json::to_string_pretty(&summary)?);

    if failed > 0 {
        return Err(format!("{failed} context fixture(s) failed").into());
    }
    Ok(())
}

fn parse_context_fixtures(
    source: &str,
) -> Result<Vec<ContextFixture>, Box<dyn std::error::Error>> {
    let blocks = extract_ts_object_blocks(source, "APP_FIXTURES")?;
    let mut fixtures = Vec::with_capacity(blocks.len());
    for (i, block) in blocks.iter().enumerate() {
        fixtures.push(ContextFixture {
            index: i,
            app: read_ts_string_field(block, "app")?,
            exe: read_ts_string_field(block, "exe")?,
            surface_type: read_ts_string_field(block, "surfaceType")?,
            expected_tier: read_ts_number_field(block, "expectedTier")? as u8,
            focused_role: read_ts_string_field(block, "focusedRole")?,
            example_ax_html: read_ts_string_field(block, "exampleAxHtml")?,
            example_text_before: read_ts_string_field(block, "exampleTextBefore")?,
        });
    }
    Ok(fixtures)
}

fn extract_ts_object_blocks(
    source: &str,
    array_name: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let array_pos = source
        .find(array_name)
        .ok_or_else(|| format!("{array_name} array not found"))?;
    let assignment_pos = source[array_pos..]
        .find('=')
        .map(|offset| array_pos + offset)
        .ok_or_else(|| format!("{array_name} assignment not found"))?;
    let array_start = source[assignment_pos..]
        .find('[')
        .map(|offset| assignment_pos + offset)
        .ok_or_else(|| format!("{array_name} array start not found"))?;
    let mut blocks = Vec::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut depth = 0usize;
    let mut block_start: Option<usize> = None;

    for (idx, ch) in source[array_start..].char_indices() {
        let abs_idx = array_start + idx;
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == q {
                quote = None;
            }
            continue;
        }

        match ch {
            '\'' | '"' | '`' => quote = Some(ch),
            '{' => {
                if depth == 0 {
                    block_start = Some(abs_idx);
                }
                depth += 1;
            }
            '}' => {
                if depth == 0 {
                    return Err("fixture object close without open".into());
                }
                depth -= 1;
                if depth == 0 {
                    let start = block_start.take().ok_or("fixture object start lost")?;
                    blocks.push(source[start..=abs_idx].to_string());
                }
            }
            ']' if depth == 0 => break,
            _ => {}
        }
    }

    if depth != 0 {
        return Err("fixture array ended inside an object".into());
    }
    if blocks.is_empty() {
        return Err("no fixture objects found".into());
    }
    Ok(blocks)
}

fn read_ts_string_field(block: &str, key: &str) -> Result<String, Box<dyn std::error::Error>> {
    let value_start = field_value_start(block, key)?;
    let quote = block[value_start..]
        .chars()
        .next()
        .ok_or_else(|| format!("{key} value is empty"))?;
    if quote != '\'' && quote != '"' && quote != '`' {
        return Err(format!("{key} is not a string literal").into());
    }

    let mut raw = String::new();
    let mut escaped = false;
    for ch in block[value_start + quote.len_utf8()..].chars() {
        if escaped {
            raw.push('\\');
            raw.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return Ok(unescape_ts_string(&raw));
        }
        raw.push(ch);
    }
    Err(format!("{key} string literal is unterminated").into())
}

fn read_ts_number_field(block: &str, key: &str) -> Result<u64, Box<dyn std::error::Error>> {
    let value_start = field_value_start(block, key)?;
    let value = block[value_start..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if value.is_empty() {
        return Err(format!("{key} is not a number").into());
    }
    Ok(value.parse()?)
}

fn field_value_start(block: &str, key: &str) -> Result<usize, Box<dyn std::error::Error>> {
    let key_pos = block
        .find(key)
        .ok_or_else(|| format!("{key} field not found"))?;
    let colon_pos = block[key_pos..]
        .find(':')
        .map(|offset| key_pos + offset + 1)
        .ok_or_else(|| format!("{key} field has no colon"))?;
    Ok(colon_pos
        + block[colon_pos..]
            .find(|ch: char| !ch.is_whitespace())
            .ok_or_else(|| format!("{key} value not found"))?)
}

fn unescape_ts_string(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('\\') => out.push('\\'),
            Some('\'') => out.push('\''),
            Some('"') => out.push('"'),
            Some('`') => out.push('`'),
            Some('u') => {
                let hex = chars.by_ref().take(4).collect::<String>();
                if let Ok(codepoint) = u32::from_str_radix(&hex, 16) {
                    if let Some(value) = char::from_u32(codepoint) {
                        out.push(value);
                    }
                }
            }
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

fn fixture_raw_snapshot(fixture: &ContextFixture) -> String {
    json!({
        "windowTitle": fixture_window_title(fixture),
        "elementName": focused_element_name(&fixture.example_ax_html)
            .unwrap_or_else(|| fixture.focused_role.clone()),
        "focusedText": "",
        "textBefore": fixture.example_text_before,
        "textAfter": "",
        "appExe": fixture.exe,
        "url": infer_fixture_url(fixture),
        "axHtml": fixture.example_ax_html,
    })
    .to_string()
}

fn fixture_window_title(fixture: &ContextFixture) -> String {
    Regex::new(r#"(?is)<window\b[^>]*>"#)
        .unwrap()
        .find(&fixture.example_ax_html)
        .and_then(|tag| attr_value(tag.as_str(), "name"))
        .map(|value| decode_xml_entities(&value))
        .unwrap_or_else(|| fixture.app.clone())
}

fn focused_element_name(ax_html: &str) -> Option<String> {
    let tag_re = Regex::new(r#"(?is)<[^>]*\bfocus=["']1["'][^>]*>"#).unwrap();
    for tag in tag_re.find_iter(ax_html) {
        if let Some(value) = attr_value(tag.as_str(), "name") {
            return Some(decode_xml_entities(&value));
        }
    }
    None
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let pattern = format!("{attr}=");
    let start = tag.find(&pattern)? + pattern.len();
    let mut chars = tag[start..].chars();
    let quote = chars.next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }

    let mut value = String::new();
    for ch in chars {
        if ch == quote {
            return Some(value);
        }
        value.push(ch);
    }
    None
}

fn infer_fixture_url(fixture: &ContextFixture) -> String {
    if let Some(url) = extract_known_url(&fixture.example_ax_html) {
        return url;
    }

    let app = fixture.app.to_lowercase();
    match app.as_str() {
        name if name.contains("gmail") => "https://mail.google.com/mail/u/0/#inbox".to_string(),
        name if name.contains("messenger") => "https://www.messenger.com/t/100087".to_string(),
        name if name.contains("chatgpt") => "https://chatgpt.com/c/abc123".to_string(),
        name if name.contains("claude") => "https://claude.ai/chat/abc-123".to_string(),
        name if name.contains("x.com") || name.contains("twitter") => {
            "https://x.com/home".to_string()
        }
        name if name.contains("github") => "https://github.com/acme/widget/issues/482".to_string(),
        name if name.contains("instagram") => "https://instagram.com/direct/inbox".to_string(),
        name if name.contains("canva") => "https://www.canva.com/design/DAF/edit".to_string(),
        name if name.contains("google sheets") => {
            "https://docs.google.com/spreadsheets/d/abc123/edit".to_string()
        }
        _ => String::new(),
    }
}

fn extract_known_url(value: &str) -> Option<String> {
    let re = Regex::new(
        r#"(?i)\b((?:https?://)?(?:mail\.google\.com|messenger\.com|facebook\.com|chatgpt\.com|claude\.ai|x\.com|twitter\.com|github\.com|instagram\.com|canva\.com|docs\.google\.com|figma\.com)[^<>"'\s]*)"#,
    )
    .unwrap();
    let raw = re.captures(value)?.get(1)?.as_str().trim();
    if raw.starts_with("http://") || raw.starts_with("https://") {
        Some(raw.to_string())
    } else {
        Some(format!("https://{raw}"))
    }
}

fn fixture_label(fixture: &ContextFixture) -> String {
    let app = fixture.app.to_lowercase();
    if app.contains("gmail") || app.contains("outlook") {
        "gmail".to_string()
    } else if app.contains("discord") {
        "discord".to_string()
    } else if app.contains("messenger") {
        "facebook-messenger".to_string()
    } else if app.contains("slack") {
        "slack".to_string()
    } else if app.contains("whatsapp") {
        "whatsapp".to_string()
    } else if app.contains("x.com") || app.contains("twitter") {
        "x".to_string()
    } else if app.contains("chatgpt") {
        "codex".to_string()
    } else if app.contains("claude") {
        "claude".to_string()
    } else if app.contains("instagram") {
        "facebook-messenger".to_string()
    } else if fixture.surface_type == "chat" {
        "chat".to_string()
    } else {
        fixture
            .app
            .to_lowercase()
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-")
    }
}

fn validate_fixture_prompt(
    fixture: &ContextFixture,
    _label: &str,
    prompt_json: &Result<Value, serde_json::Error>,
) -> Value {
    let prompt_json_valid = prompt_json.is_ok();
    let context_chars = prompt_context_chars(prompt_json);
    let context_lines = line_count(Some(&prompt_context_text(prompt_json)));
    let leaks = leaked_ui_chrome_terms(prompt_json);
    let min_context_chars = fixture_min_context_chars(fixture);
    let mut failures = Vec::new();

    if !prompt_json_valid {
        failures.push("prompt_not_valid_json");
    }
    if fixture.expected_tier == 3 && context_chars < min_context_chars {
        failures.push("tier3_context_too_shallow");
    }
    if fixture.expected_tier == 5 && context_chars > 0 && !leaks.is_empty() {
        failures.push("tier5_ui_tree_leaked");
    }
    if fixture.expected_tier == 3 && !leaks.is_empty() {
        failures.push("ui_chrome_leaked");
    }
    if requires_reply_ready_fixture(fixture) && !fixture_prompt_reply_ready(fixture, prompt_json) {
        failures.push("reply_fixture_not_ready");
    }

    json!({
        "passed": failures.is_empty(),
        "failures": failures,
        "contextChars": context_chars,
        "contextLines": context_lines,
        "minContextChars": min_context_chars,
        "uiChromeLeaks": leaks,
    })
}

fn fixture_min_context_chars(fixture: &ContextFixture) -> usize {
    match fixture.surface_type.as_str() {
        "webmail" | "chat" => 80,
        "social" | "editor" | "doc" => 40,
        _ => 0,
    }
}

fn requires_reply_ready_fixture(fixture: &ContextFixture) -> bool {
    matches!(fixture.surface_type.as_str(), "webmail" | "chat" | "social")
}

fn fixture_prompt_reply_ready(
    fixture: &ContextFixture,
    prompt_json: &Result<Value, serde_json::Error>,
) -> bool {
    let Some(object) = prompt_json.as_ref().ok().and_then(Value::as_object) else {
        return false;
    };
    let context_text = prompt_context_text(prompt_json);
    let field = object.get("field").and_then(Value::as_str).unwrap_or("");
    let window = object.get("window").and_then(Value::as_str).unwrap_or("");
    let enough_context = context_text.chars().count() >= fixture_min_context_chars(fixture);
    let enough_speakers = if fixture.surface_type == "chat" || fixture.surface_type == "social" {
        speaker_like_line_count(&context_text) >= 1
    } else {
        true
    };
    let focus_miss_like = !field.trim().is_empty()
        && !window.trim().is_empty()
        && field.trim().eq_ignore_ascii_case(window.trim());
    let otp_noise = count_regex(
        &context_text,
        r"(?i)\b(?:one[- ]time|single[- ]use|login code|verification code|otp)\b",
    ) > 0;
    let login_or_skeleton_noise = login_or_skeleton_noise_present(&context_text);

    enough_context
        && enough_speakers
        && looks_like_composer_field(field)
        && !focus_miss_like
        && !otp_noise
        && !login_or_skeleton_noise
}

fn prompt_context_chars(prompt_json: &Result<Value, serde_json::Error>) -> usize {
    prompt_context_text(prompt_json).chars().count()
}

fn prompt_context_text(prompt_json: &Result<Value, serde_json::Error>) -> String {
    let Some(object) = prompt_json.as_ref().ok().and_then(Value::as_object) else {
        return String::new();
    };
    [
        "selection",
        "beforeCaret",
        "afterCaret",
        "fieldText",
        "screen",
        "screenOcr",
        "clipboard",
    ]
    .iter()
    .filter_map(|key| object.get(*key).and_then(Value::as_str))
    .collect::<Vec<_>>()
    .join("\n")
}

fn leaked_ui_chrome_terms(prompt_json: &Result<Value, serde_json::Error>) -> Vec<&'static str> {
    let text = prompt_context_text(prompt_json).to_lowercase();
    [
        "address and search bar",
        "chrome tabs",
        "tab strip",
        "browser chrome",
        "bookmarks",
        "app bar",
        "status bar",
        "conversation list",
        "navigation rail",
        "message actions",
        "composer actions",
        "formatting options",
        "side panel",
        "sheet tabs",
        "document toolbar",
    ]
    .into_iter()
    .filter(|term| text.contains(term))
    .collect()
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn build_report(
    label: Option<&str>,
    raw_json: &Result<Value, serde_json::Error>,
    prompt_json: &Result<Value, serde_json::Error>,
    prompt: &str,
) -> Value {
    let prompt_object = prompt_json.as_ref().ok().and_then(Value::as_object);
    let mut field_chars = BTreeMap::new();
    let mut keys = Vec::new();
    if let Some(object) = prompt_object {
        for (key, value) in object {
            keys.push(key.clone());
            let len = match value {
                Value::String(value) => value.chars().count(),
                Value::Bool(_) => 1,
                other => other.to_string().chars().count(),
            };
            field_chars.insert(key.clone(), len);
        }
    }

    let prompt_text = prompt_object
        .map(|object| {
            object
                .values()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    let raw_object = raw_json.as_ref().ok().and_then(Value::as_object);
    let window = raw_object
        .and_then(|object| object.get("windowTitle"))
        .and_then(Value::as_str)
        .map(sanitize_for_report)
        .unwrap_or_default();
    let element = raw_object
        .and_then(|object| object.get("elementName"))
        .and_then(Value::as_str)
        .map(sanitize_for_report)
        .unwrap_or_default();
    let app = raw_object
        .and_then(|object| object.get("appExe"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let url_host = raw_object
        .and_then(|object| object.get("url"))
        .and_then(Value::as_str)
        .and_then(url_host)
        .unwrap_or_default();

    let screen_lines = line_count(
        prompt_object
            .and_then(|object| object.get("screen"))
            .and_then(Value::as_str),
    );
    let before_caret_lines = line_count(
        prompt_object
            .and_then(|object| object.get("beforeCaret"))
            .and_then(Value::as_str),
    );
    let field_text_lines = line_count(
        prompt_object
            .and_then(|object| object.get("fieldText"))
            .and_then(Value::as_str),
    );
    let all_prompt_lines = line_count(Some(&prompt_text));
    let speaker_like_lines = speaker_like_line_count(&prompt_text);
    let email_like_count = count_regex(
        &prompt_text,
        r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    );
    let six_digit_code_like_count = count_regex(&prompt_text, r"\b\d{6}\b");
    let otp_noise_word_count = count_regex(
        &prompt_text,
        r"(?i)\b(?:one[- ]time|single[- ]use|login code|verification code|otp)\b",
    );
    let login_or_skeleton_noise = login_or_skeleton_noise_present(&prompt_text);
    let quality = build_quality(
        label.unwrap_or(""),
        &element,
        &window,
        prompt_json.is_ok(),
        prompt.trim().is_empty(),
        prompt_text.chars().count(),
        all_prompt_lines,
        speaker_like_lines,
        otp_noise_word_count,
        login_or_skeleton_noise,
    );

    json!({
        "label": label.unwrap_or(""),
        "rawJsonValid": raw_json.is_ok(),
        "promptJsonValid": prompt_json.is_ok(),
        "promptEmpty": prompt.trim().is_empty(),
        "promptKeys": keys,
        "fieldChars": field_chars,
        "lineCounts": {
            "screen": screen_lines,
            "beforeCaret": before_caret_lines,
            "fieldText": field_text_lines,
            "allPromptText": all_prompt_lines,
            "speakerLike": speaker_like_lines,
        },
        "privacySignals": {
            "emailLikeCount": email_like_count,
            "sixDigitCodeLikeCount": six_digit_code_like_count,
            "otpNoiseWordCount": otp_noise_word_count,
            "loginOrSkeletonNoise": login_or_skeleton_noise,
        },
        "quality": quality,
        "source": {
            "window": window,
            "element": element,
            "app": app,
            "urlHost": url_host,
        },
    })
}

fn sanitize_for_report(value: &str) -> String {
    let email_re = Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap();
    email_re
        .replace_all(value, "[email]")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn url_host(url: &str) -> Option<String> {
    let without_scheme = url.split("://").nth(1).unwrap_or(url);
    let host = without_scheme.split(['/', '?', '#']).next()?.trim();
    (!host.is_empty()).then(|| host.to_string())
}

fn line_count(value: Option<&str>) -> usize {
    value
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count()
}

fn speaker_like_line_count(value: &str) -> usize {
    let re = Regex::new(r"(?m)^\s*(?:@?[\p{L}\p{N} _.'-]{2,40}|You|Me):\s+\S").unwrap();
    re.find_iter(value).count()
}

fn count_regex(value: &str, pattern: &str) -> usize {
    Regex::new(pattern).unwrap().find_iter(value).count()
}

fn login_or_skeleton_noise_present(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.contains("email or phone")
        || lower.contains("forgot email")
        || lower.contains("forgot password")
        || (lower.contains("create account")
            && (lower.contains("sign in") || lower.contains("log in")))
        || (lower.contains("loading") && lower.contains("please wait"))
}

#[allow(clippy::too_many_arguments)]
fn build_quality(
    label: &str,
    element: &str,
    window: &str,
    prompt_json_valid: bool,
    prompt_empty: bool,
    prompt_chars: usize,
    prompt_lines: usize,
    speaker_like_lines: usize,
    otp_noise_word_count: usize,
    login_or_skeleton_noise: bool,
) -> Value {
    let min_lines = min_context_lines(label);
    let focused_field_looks_composer = looks_like_composer_field(element);
    let focus_miss_like = !element.trim().is_empty()
        && !window.trim().is_empty()
        && element.trim().eq_ignore_ascii_case(window.trim());
    let has_depth = prompt_chars >= min_context_chars(label) && prompt_lines >= min_lines;
    let multi_speaker_context =
        is_chat_like_label(label) && speaker_like_lines >= min_speaker_lines(label);
    let context_payload_usable = prompt_json_valid
        && !prompt_empty
        && has_depth
        && otp_noise_word_count == 0
        && !login_or_skeleton_noise;
    let reply_context_ready =
        context_payload_usable && focused_field_looks_composer && !focus_miss_like;

    json!({
        "replyContextReady": reply_context_ready,
        "contextPayloadUsable": context_payload_usable,
        "hasContextDepth": has_depth,
        "minContextLines": min_lines,
        "minContextChars": min_context_chars(label),
        "focusedFieldLooksComposer": focused_field_looks_composer,
        "focusMissLike": focus_miss_like,
        "multiSpeakerContext": multi_speaker_context,
        "warnings": quality_warnings(
            prompt_json_valid,
            prompt_empty,
            has_depth,
            focused_field_looks_composer,
            focus_miss_like,
            is_chat_like_label(label),
            multi_speaker_context,
            otp_noise_word_count,
            login_or_skeleton_noise,
        ),
    })
}

fn min_context_lines(label: &str) -> usize {
    match label {
        "gmail" => 5,
        "discord" | "facebook-messenger" | "slack" | "whatsapp" => 4,
        "facebook-main" | "x" => 4,
        "codex" | "claude" => 3,
        _ => 2,
    }
}

fn min_context_chars(label: &str) -> usize {
    match label {
        "gmail" => 400,
        "discord" | "facebook-messenger" | "slack" | "whatsapp" => 250,
        "facebook-main" | "x" => 250,
        "codex" | "claude" => 180,
        _ => 120,
    }
}

fn min_speaker_lines(label: &str) -> usize {
    match label {
        "gmail" | "codex" | "claude" => 1,
        "facebook-main" | "x" => 1,
        _ => 2,
    }
}

fn is_chat_like_label(label: &str) -> bool {
    matches!(
        label,
        "discord"
            | "facebook-messenger"
            | "facebook-main"
            | "slack"
            | "whatsapp"
            | "x"
            | "codex"
            | "claude"
    )
}

fn looks_like_composer_field(element: &str) -> bool {
    Regex::new(
        r"(?i)\b(?:message|reply|comment|compose|write|type a message|send a chat|ask|prompt|post|tweet|body)\b",
    )
    .unwrap()
    .is_match(element)
}

#[allow(clippy::too_many_arguments)]
fn quality_warnings(
    prompt_json_valid: bool,
    prompt_empty: bool,
    has_depth: bool,
    focused_field_looks_composer: bool,
    focus_miss_like: bool,
    chat_like: bool,
    multi_speaker_context: bool,
    otp_noise_word_count: usize,
    login_or_skeleton_noise: bool,
) -> Vec<&'static str> {
    let mut warnings = Vec::new();
    if !prompt_json_valid {
        warnings.push("prompt_not_valid_json");
    }
    if prompt_empty {
        warnings.push("prompt_empty");
    }
    if !has_depth {
        warnings.push("context_too_shallow_for_reply");
    }
    if !focused_field_looks_composer {
        warnings.push("focused_field_not_obviously_composer");
    }
    if focus_miss_like {
        warnings.push("focused_element_matches_window_title");
    }
    if chat_like && !multi_speaker_context {
        warnings.push("multi_speaker_depth_not_observed");
    }
    if otp_noise_word_count > 0 {
        warnings.push("otp_or_login_code_noise_detected");
    }
    if login_or_skeleton_noise {
        warnings.push("login_or_skeleton_page_detected");
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report_for_raw(raw: &str, label: &str) -> Value {
        let raw_json: Result<Value, _> = serde_json::from_str(raw);
        let snapshot = parse_snapshot(raw);
        let prompt = format_context_for_prompt(&snapshot);
        let prompt_json: Result<Value, _> = serde_json::from_str(&prompt);
        build_report(Some(label), &raw_json, &prompt_json, &prompt)
    }

    #[test]
    fn report_sanitizes_email_addresses() {
        assert_eq!(
            sanitize_for_report("Inbox - person@example.test - Gmail"),
            "Inbox - [email] - Gmail"
        );
    }

    #[test]
    fn host_extraction_handles_plain_and_schemed_urls() {
        assert_eq!(
            url_host("https://mail.google.com/mail/u/0/#inbox").as_deref(),
            Some("mail.google.com")
        );
        assert_eq!(
            url_host("discord.com/channels/1/2").as_deref(),
            Some("discord.com")
        );
    }

    #[test]
    fn speaker_like_lines_are_counted_without_content_output() {
        let text = "Alice: first\nnot a turn\nYou: second\n@handle: third\nعلي: تمام";
        assert_eq!(speaker_like_line_count(text), 4);
        assert_eq!(line_count(Some(text)), 5);
    }

    #[test]
    fn smoke_reports_long_gmail_reply_ready() {
        let thread = (1..=8)
            .map(|i| {
                format!(
                    "Sender {i}: This is a detailed multi-page Gmail reply context line with rollout blockers, owners, dates, and next steps."
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let raw = json!({
            "windowTitle": "Rollout thread - Gmail",
            "elementName": "Message Body",
            "focusedText": "",
            "textBefore": thread,
            "textAfter": "",
            "appExe": "chrome.exe",
            "url": "https://mail.google.com/mail/u/0/#inbox/thread-long"
        })
        .to_string();

        let report = report_for_raw(&raw, "gmail");
        assert_eq!(report["promptJsonValid"], true);
        assert_eq!(report["quality"]["contextPayloadUsable"], true);
        assert_eq!(report["quality"]["replyContextReady"], true);
        assert!(report["promptKeys"]
            .as_array()
            .unwrap()
            .contains(&Value::String("beforeCaret".to_string())));
    }

    #[test]
    fn smoke_counts_unicode_senders_in_chat_threads() {
        let raw = json!({
            "windowTitle": "Discord | #general",
            "elementName": "Message #general",
            "focusedText": "",
            "appExe": "chrome.exe",
            "url": "https://discord.com/channels/1/2",
            "axHtml": r#"
              <pane name="Discord">
                <list name="Messages">
                  <item name="Maya: I can reproduce the same reply-context issue in the DM thread."/>
                  <item name="علي: خلينا نثبت مشكلة السياق قبل الرد النهائي."/>
                  <item name="You: I will keep the reply scoped to the rendered thread."/>
                  <edit name="Message #general" focus="1"></edit>
                </list>
              </pane>
            "#
        })
        .to_string();

        let report = report_for_raw(&raw, "discord");
        assert_eq!(report["promptJsonValid"], true);
        assert_eq!(report["lineCounts"]["speakerLike"], 3);
        assert_eq!(report["quality"]["multiSpeakerContext"], true);
        assert_eq!(report["quality"]["replyContextReady"], true);
    }

    #[test]
    fn smoke_rejects_otp_noise_as_usable_payload() {
        let raw = json!({
            "windowTitle": "Security notice - Gmail",
            "elementName": "Message Body",
            "focusedText": "",
            "textBefore": "Security Team: Your verification code is 123456.\nThis one-time code expires in ten minutes.\nDo not share it.\nThanks,\nSecurity Team",
            "appExe": "chrome.exe",
            "url": "https://mail.google.com/mail/u/0/#inbox/security"
        })
        .to_string();

        let report = report_for_raw(&raw, "gmail");
        assert_eq!(report["promptJsonValid"], true);
        assert_eq!(report["quality"]["contextPayloadUsable"], false);
        assert!(report["quality"]["warnings"]
            .as_array()
            .unwrap()
            .contains(&Value::String(
                "otp_or_login_code_noise_detected".to_string()
            )));
    }

    #[test]
    fn quality_flags_reply_depth_and_composer_focus() {
        let quality = build_quality(
            "discord",
            "Message #release",
            "Discord",
            true,
            false,
            500,
            8,
            3,
            0,
            false,
        );
        assert_eq!(quality["replyContextReady"], true);
        assert_eq!(quality["focusedFieldLooksComposer"], true);
        assert_eq!(quality["multiSpeakerContext"], true);
        assert!(quality["warnings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn quality_warns_on_page_focus_without_speaker_depth() {
        let quality = build_quality(
            "x",
            "Home / X",
            "Home / X - Google Chrome",
            true,
            false,
            500,
            8,
            0,
            0,
            false,
        );
        assert_eq!(quality["contextPayloadUsable"], true);
        assert_eq!(quality["replyContextReady"], false);
        assert_eq!(quality["focusedFieldLooksComposer"], false);
        let warnings = quality["warnings"].as_array().unwrap();
        assert!(warnings.contains(&Value::String(
            "focused_field_not_obviously_composer".to_string()
        )));
        assert!(warnings.contains(&Value::String(
            "multi_speaker_depth_not_observed".to_string()
        )));
    }

    #[test]
    fn smoke_rejects_not_logged_in_or_skeleton_pages_as_usable_payload() {
        let raw = json!({
            "windowTitle": "Sign in - Google Accounts",
            "elementName": "Email or phone",
            "focusedText": "",
            "appExe": "chrome.exe",
            "url": "https://accounts.google.com/signin",
            "axHtml": r#"
              <window name="Sign in - Google Accounts">
                <doc name="Google Accounts">
                  <text>Sign in</text>
                  <text>Use your Google Account</text>
                  <edit name="Email or phone" focus="1"></edit>
                  <button name="Forgot email?"/>
                  <button name="Create account"/>
                  <button name="Next"/>
                </doc>
              </window>
            "#
        })
        .to_string();

        let report = report_for_raw(&raw, "gmail");
        assert_eq!(report["promptJsonValid"], true);
        assert_eq!(report["privacySignals"]["loginOrSkeletonNoise"], true);
        assert_eq!(report["quality"]["contextPayloadUsable"], false);
        assert!(report["quality"]["warnings"]
            .as_array()
            .unwrap()
            .contains(&Value::String(
                "login_or_skeleton_page_detected".to_string()
            )));
    }

    #[test]
    fn context_fixture_parser_skips_type_annotation_and_unescapes_strings() {
        let source = r#"
            export interface AppFixture { app: string; }
            export const APP_FIXTURES: readonly AppFixture[] = [
                {
                    app: "Messenger",
                    exe: "chrome.exe",
                    surfaceType: "chat",
                    expectedTier: 3,
                    focusedRole: "edit",
                    exampleAxHtml: '<window name="Messenger"><item name="Maya Chen">it\'s {still} Friday</item><edit name="Message" focus="1"></edit></window>',
                    exampleTextBefore: "",
                    idealLlmContext: "",
                    idealAsrTail: "",
                },
            ] as const;
        "#;

        let fixtures = parse_context_fixtures(source).unwrap();
        assert_eq!(fixtures.len(), 1);
        assert_eq!(fixtures[0].app, "Messenger");
        assert_eq!(fixtures[0].expected_tier, 3);
        assert!(fixtures[0].example_ax_html.contains("it's {still} Friday"));
    }

    #[test]
    fn fixture_validation_accepts_messenger_name_body_turns() {
        let fixture = ContextFixture {
            index: 0,
            app: "Messenger (messenger.com / Facebook Messages in Chrome)".to_string(),
            exe: "chrome.exe".to_string(),
            surface_type: "chat".to_string(),
            expected_tier: 3,
            focused_role: "edit".to_string(),
            example_ax_html: r#"
                <window name="Messenger - Google Chrome">
                  <doc name="Messenger">
                    <group name="Message thread">
                      <list name="Messages in conversation with Maya Chen">
                        <item name="Maya Chen">Hey, are we still on for Friday's standup?</item>
                        <item name="You">let me check my calendar</item>
                        <item name="Maya Chen">No rush! Just let me know by tonight.</item>
                      </list>
                      <edit name="Message" focus="1"></edit>
                    </group>
                  </doc>
                </window>
            "#
            .to_string(),
            example_text_before: String::new(),
        };

        let raw = fixture_raw_snapshot(&fixture);
        let snapshot = parse_snapshot(&raw);
        let prompt = format_context_for_prompt(&snapshot);
        let prompt_json: Result<Value, _> = serde_json::from_str(&prompt);
        let validation = validate_fixture_prompt(&fixture, "facebook-messenger", &prompt_json);
        assert_eq!(validation["passed"], true);
        assert!(prompt_context_text(&prompt_json).contains("Maya Chen: Hey"));
    }
}
