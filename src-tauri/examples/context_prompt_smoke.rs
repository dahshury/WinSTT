//! context_prompt_smoke — inspect the prompt fragment a raw capture produces.
//!
//! Parses a single raw sidecar snapshot (from `--input PATH` or stdin), runs it
//! through the GENERIC context formatter (report R2 — the only path now that the
//! per-app understanding layer is deleted), and prints a JSON report describing
//! the fragment the LLM would receive: which keys it carries, per-field char
//! counts, generic privacy signals (OTP / email / bare-code detectors), and a
//! coarse "quality" summary. Used by the Windows capture tools
//! (`tools/windows/context-*-capture.ps1`) to eyeball a live capture.
//!
//! This is a cargo EXAMPLE (dev tool), not a bundled bin — src-tauri/src/bin is
//! reserved for the shipped context sidecar (enforced by tests/bundle_hygiene).

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;

use regex::Regex;
use serde_json::{Value, json};
use winstt_app_lib::winstt::context::{format_context_for_prompt, parse_snapshot};

#[derive(Debug, Default)]
struct Args {
    input: Option<PathBuf>,
    label: Option<String>,
    require_prompt_json: bool,
    dump_prompt: bool,
}

type SmokeResult<T> = Result<T, SmokeError>;

#[derive(Debug, thiserror::Error)]
enum SmokeError {
    #[error("{0}")]
    Message(String),

    #[error(transparent)]
    Io(#[from] io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl From<String> for SmokeError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

impl From<&'static str> for SmokeError {
    fn from(value: &'static str) -> Self {
        Self::Message(value.to_string())
    }
}

fn static_regex(pattern: &str) -> Regex {
    match Regex::new(pattern) {
        Ok(regex) => regex,
        Err(err) => unreachable!("invalid static regex {pattern:?}: {err}"),
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run() -> SmokeResult<()> {
    let args = parse_args()?;

    let raw = read_input(args.input.as_ref())?;
    let raw_json: Result<Value, _> = serde_json::from_str(&raw);
    let snapshot = parse_snapshot(&raw);
    let prompt = format_context_for_prompt(&snapshot);
    let prompt_json: Result<Value, _> = serde_json::from_str(&prompt);
    let prompt_valid = prompt_json.is_ok();

    // Diagnostic: print the raw emitted prompt fragment (the JSON the LLM would
    // receive) so a re-capture can eyeball the context. No report.
    if args.dump_prompt {
        println!("{prompt}");
        return Ok(());
    }

    let report = build_report(args.label.as_deref(), &raw_json, &prompt_json, &prompt);
    println!("{}", serde_json::to_string_pretty(&report)?);

    if args.require_prompt_json && !prompt_valid {
        return Err("prompt fragment is not valid JSON".into());
    }
    Ok(())
}

fn parse_args() -> SmokeResult<Args> {
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
            "--help" | "-h" => {
                println!(
                    "Usage: context_prompt_smoke [--input PATH|-] [--label LABEL] [--require-prompt-json] [--dump-prompt]"
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
        &element,
        &window,
        prompt_json.is_ok(),
        prompt.trim().is_empty(),
        prompt_text.chars().count(),
        all_prompt_lines,
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
    let email_re = static_regex(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}");
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

fn count_regex(value: &str, pattern: &str) -> usize {
    match Regex::new(pattern) {
        Ok(regex) => regex.find_iter(value).count(),
        Err(err) => {
            eprintln!("invalid smoke-report regex {pattern:?}: {err}");
            0
        }
    }
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

/// Coarse, GENERIC quality summary (no per-app tier tables, no speaker-turn
/// reconstruction gate — those went with the legacy path). "Usable" = valid,
/// non-empty, enough text/lines to be worth sending, and free of OTP / login-
/// skeleton noise. "Reply-context ready" additionally wants the focused field to
/// look like a composer and not be a focus-miss (element == window title).
#[expect(
    clippy::too_many_arguments,
    reason = "quality report builder intentionally keeps the smoke-test fields flat"
)]
fn build_quality(
    element: &str,
    window: &str,
    prompt_json_valid: bool,
    prompt_empty: bool,
    prompt_chars: usize,
    prompt_lines: usize,
    otp_noise_word_count: usize,
    login_or_skeleton_noise: bool,
) -> Value {
    // App-agnostic depth floor: enough characters and lines to be substantive.
    const MIN_CONTEXT_CHARS: usize = 120;
    const MIN_CONTEXT_LINES: usize = 2;
    let focused_field_looks_composer = looks_like_composer_field(element);
    let focus_miss_like = !element.trim().is_empty()
        && !window.trim().is_empty()
        && element.trim().eq_ignore_ascii_case(window.trim());
    let has_depth = prompt_chars >= MIN_CONTEXT_CHARS && prompt_lines >= MIN_CONTEXT_LINES;
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
        "minContextLines": MIN_CONTEXT_LINES,
        "minContextChars": MIN_CONTEXT_CHARS,
        "focusedFieldLooksComposer": focused_field_looks_composer,
        "focusMissLike": focus_miss_like,
        "warnings": quality_warnings(
            prompt_json_valid,
            prompt_empty,
            has_depth,
            focused_field_looks_composer,
            focus_miss_like,
            otp_noise_word_count,
            login_or_skeleton_noise,
        ),
    })
}

fn looks_like_composer_field(element: &str) -> bool {
    static_regex(
        r"(?i)\b(?:message|reply|comment|compose|write|type a message|send a chat|ask|prompt|post|tweet|body)\b",
    )
    .is_match(element)
}

#[expect(
    clippy::too_many_arguments,
    reason = "quality warning classifier intentionally keeps the smoke-test fields flat"
)]
fn quality_warnings(
    prompt_json_valid: bool,
    prompt_empty: bool,
    has_depth: bool,
    focused_field_looks_composer: bool,
    focus_miss_like: bool,
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

    fn prompt_context_text(prompt_json: &Result<Value, serde_json::Error>) -> String {
        prompt_json
            .as_ref()
            .ok()
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .values()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    }

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
    fn line_count_ignores_blank_lines() {
        let text = "Alice: first\n\nnot a turn\n   \nYou: second";
        assert_eq!(line_count(Some(text)), 3);
    }

    #[test]
    fn report_flags_usable_composer_field_with_depth() {
        let raw = json!({
            "windowTitle": "Rollout thread - Gmail",
            "elementName": "Message Body",
            "focusedText": "",
            "textBefore": "Hi team, following up on the rollout blockers, owners, dates, and next steps for tonight's release. Please confirm the signing step is complete before we ship.",
            "textAfter": "",
            "appExe": "chrome.exe",
            "url": "https://mail.google.com/mail/u/0/#inbox/thread-long"
        })
        .to_string();

        let report = report_for_raw(&raw, "capture");
        assert_eq!(report["promptJsonValid"], true);
        assert_eq!(report["quality"]["contextPayloadUsable"], true);
        assert_eq!(report["quality"]["replyContextReady"], true);
        assert!(
            report["promptKeys"]
                .as_array()
                .unwrap()
                .contains(&Value::String("beforeCaret".to_string()))
        );
    }

    // The formatter applies an UNCONDITIONAL final secret-code scrub, so an OTP /
    // verification code is removed from the prompt BEFORE it ever reaches this
    // report. This proves the guarantee: the code and its announcing phrase are
    // gone regardless of surface.
    #[test]
    fn smoke_scrubs_otp_code_before_it_reaches_the_prompt() {
        let raw = json!({
            "windowTitle": "Security notice - Gmail",
            "elementName": "Message Body",
            "focusedText": "",
            "textBefore": "Security Team: Your verification code is 123456.\nThis one-time code expires in ten minutes.\nDo not share it.\nThanks,\nSecurity Team",
            "appExe": "chrome.exe",
            "url": "https://mail.google.com/mail/u/0/#inbox/security"
        })
        .to_string();

        let snapshot = parse_snapshot(&raw);
        let prompt = format_context_for_prompt(&snapshot);
        let prompt_json: Result<Value, _> = serde_json::from_str(&prompt);
        let context_text = prompt_context_text(&prompt_json);

        assert!(prompt_json.is_ok());
        assert!(
            !context_text.contains("123456"),
            "OTP code leaked: {context_text}"
        );
        assert!(
            !context_text.to_lowercase().contains("verification code"),
            "OTP phrase leaked: {context_text}"
        );
        assert!(
            !context_text.to_lowercase().contains("one-time code"),
            "OTP phrase leaked: {context_text}"
        );
        // The benign tail of the message survives.
        assert!(context_text.contains("Do not share it"), "{context_text}");

        // And the downstream report now sees NO otp noise (it was scrubbed).
        let report = report_for_raw(&raw, "capture");
        assert_eq!(report["promptJsonValid"], true);
        assert_eq!(report["privacySignals"]["otpNoiseWordCount"], 0);
        assert_eq!(report["privacySignals"]["sixDigitCodeLikeCount"], 0);
    }

    #[test]
    fn quality_flags_reply_depth_and_composer_focus() {
        let quality = build_quality("Message #release", "Discord", true, false, 500, 8, 0, false);
        assert_eq!(quality["replyContextReady"], true);
        assert_eq!(quality["focusedFieldLooksComposer"], true);
        assert!(quality["warnings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn quality_warns_on_non_composer_focus() {
        let quality = build_quality(
            "Home / X",
            "Home / X - Google Chrome",
            true,
            false,
            500,
            8,
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
    }

    #[test]
    fn smoke_rejects_login_or_skeleton_pages_as_usable_payload() {
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

        let report = report_for_raw(&raw, "capture");
        assert_eq!(report["promptJsonValid"], true);
        assert_eq!(report["privacySignals"]["loginOrSkeletonNoise"], true);
        assert_eq!(report["quality"]["contextPayloadUsable"], false);
        assert!(
            report["quality"]["warnings"]
                .as_array()
                .unwrap()
                .contains(&Value::String(
                    "login_or_skeleton_page_detected".to_string()
                ))
        );
    }
}
