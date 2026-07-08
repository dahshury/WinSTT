use super::super::{WindowContextSnapshot, format_context_for_prompt};
use super::*;

fn snap() -> WindowContextSnapshot {
    WindowContextSnapshot::default()
}

fn generic_json(snapshot: &WindowContextSnapshot) -> serde_json::Value {
    let out = format_context_for_prompt(snapshot);
    serde_json::from_str(&out)
        .unwrap_or_else(|e| panic!("generic output not JSON: {e}; out: {out}"))
}

// ── role pruning ──

#[test]
fn generic_screen_drops_subtrees_by_role_only() {
    let s = WindowContextSnapshot {
        window_title: "Some App".into(),
        element_name: "Message".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(
            r#"
            <pane name="App">
              <toolbar name="Top toolbar"><button name="Send"/><link name="Home"/></toolbar>
              <menubar name="Main menu"><menu name="File"><menuitem name="Open"/></menu></menubar>
              <tabs name="Channel tabs"><tab name="general"/></tabs>
              <status name="Online 42"/>
              <image name="Avatar image"/>
              <scrollbar name="Vertical scrollbar"/>
              <progressbar name="Upload progress"/>
              <doc name="Conversation">
                <group name="Message body"><text>The signing step still needs a guard before release.</text></group>
              </doc>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let ctx = generic_json(&s);
    let screen = ctx["screen"].as_str().unwrap_or("");
    // Kept: landmark/content text.
    assert!(
        screen.contains("The signing step still needs a guard"),
        "content dropped: {screen}"
    );
    // Dropped-by-role subtree contents must be gone.
    for chrome in [
        "Top toolbar",
        "Send",
        "Home",
        "Main menu",
        "File",
        "Open",
        "Channel tabs",
        "general",
        "Online 42",
        "Avatar image",
        "Vertical scrollbar",
        "Upload progress",
    ] {
        assert!(
            !screen.contains(chrome),
            "chrome {chrome:?} leaked: {screen}"
        );
    }
}

#[test]
fn generic_drop_role_set_matches_r2_spec() {
    for role in [
        "toolbar",
        "tabs",
        "tab",
        "menu",
        "menubar",
        "menuitem",
        "button",
        "link",
        "status",
        "image",
        "scrollbar",
        "progressbar",
    ] {
        assert!(generic_drop_subtree_role(role), "{role} should be dropped");
    }
    for role in [
        "doc", "pane", "group", "article", "text", "item", "list", "row",
    ] {
        assert!(
            !generic_drop_subtree_role(role),
            "{role} should NOT be dropped"
        );
    }
    // Landmark roles are the kept containers.
    for role in ["doc", "pane", "group", "article"] {
        assert!(generic_landmark_role(role), "{role} is a landmark");
    }
}

// ── deduplication ──

#[test]
fn generic_screen_deduplicates_exact_and_near_dup_lines() {
    let s = WindowContextSnapshot {
        window_title: "App".into(),
        ax_html: Some(
            r#"
            <doc name="Conversation">
              <group name="m"><text>Please confirm the release checklist.</text></group>
              <group name="m"><text>Please confirm the release checklist.</text></group>
              <group name="m"><text>please confirm the release checklist!!!</text></group>
              <group name="m"><text>A totally different line stays here.</text></group>
            </doc>
            "#
            .into(),
        ),
        ..snap()
    };
    let ctx = generic_json(&s);
    let screen = ctx["screen"].as_str().unwrap_or("");
    // Exact + near-dup (punctuation/case-only) collapse to ONE occurrence.
    let occurrences = screen.matches("confirm the release checklist").count();
    assert_eq!(occurrences, 1, "dedup failed ({occurrences}x): {screen}");
    assert!(
        screen.contains("A totally different line stays here."),
        "distinct line dropped: {screen}"
    );
}

#[test]
fn generic_dedup_key_normalizes_punctuation_and_case() {
    assert_eq!(
        generic_dedup_key("Hello, World!"),
        generic_dedup_key("hello world")
    );
    assert_ne!(generic_dedup_key("alpha"), generic_dedup_key("beta"));
}

// ── caps ──

#[test]
fn generic_screen_caps_at_12k_chars() {
    // One giant text node well over the 12k ceiling.
    let big = "release ".repeat(4000); // ~32k chars
    let s = WindowContextSnapshot {
        window_title: "App".into(),
        ax_html: Some(format!(
            r#"<doc name="Conversation"><text>{big}</text></doc>"#
        )),
        ..snap()
    };
    let ctx = generic_json(&s);
    let screen = ctx["screen"].as_str().unwrap_or("");
    assert!(
        screen.chars().count() <= JSON_MAX_LLM_CONTEXT_CHARS,
        "screen not capped: {} chars",
        screen.chars().count()
    );
    assert!(screen.chars().count() > 0);
}

#[test]
fn generic_caret_and_selection_respect_existing_caps() {
    let long_before = "a".repeat(JSON_CARET_BEFORE_LLM_MAX + 5000);
    let long_after = "b".repeat(CARET_AFTER_LLM_MAX + 5000);
    let long_sel = "c".repeat(SELECTED_TEXT_LLM_MAX + 5000);
    let long_clip = "d".repeat(CLIPBOARD_LLM_MAX + 5000);
    let s = WindowContextSnapshot {
        window_title: "App".into(),
        text_before: Some(long_before),
        text_after: Some(long_after),
        selected_text: Some(long_sel),
        clipboard_text: Some(long_clip),
        ..snap()
    };
    let ctx = generic_json(&s);
    assert_eq!(
        ctx["beforeCaret"].as_str().unwrap().chars().count(),
        JSON_CARET_BEFORE_LLM_MAX
    );
    assert_eq!(
        ctx["afterCaret"].as_str().unwrap().chars().count(),
        CARET_AFTER_LLM_MAX
    );
    assert_eq!(
        ctx["selection"].as_str().unwrap().chars().count(),
        SELECTED_TEXT_LLM_MAX
    );
    assert_eq!(
        ctx["clipboard"].as_str().unwrap().chars().count(),
        CLIPBOARD_LLM_MAX
    );
}

// ── note presence ──

#[test]
fn generic_note_present_when_screen_present_and_absent_otherwise() {
    // Screen present → note present, and it is the honest R2 caveat.
    let with_screen = WindowContextSnapshot {
        window_title: "App".into(),
        ax_html: Some(
            r#"<doc name="Conversation"><text>Some captured screen content that is long enough.</text></doc>"#
                .into(),
        ),
        ..snap()
    };
    let ctx = generic_json(&with_screen);
    assert_eq!(ctx["note"].as_str().unwrap_or(""), GENERIC_SCREEN_NOTE);
    assert!(GENERIC_SCREEN_NOTE.contains("raw accessibility text"));
    assert!(GENERIC_SCREEN_NOTE.contains("prioritize selection and beforeCaret"));

    // No tree → no screen → no note.
    let no_screen = WindowContextSnapshot {
        window_title: "App".into(),
        text_before: Some("just a short typed draft here".into()),
        ..snap()
    };
    let ctx2 = generic_json(&no_screen);
    assert!(ctx2.get("screen").is_none(), "unexpected screen: {ctx2}");
    assert!(ctx2.get("note").is_none(), "note without screen: {ctx2}");
}

// ── zero app-specific logic ──

#[test]
fn generic_does_not_reconstruct_conversation_turns() {
    // The X-reply blob: the LEGACY path rebuilds `Author: tweet` turns. The
    // GENERIC path must NOT — it flattens raw text with no attribution.
    let s = super::super::fixtures::all_fixtures()
        .into_iter()
        .find(|f| f.name == "x_reply_blob")
        .unwrap()
        .snapshot;
    let ctx = generic_json(&s);
    let screen = ctx["screen"].as_str().unwrap_or("");
    // Raw handle text survives verbatim (no reconstruction into `Name: body`).
    assert!(screen.contains("@iamtrask"), "raw handle missing: {screen}");
    // No fabricated speaker-turn line the legacy path would have produced.
    assert!(
        !screen.contains("Andrew Trask: This is a way bigger deal"),
        "generic path reconstructed a turn: {screen}"
    );
}

#[test]
fn generic_keeps_metadata_and_ide_bool() {
    let s = WindowContextSnapshot {
        window_title: "main.rs - Cursor".into(),
        element_name: "editor".into(),
        app_exe: Some("Cursor.exe".into()),
        url: Some("https://example.com/x".into()),
        text_before: Some("fn main() { let x = ".into()),
        ..snap()
    };
    let ctx = generic_json(&s);
    assert_eq!(ctx["app"], "Cursor.exe");
    assert_eq!(ctx["ide"], true);
    assert_eq!(ctx["url"], "https://example.com/x");
    assert!(ctx["window"].as_str().unwrap().contains("Cursor"));
    assert_eq!(ctx["field"], "editor");
}

#[test]
fn generic_otp_scrub_still_applies() {
    let s = WindowContextSnapshot {
        window_title: "App".into(),
        text_before: Some("Your verification code is 483920 do not share it".into()),
        ..snap()
    };
    let ctx = generic_json(&s);
    let before = ctx
        .get("beforeCaret")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert!(
        !before.contains("483920"),
        "OTP leaked on generic path: {ctx}"
    );
}

#[test]
fn generic_empty_snapshot_is_empty_string() {
    let out = format_context_for_prompt(&snap());
    assert_eq!(out, "");
}
