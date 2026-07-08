use super::*;

fn snap() -> WindowContextSnapshot {
    WindowContextSnapshot::default()
}

fn context_json(out: &str) -> serde_json::Value {
    match serde_json::from_str(out) {
        Ok(value) => value,
        Err(err) => panic!("context output should parse as JSON: {err}; output: {out}"),
    }
}

// ── JSON parsing ──

#[test]
fn parse_attaches_only_nonempty_optionals() {
    let raw = r#"{"windowTitle":"Gmail","elementName":"Body","focusedText":"hi","textBefore":"","appExe":"chrome.exe","url":"https://mail.google.com"}"#;
    let s = parse_snapshot(raw);
    assert_eq!(s.window_title, "Gmail");
    assert_eq!(s.focused_text, "hi");
    // empty textBefore is NOT attached
    assert!(s.text_before.is_none());
    assert_eq!(s.app_exe.as_deref(), Some("chrome.exe"));
    assert_eq!(s.url.as_deref(), Some("https://mail.google.com"));
}

#[test]
fn parse_bad_json_yields_empty() {
    assert_eq!(parse_snapshot("not json"), empty_context());
    assert_eq!(parse_snapshot(""), empty_context());
}

#[test]
fn parse_partial_sidecar_json_yields_empty_prompt() {
    let raw =
        r#"{"windowTitle":"Huge Chrome page","elementName":"Document","focusedText":"partial"#;
    let s = parse_snapshot(raw);
    assert_eq!(s, empty_context());
    assert_eq!(format_context_for_prompt(&s), "");
}

// ── deny-list ──

#[test]
fn deny_exe_exact_match() {
    let s = WindowContextSnapshot {
        app_exe: Some("1Password.exe".into()),
        ..snap()
    };
    assert!(is_denied_by_list(&s, &["1password.exe".into()]));
    assert!(!is_denied_by_list(&s, &["chrome.exe".into()]));
}

#[test]
fn deny_host_covers_subdomains() {
    let s = WindowContextSnapshot {
        url: Some("https://secure.bankofamerica.com/login".into()),
        ..snap()
    };
    assert!(is_denied_by_list(&s, &["bankofamerica.com".into()]));
    // wildcard form normalized
    assert!(is_denied_by_list(&s, &["*.bankofamerica.com".into()]));
    assert!(!is_denied_by_list(&s, &["chase.com".into()]));
}

#[test]
fn deny_empty_list_and_blank_patterns_no_op() {
    let s = WindowContextSnapshot {
        app_exe: Some("chrome.exe".into()),
        ..snap()
    };
    assert!(!is_denied_by_list(&s, &[]));
    assert!(!is_denied_by_list(&s, &["   ".into()]));
}

#[test]
fn allow_list_reuses_exe_and_host_patterns() {
    let browser = WindowContextSnapshot {
        app_exe: Some("Chrome.exe".into()),
        url: Some("https://docs.google.com/document/d/123".into()),
        ..snap()
    };
    assert!(is_allowed_by_list(&browser, &["chrome.exe".into()]));
    assert!(is_allowed_by_list(&browser, &["google.com".into()]));
    assert!(is_allowed_by_list(&browser, &["*.docs.google.com".into()]));
    assert!(!is_allowed_by_list(&browser, &["notepad.exe".into()]));
    assert!(!is_allowed_by_list(&browser, &[]));
}

#[test]
fn redact_keeps_only_metadata_triple() {
    let s = WindowContextSnapshot {
        window_title: "Bank".into(),
        element_name: "Password".into(),
        focused_text: "hunter2".into(),
        url: Some("https://bank.com".into()),
        ax_html: Some("<tree/>".into()),
        ..snap()
    };
    let r = redact_sensitive_fields(&s);
    assert_eq!(r.window_title, "Bank");
    assert_eq!(r.element_name, "Password");
    assert_eq!(r.focused_text, "");
    assert!(r.url.is_none());
    assert!(r.ax_html.is_none());
}

#[test]
fn apply_deny_list_redacts_denied() {
    let s = WindowContextSnapshot {
        window_title: "x".into(),
        focused_text: "secret".into(),
        app_exe: Some("1password.exe".into()),
        ..snap()
    };
    let out = apply_deny_list(&s, &["1password.exe".into()]);
    assert_eq!(out.focused_text, "");
    // not denied → unchanged
    let out2 = apply_deny_list(&s, &["chrome.exe".into()]);
    assert_eq!(out2.focused_text, "secret");
}

#[test]
fn selected_only_policy_redacts_unlisted_app() {
    let s = WindowContextSnapshot {
        window_title: "Notes".into(),
        focused_text: "private draft".into(),
        app_exe: Some("notepad.exe".into()),
        ..snap()
    };
    let out = apply_context_app_policy(
        &s,
        ContextAppMode::SelectedOnly,
        &["notepad.exe".into()],
        &["chrome.exe".into()],
    );
    assert_eq!(out.window_title, "Notes");
    assert_eq!(out.focused_text, "");

    let allowed = apply_context_app_policy(
        &s,
        ContextAppMode::SelectedOnly,
        &[],
        &["notepad.exe".into()],
    );
    assert_eq!(allowed.focused_text, "private draft");
}

#[test]
fn selected_only_with_empty_allow_list_captures_nothing() {
    // No apps chosen in Allow-list mode ⇒ context awareness is off: not even the
    // window title (which redaction otherwise keeps) should survive.
    let s = WindowContextSnapshot {
        window_title: "Notes".into(),
        element_name: "Body".into(),
        focused_text: "private draft".into(),
        app_exe: Some("notepad.exe".into()),
        ..snap()
    };
    let out = apply_context_app_policy(&s, ContextAppMode::SelectedOnly, &[], &[]);
    assert_eq!(out.window_title, "");
    assert_eq!(out.element_name, "");
    assert_eq!(out.focused_text, "");
    assert!(format_context_for_prompt(&out).is_empty());
}

// ── host extraction ──

#[test]
fn host_extraction_handles_missing_scheme() {
    assert_eq!(extract_host("github.com/foo"), "github.com");
    assert_eq!(extract_host("https://github.com/foo?x=1#y"), "github.com");
    assert_eq!(extract_host(""), "");
}

// ── IDE / terminal / canvas ──

#[test]
fn ide_detection() {
    let code = WindowContextSnapshot {
        app_exe: Some("Code.exe".into()),
        ..snap()
    };
    assert!(is_ide_context(&code));
    let idea = WindowContextSnapshot {
        app_exe: Some("idea64.exe".into()),
        ..snap()
    };
    assert!(is_ide_context(&idea));
    let chrome = WindowContextSnapshot {
        app_exe: Some("chrome.exe".into()),
        ..snap()
    };
    assert!(!is_ide_context(&chrome));
}

#[test]
fn terminal_detection_word_boundary() {
    let term = WindowContextSnapshot {
        element_name: "Terminal 45, bash".into(),
        ..snap()
    };
    assert!(looks_like_terminal(&term));
    // "terminate" must NOT match (word boundary)
    let not_term = WindowContextSnapshot {
        element_name: "terminate process".into(),
        ..snap()
    };
    assert!(!looks_like_terminal(&not_term));
}

#[test]
fn canvas_detection() {
    assert!(is_canvas_surface(Some("figma.exe"), None));
    assert!(is_canvas_surface(
        None,
        Some("https://www.figma.com/file/x")
    ));
    assert!(!is_canvas_surface(
        Some("notepad.exe"),
        Some("https://example.com")
    ));
}

// ── IDE profile (per-IDE feature matrix) ──

#[test]
fn ide_kind_classification() {
    assert_eq!(ide_kind_from_exe(Some("Cursor.exe")), Some(IdeKind::Cursor));
    assert_eq!(
        ide_kind_from_exe(Some("windsurf.exe")),
        Some(IdeKind::Windsurf)
    );
    assert_eq!(ide_kind_from_exe(Some("Code.exe")), Some(IdeKind::VsCode));
    assert_eq!(
        ide_kind_from_exe(Some("Code - Insiders.exe")),
        Some(IdeKind::VsCodeInsiders)
    );
    assert_eq!(
        ide_kind_from_exe(Some("idea64.exe")),
        Some(IdeKind::JetBrains)
    );
    assert_eq!(ide_kind_from_exe(Some("chrome.exe")), None);
    assert_eq!(ide_kind_from_exe(None), None);
}

// ── prompt formatter (generic path; app-agnostic) ──

#[test]
fn format_empty_snapshot_is_empty_string() {
    assert_eq!(format_context_for_prompt(&empty_context()), "");
}

#[test]
fn format_thin_field_includes_tree() {
    let s = WindowContextSnapshot {
        element_name: "Reply".into(),
        focused_text: "".into(),
        ax_html: Some("<doc>original email body that is long enough</doc>".into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert!(
        ctx["screen"]
            .as_str()
            .unwrap()
            .contains("original email body")
    );
}

#[test]
fn format_includes_metadata_and_selection() {
    let s = WindowContextSnapshot {
        window_title: "Gmail".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://mail.google.com".into()),
        selected_text: Some("reply to this".into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert_eq!(ctx["app"], "chrome.exe");
    assert_eq!(ctx["url"], "https://mail.google.com");
    assert_eq!(ctx["window"], "Gmail");
    assert_eq!(ctx["selection"], "reply to this");
}

#[test]
fn format_ide_marker() {
    let s = WindowContextSnapshot {
        app_exe: Some("code.exe".into()),
        ax_html: Some("<edit>useState</edit>".into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert_eq!(ctx["ide"], true);
}

#[test]
fn caret_before_keeps_tail_after_keeps_head() {
    let before = format!("{}TAIL", "x".repeat(JSON_CARET_BEFORE_LLM_MAX));
    let after = format!("HEAD{}", "y".repeat(CARET_AFTER_LLM_MAX));
    let s = WindowContextSnapshot {
        element_name: "Body".into(),
        text_before: Some(before),
        text_after: Some(after),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert!(ctx["beforeCaret"].as_str().unwrap().contains("TAIL")); // before kept its tail
    assert!(ctx["afterCaret"].as_str().unwrap().contains("HEAD")); // after kept its head
}

#[test]
fn rtl_and_cjk_context_survives_denoise() {
    let s = WindowContextSnapshot {
        window_title: "Messenger".into(),
        element_name: "Message".into(),
        focused_text: "مرحبا يا علي\n你好，明天见\n\u{fffc}\u{2726}".into(),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let field = ctx["fieldText"].as_str().unwrap();
    assert!(field.contains("مرحبا يا علي"));
    assert!(field.contains("你好，明天见"));
    assert!(!field.contains('\u{fffc}'));
}

// ── capture flow ──

struct FakeReader(WindowContextSnapshot);
impl ContextReader for FakeReader {
    fn read(&self, _mode: ContextMode) -> WindowContextSnapshot {
        self.0.clone()
    }
}

#[test]
fn capture_redacts_denied_app() {
    let reader = FakeReader(WindowContextSnapshot {
        window_title: "Vault".into(),
        focused_text: "master password".into(),
        app_exe: Some("1password.exe".into()),
        ..snap()
    });
    let out = capture_prompt_fragment(
        &reader,
        ContextMode::Tree,
        ContextAppMode::AllExceptDenied,
        &["1password.exe".into()],
        &[],
    );
    assert!(!out.contains("master password"));
    let ctx = context_json(&out);
    assert_eq!(ctx["window"], "Vault");
}

#[test]
fn mode_flags() {
    assert_eq!(ContextMode::Focused.flag(), None);
    assert_eq!(ContextMode::Selection.flag(), Some("--selection"));
    assert_eq!(ContextMode::Split.flag(), Some("--split"));
    assert_eq!(ContextMode::Tree.flag(), Some("--tree"));
}

// ───── focused-field (--split) dictation capture — competitor parity ─────
//
// The dictation pipeline captures with `ContextMode::Split`: the focused
// field's caret-aware text + app identity, and NO `axHtml` (no whole-window
// tree walk). The fragment must stay a clean focused-field shape — never a
// `screen` tree dump that leaks sidebars / inbox rows.

#[test]
fn split_dictation_capture_is_clean_focused_field() {
    // A Gmail reply: the draft sits in beforeCaret, the quoted thread in
    // afterCaret (so "reply to this" context survives within the field),
    // app identity comes from app/url/window — and there is NO tree `screen`.
    let reader = FakeReader(WindowContextSnapshot {
        window_title: "Inbox (3) - me@example.com - Gmail".into(),
        element_name: "Message Body".into(),
        text_before: Some("Hi Dana, thanks for the update. ".into()),
        text_after: Some("On Mon, Jun 15, Dana Lee wrote: see the attached draft.".into()),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://mail.google.com/mail/u/0/".into()),
        ..snap()
    });
    let out = capture_prompt_fragment(
        &reader,
        ContextMode::Split,
        ContextAppMode::AllExceptDenied,
        &[],
        &[],
    );
    let ctx = context_json(&out);
    assert_eq!(ctx["app"], "chrome.exe");
    assert_eq!(ctx["url"], "https://mail.google.com/mail/u/0/");
    assert!(ctx["window"].as_str().unwrap_or("").contains("Gmail"));
    assert!(
        ctx["beforeCaret"]
            .as_str()
            .unwrap_or("")
            .contains("thanks for the update")
    );
    assert!(
        ctx["afterCaret"]
            .as_str()
            .unwrap_or("")
            .contains("Dana Lee wrote")
    );
    // The focused-field path (no axHtml) must NOT emit a tree `screen`.
    assert!(
        ctx.get("screen").is_none(),
        "focused-field capture must not emit a tree `screen`: {out}"
    );
}

#[test]
fn split_dictation_capture_url_deny_list_still_redacts() {
    // The host-based privacy deny-list must keep working on the focused-field
    // (--split) path now that --split carries the url. A banking host →
    // redacted to bare metadata, field text dropped.
    let reader = FakeReader(WindowContextSnapshot {
        window_title: "Transfer funds".into(),
        element_name: "Amount".into(),
        text_before: Some("move 5000 to savings".into()),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://secure.bankofamerica.com/transfer".into()),
        ..snap()
    });
    let out = capture_prompt_fragment(
        &reader,
        ContextMode::Split,
        ContextAppMode::AllExceptDenied,
        &["bankofamerica.com".into()],
        &[],
    );
    assert!(
        !out.contains("move 5000 to savings"),
        "denied-host field text leaked: {out}"
    );
    let ctx = context_json(&out);
    assert_eq!(ctx["window"], "Transfer funds");
}

// ───────── OTP / secret-code scrubbing (privacy-critical) ─────────

/// A normal conversation full of INCIDENTAL numbers (prices, years, counts,
/// phone-ish ids, order numbers) that are NOT next to any OTP/verification
/// keyword must pass through completely untouched.
#[test]
fn normal_conversation_numbers_are_not_over_redacted() {
    let thread = [
        "Alice: The Q3 budget came in at $42,500, up from 38900 last year.",
        "Bob: We shipped 1284 units in 2025 and expect 2026 to double that.",
        "Alice: Call me at 5551234 when the 405 invoice clears.",
        "Bob: Order 4051234567 was delivered; the room is 1408 on floor 12.",
    ]
    .join("\n");
    let scrubbed = json_scrub_secret_codes(&thread);
    // Identical: no OTP keyword anywhere → byte-for-byte unchanged.
    assert_eq!(scrubbed, thread);
    for n in [
        "42,500",
        "38900",
        "1284",
        "2025",
        "2026",
        "5551234",
        "405",
        "4051234567",
        "1408",
        "12",
    ] {
        assert!(
            scrubbed.contains(n),
            "number {n} was over-redacted: {scrubbed}"
        );
    }
}

/// The scrub drops whole secret-code sentences AND redacts keyword-adjacent
/// bare codes in the canonical leak shapes, while leaving a non-code number in
/// the SAME blob (a year) intact.
#[test]
fn scrub_drops_code_phrases_and_redacts_adjacent_codes() {
    // Each of these whole sentences carries a secret-code phrase → dropped.
    for leak in [
        "Your account verification OTP is: 17042",
        "your code is 482913",
        "Google: Your verification code is 622297",
        "Qiwa: One time password 7596",
        "Use single-use passcode 99213 to continue.",
        "Your 2FA code is 1029 — do not share it.",
        "G-123456 is your Google verification code.",
        "amazon.eg: Sign-in",
    ] {
        let scrubbed = json_scrub_secret_codes(leak);
        assert!(
            scrubbed.trim().is_empty()
                || !scrubbed.chars().any(|c| c.is_ascii_digit())
                || !JSON_SECRET_CODE_PHRASE_RE.is_match(&scrubbed),
            "secret-code phrase survived: {leak:?} -> {scrubbed:?}"
        );
    }
    // The specific codes must be gone.
    assert!(!json_scrub_secret_codes("Your account verification OTP is: 17042").contains("17042"));
    assert!(!json_scrub_secret_codes("your verification code is 622297").contains("622297"));
    assert!(
        !json_scrub_secret_codes("G-123456 is your Google verification code.").contains("123456")
    );

    // The code-bearing sentence is dropped, but an incidental number in a
    // SEPARATE sentence of the same blob is preserved.
    let mixed = "The OTP is 884412. The budget for 2026 is due Friday.";
    let scrubbed = json_scrub_secret_codes(mixed);
    assert!(!scrubbed.contains("884412"), "code survived: {scrubbed}");
    assert!(
        scrubbed.contains("2026"),
        "year in a separate sentence lost: {scrubbed}"
    );
    assert!(
        scrubbed.contains("budget"),
        "separate sentence lost: {scrubbed}"
    );

    // Stage-2 catch: a bare code keyword-adjacent to a digit run inside a
    // sentence whose full phrase does NOT match (so the sentence is kept) is
    // still redacted in place.
    let residue = json_scrub_secret_codes("Reference pin: 4821 for the meeting room.");
    assert!(!residue.contains("4821"), "pin code survived: {residue}");
    assert!(residue.contains("meeting room"), "context lost: {residue}");
}

/// Multi-line blob: only the secret-code line is dropped; the surrounding
/// conversation lines (and their incidental numbers) are preserved verbatim.
#[test]
fn scrub_is_line_local_and_preserves_surrounding_context() {
    let blob = "Maya: standup at 9:30 tomorrow, room 1408.\n\
        Bank: Your one-time code is 553201.\n\
        Maya: also the 2026 budget is due Friday.";
    let scrubbed = json_scrub_secret_codes(blob);
    assert!(scrubbed.contains("standup at 9:30 tomorrow, room 1408"));
    assert!(scrubbed.contains("2026 budget is due Friday"));
    assert!(!scrubbed.contains("553201"), "OTP code leaked: {scrubbed}");
    assert!(
        !scrubbed.to_lowercase().contains("one-time code"),
        "OTP phrase leaked: {scrubbed}"
    );
}
