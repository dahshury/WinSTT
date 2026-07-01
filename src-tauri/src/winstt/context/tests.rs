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

fn screen_text(snapshot: WindowContextSnapshot) -> String {
    let out = format_context_for_prompt(&snapshot);
    let ctx = context_json(&out);
    ctx["screen"].as_str().unwrap_or("").to_string()
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

// ── prompt formatter ──

#[test]
fn format_empty_snapshot_is_empty_string() {
    assert_eq!(format_context_for_prompt(&empty_context()), "");
}

#[test]
fn format_terminal_omits_scrollback() {
    let s = WindowContextSnapshot {
        element_name: "Terminal 1, pwsh".into(),
        text_before: Some("a".repeat(500)),
        ax_html: Some("<tree>lots of soup</tree>".into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert!(ctx["note"]
        .as_str()
        .unwrap()
        .contains("Terminal/console focused"));
    assert!(ctx.get("beforeCaret").is_none());
    assert!(ctx.get("screen").is_none());
    assert!(!out.contains("soup"));
}

#[test]
fn format_rich_field_drops_tree() {
    let s = WindowContextSnapshot {
        element_name: "Message body".into(),
        text_before: Some("Dear team, ".repeat(10)), // > 40 chars
        ax_html: Some("<tree>chrome</tree>".into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert!(ctx["beforeCaret"].as_str().unwrap().contains("Dear team"));
    // tree dropped when focused field is rich
    assert!(ctx.get("screen").is_none());
    assert!(!out.contains("chrome"));
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
    assert!(ctx["screen"]
        .as_str()
        .unwrap()
        .contains("original email body"));
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
fn long_gmail_reply_keeps_large_tail_as_valid_json() {
    let older = format!("{}older body that should be clipped\n", "x".repeat(12_000));
    let recent = "Alice: Can you confirm the Supernova v2 rollout timing?\nYou: ".repeat(520);
    let s = WindowContextSnapshot {
        window_title: "Supernova rollout - Gmail".into(),
        element_name: "Message Body".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://mail.google.com/mail/u/0/#inbox/thread-a".into()),
        text_before: Some(format!("{older}{recent}RECENT_TAIL")),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let before = ctx["beforeCaret"].as_str().unwrap();
    assert!(before.contains("RECENT_TAIL"));
    assert!(before.contains("Supernova v2"));
    assert!(before.chars().count() <= JSON_CARET_BEFORE_LLM_MAX);
    assert!(!before.starts_with('x'));
}

#[test]
fn gmail_list_scrollback_is_removed_from_reply_context() {
    let s = WindowContextSnapshot {
        window_title: "Project Orion - Gmail".into(),
        element_name: "Message Body".into(),
        text_before: Some(
            [
                "Inbox",
                "Jane Sender",
                "Your login code is 123456",
                "Jun 2",
                "Dev Team",
                "Project Orion launch",
                "Jun 5",
                "Alice: We can ship if QA signs off.",
                "Bob: QA is green on Windows.",
                "You: ",
            ]
            .join("\n"),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let before = ctx["beforeCaret"].as_str().unwrap();
    assert!(before.contains("Alice: We can ship"));
    assert!(before.contains("Bob: QA is green"));
    assert!(!before.contains("123456"));
    assert!(!before.contains("Your login code"));
}

#[test]
fn gmail_long_rendered_thread_keeps_big_context_chunk() {
    let mut messages = String::new();
    for i in 1..=12 {
        messages.push_str(&format!(
            r#"<item name="Sender {i}: Page-spanning Gmail message {i} about rollout blockers and next steps."/>"#
        ));
    }
    let s = WindowContextSnapshot {
        window_title: "Rollout thread - Gmail".into(),
        element_name: "Message Body".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://mail.google.com/mail/u/0/#inbox/thread-long".into()),
        ax_html: Some(format!(
            r#"
            <pane name="Gmail">
              <list name="Inbox"><item name="Unrelated login code 654321"/></list>
              <doc name="Rollout thread">
                <list name="Messages">{messages}</list>
                <edit name="Message Body" focus="1"></edit>
              </doc>
            </pane>
            "#
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    let kept_messages = screen.matches("Page-spanning Gmail message").count();
    assert!(kept_messages >= 10);
    assert!(screen.contains("Sender 12"));
    assert!(!screen.contains("654321"));
    assert!(!screen.contains("Unrelated login code"));
}

#[test]
fn gmail_very_long_rendered_thread_keeps_recent_tail_near_reply() {
    let mut messages = String::new();
    let detail = " deployment-note".repeat(8);
    for i in 1..=100 {
        messages.push_str(&format!(
            r#"<item name="Sender {i}: Multi-page Gmail message {i} includes decisions, owners, blockers, dates, and the current ask for the reply.{detail}"/>"#
        ));
    }
    let s = WindowContextSnapshot {
        window_title: "Long rollout thread - Gmail".into(),
        element_name: "Message Body".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://mail.google.com/mail/u/0/#inbox/thread-very-long".into()),
        ax_html: Some(format!(
            r#"
            <pane name="Gmail">
              <doc name="Long rollout thread">
                <list name="Messages">{messages}</list>
                <edit name="Message Body" focus="1"></edit>
              </doc>
            </pane>
            "#
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    let kept_messages = screen.matches("Multi-page Gmail message").count();
    assert!(kept_messages >= 40, "{kept_messages}: {screen}");
    assert!(screen.contains("Sender 100"), "{screen}");
    assert!(screen.contains("Sender 90"), "{screen}");
    assert!(!screen.contains("Sender 1: Multi-page"), "{screen}");
    assert!(screen.chars().count() <= JSON_MAX_LLM_CONTEXT_CHARS);
}

#[test]
fn omnibox_focus_falls_back_to_page_content() {
    let s = WindowContextSnapshot {
        window_title: "Gmail - Google Chrome".into(),
        element_name: "Address and search bar".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://mail.google.com/mail/u/0/#inbox".into()),
        ax_html: Some(
            r#"
            <pane name="Chrome">
              <edit name="Address and search bar" focus="1">mail.google.com</edit>
              <doc name="Inbox">The newsletter content the user is reading and acting upon here.</doc>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("newsletter content"));
    assert!(!screen.contains("mail.google.com"));
}

#[test]
fn discord_thread_keeps_multi_sender_message_context() {
    let s = WindowContextSnapshot {
        window_title: "Discord | #release".into(),
        element_name: "Message #release".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://discord.com/channels/1/2".into()),
        ax_html: Some(
            r#"
            <pane name="Discord">
              <list name="Servers"><item name="General"/></list>
              <list name="Messages">
                <item name="علي: The Arabic sender should stay attributed."/>
                <item name="Maya: The Windows build still needs signing."/>
                <item name="Chris: I uploaded the cert bundle."/>
                <item name="You: I will kick off the release after tests."/>
                <edit name="Message #release" focus="1"></edit>
              </list>
              <list name="Members"><item name="Online 42"/></list>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("علي: The Arabic sender"));
    assert!(screen.contains("Maya: The Windows build"));
    assert!(screen.contains("Chris: I uploaded"));
    assert!(screen.contains("You: I will kick off"));
    assert!(!screen.contains("Online 42"));
}

#[test]
fn discord_split_author_nodes_reconstruct_speaker_turns() {
    let s = WindowContextSnapshot {
        window_title: "#general | My Server - Discord".into(),
        element_name: "Message #general".into(),
        app_exe: Some("discord.exe".into()),
        ax_html: Some(
            r##"
            <window name="#general | My Server - Discord">
              <group name="Channels"><tree name="Channels"><node name="general"># general</node></tree></group>
              <group name="Messages">
                <list name="Messages in general">
                  <item name="alice">
                    <text>alice</text>
                    <text>Today at 2:14 PM</text>
                    <text>can someone review the deploy script before we ship?</text>
                  </item>
                  <item name="bob">
                    <text>bob</text>
                    <text>Today at 2:16 PM</text>
                    <text>I looked at it earlier, the rollback step is missing a guard</text>
                  </item>
                </list>
                <group name="Message composer"><edit name="Message #general" focus="1"></edit></group>
              </group>
            </window>
            "##
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("alice: can someone review"));
    assert!(screen.contains("bob: I looked at it earlier"), "{screen}");
    assert!(!screen.contains("Today at 2:14 PM"));
}

#[test]
fn slack_split_author_nodes_reconstruct_speaker_turns() {
    let s = WindowContextSnapshot {
        window_title: "Slack | general (Channel) | Acme Workspace".into(),
        element_name: "Message to #general".into(),
        app_exe: Some("slack.exe".into()),
        ax_html: Some(
            r##"
            <window name="Slack | general (Channel) | Acme Workspace">
              <tree name="Channels"><node name="# random"/><node name="# eng-standup"/></tree>
              <pane name="general">
                <list name="Messages">
                  <item>
                    <text name="Dana Lee">Dana Lee</text>
                    <text>11:02 AM</text>
                    <text>Can someone send the Q3 numbers before the 2pm sync?</text>
                  </item>
                  <item>
                    <text name="Sam Ortiz">Sam Ortiz</text>
                    <text>11:05 AM</text>
                    <text>I have them, finalizing the deck now.</text>
                  </item>
                </list>
                <group name="Message input"><edit name="Message to #general" focus="1"></edit></group>
              </pane>
            </window>
            "##
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Dana Lee: Can someone send"));
    assert!(screen.contains("Sam Ortiz: I have them"));
    assert!(!screen.contains("# random"));
    assert!(!screen.contains("11:02 AM"));
}

#[test]
fn reference_fixture_matrix_keeps_more_app_context_shapes() {
    let teams = screen_text(WindowContextSnapshot {
        window_title: "Chat | Microsoft Teams".into(),
        element_name: "Type a message".into(),
        app_exe: Some("ms-teams.exe".into()),
        ax_html: Some(
            r#"
            <window name="Chat | Microsoft Teams">
              <toolbar name="App bar"><tab name="Activity"/><tab name="Chat"/></toolbar>
              <pane name="Chat list"><list name="Recent"><item name="Unrelated DM"/></list></pane>
              <pane name="Conversation">
                <list name="Messages">
                  <group name="Teammate, 9:14 AM"><text>Can you review the PR before standup? It touches the auth refactor.</text></group>
                  <group name="Teammate, 9:15 AM"><text>No rush if you're heads-down, just want it merged by EOD.</text></group>
                </list>
                <edit name="Type a message" focus="1"></edit>
              </pane>
            </window>
            "#
            .into(),
        ),
        ..snap()
    });
    assert!(teams.contains("Teammate: Can you review the PR"), "{teams}");
    assert!(teams.contains("Teammate: No rush"), "{teams}");
    assert!(!teams.contains("Unrelated DM"));

    let telegram = screen_text(WindowContextSnapshot {
        window_title: "Telegram".into(),
        element_name: "Write a message".into(),
        app_exe: Some("telegram.exe".into()),
        ax_html: Some(
            r#"
            <window name="Telegram">
              <pane name="Navigation"><list name="Chats"><item name="Saved Messages">You: meeting notes</item></list></pane>
              <pane name="Alex Rivera">
                <list name="Message list">
                  <item name="Alex Rivera"><text>Can you send over the Q3 deck before the 3pm sync?</text></item>
                  <item name="You"><text>yeah one sec</text></item>
                  <item name="Alex Rivera"><text>also did legal sign off on the pricing slide?</text></item>
                </list>
                <group name="Composer"><edit name="Write a message" focus="1"></edit></group>
              </pane>
            </window>
            "#
            .into(),
        ),
        ..snap()
    });
    assert!(telegram.contains("Alex Rivera: Can you send"), "{telegram}");
    assert!(telegram.contains("You: yeah one sec"), "{telegram}");
    assert!(!telegram.contains("Saved Messages"));

    let whatsapp = screen_text(WindowContextSnapshot {
        window_title: "WhatsApp".into(),
        element_name: "Type a message".into(),
        app_exe: Some("whatsapp.exe".into()),
        ax_html: Some(
            r#"
            <window name="WhatsApp">
              <pane name="Chat list"><list name="Chats"><item name="Mom. Did you eat? 8:15 AM"/></list></pane>
              <pane name="Conversation">
                <list name="Messages">
                  <group name="Sarah Chen">
                    <text>Hey, are we still on for the demo on Thursday?</text>
                    <text>I can move it to 2pm if that's easier for you.</text>
                  </group>
                  <group name="You"><text>Thursday works, let me confirm the room.</text></group>
                </list>
                <doc name="Type a message" focus="1"></doc>
              </pane>
            </window>
            "#
            .into(),
        ),
        ..snap()
    });
    assert!(whatsapp.contains("Sarah Chen: Hey"), "{whatsapp}");
    assert!(whatsapp.contains("Sarah Chen: I can move"), "{whatsapp}");
    assert!(whatsapp.contains("You: Thursday works"), "{whatsapp}");
    assert!(!whatsapp.contains("Mom. Did you eat"));

    let github = screen_text(WindowContextSnapshot {
        window_title: "Issue: Crash on startup - GitHub".into(),
        element_name: "Comment body".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://github.com/acme/widget/issues/482".into()),
        ax_html: Some(
            r##"
            <window name="Issue: Crash on startup - GitHub">
              <header name="Global"><link name="GitHub Home"/><edit name="Search or jump to"/></header>
              <pane name="content">
                <group name="issue header"><text>Crash on startup #482</text><text>Open</text></group>
                <list name="Timeline">
                  <item name="comment"><group name="alice commented"><doc name="comment body">The app crashes on launch with "missing model.onnx".</doc></group></item>
                  <item name="comment"><group name="bob commented"><doc name="comment body">Can you attach the log from APPDATA?</doc></group></item>
                </list>
                <group name="add a comment"><edit name="Comment body" focus="1"></edit></group>
              </pane>
              <list name="metadata"><item><text>Labels</text><link name="bug"/></item></list>
            </window>
            "##
            .into(),
        ),
        ..snap()
    });
    assert!(github.contains("alice: The app crashes"), "{github}");
    assert!(github.contains("bob: Can you attach"), "{github}");
    assert!(!github.contains("GitHub Home"));
    assert!(!github.contains("comment body"));

    let instagram = screen_text(WindowContextSnapshot {
        window_title: "Instagram - Google Chrome".into(),
        element_name: "Message".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://instagram.com/direct/inbox".into()),
        ax_html: Some(
            r#"
            <window name="Instagram - Google Chrome">
              <doc name="Instagram">
                <pane name="Navigation"><link name="Home"/><link name="Messages"/></pane>
                <list name="Conversations"><item name="mom - 3d">call me</item></list>
                <list name="Messages">
                  <item><text name="alex_m">hey are we still on for saturday?</text></item>
                  <item><text name="alex_m">lmk what time works</text></item>
                  <item><text name="You">yeah! thinking around 2</text></item>
                </list>
                <group name="Composer"><edit name="Message" focus="1"></edit></group>
              </doc>
            </window>
            "#
            .into(),
        ),
        ..snap()
    });
    assert!(
        instagram.contains("alex_m: hey are we still"),
        "{instagram}"
    );
    assert!(instagram.contains("You: yeah"), "{instagram}");
    assert!(!instagram.contains("mom - 3d"));

    let notion = screen_text(WindowContextSnapshot {
        window_title: "Q3 Planning - Notion".into(),
        element_name: "Empty paragraph".into(),
        app_exe: Some("notion.exe".into()),
        ax_html: Some(
            r#"
            <window name="Q3 Planning - Notion">
              <pane name="sidebar"><tree name="Workspace"><node name="Meeting Notes"/></tree></pane>
              <pane name="content">
                <doc name="page">
                  <header name="title"><text>Q3 Planning</text></header>
                  <group name="block"><text>We need to ship the new onboarding flow before the quarter ends.</text></group>
                  <group name="block"><text>Open questions about staffing remain.</text></group>
                  <edit name="Empty paragraph" focus="1"></edit>
                </doc>
              </pane>
            </window>
            "#
            .into(),
        ),
        ..snap()
    });
    assert!(notion.contains("Q3 Planning"), "{notion}");
    assert!(notion.contains("new onboarding flow"), "{notion}");
    assert!(notion.contains("Open questions"), "{notion}");
    assert!(!notion.contains("Meeting Notes"));
}

#[test]
fn same_display_name_chat_turns_keep_order_and_valid_json() {
    let s = WindowContextSnapshot {
        window_title: "Discord | #support".into(),
        element_name: "Message #support".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://discord.com/channels/1/3".into()),
        ax_html: Some(
            r#"
            <pane name="Discord">
              <list name="Messages">
                <item name="Alex: I can reproduce the crash on beta 4."/>
                <item name="Alex: Different Alex here - I only see it after login."/>
                <item name="You: Thanks, I will split the report by account."/>
                <edit name="Message #support" focus="1"></edit>
              </list>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    let first = screen.find("I can reproduce").unwrap();
    let second = screen.find("Different Alex").unwrap();
    assert!(first < second);
    assert!(screen.contains("You: Thanks"));
}

#[test]
fn mixed_unicode_and_ascii_chat_items_keep_all_turns() {
    let s = WindowContextSnapshot {
        window_title: "Discord | #general".into(),
        element_name: "Message #general".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://discord.com/channels/1/2".into()),
        ax_html: Some(
            r#"
            <pane name="Discord">
              <list name="Messages">
                <item name="Maya: I can reproduce the reply-context issue."/>
                <item name="علي: خلينا نثبت مشكلة السياق قبل الرد النهائي."/>
                <item name="You: I will keep the reply scoped to the rendered thread."/>
                <edit name="Message #general" focus="1"></edit>
              </list>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Maya: I can reproduce"));
    assert!(screen.contains("علي: خلينا"));
    assert!(screen.contains("You: I will keep"), "{screen}");
}

#[test]
fn chat_system_noise_is_dropped_without_dropping_thread_words() {
    let s = WindowContextSnapshot {
        window_title: "Discord | #release".into(),
        element_name: "Message #release".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://discord.com/channels/1/2".into()),
        ax_html: Some(
            r#"
            <pane name="Discord">
              <list name="Messages">
                <item name="Alex joined the channel"/>
                <item name="Maya reacted with thumbs up to Chris"/>
                <item name="Maya: The thread wording must stay in the real message."/>
                <item name="You: Inbox cleanup is the actual topic for the reply."/>
                <edit name="Message #release" focus="1"></edit>
              </list>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Maya: The thread wording"));
    assert!(screen.contains("You: Inbox cleanup"));
    assert!(!screen.contains("joined the channel"));
    assert!(!screen.contains("reacted with"));
}

#[test]
fn facebook_engagement_counts_are_dropped_from_feed_context() {
    let s = WindowContextSnapshot {
        window_title: "Facebook".into(),
        element_name: "Write a comment".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://www.facebook.com/".into()),
        ax_html: Some(
            r#"
            <pane name="Facebook">
              <article name="Post by Nina">
                <item name="Nina: The prototype demo is tomorrow."/>
                <item name="12 comments"/>
                <item name="34 likes"/>
                <item name="Share"/>
                <item name="Omar: I can review the deck tonight."/>
                <edit name="Write a comment" focus="1"></edit>
              </article>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Nina: The prototype"));
    assert!(screen.contains("Omar: I can review"));
    assert!(!screen.contains("12 comments"));
    assert!(!screen.contains("34 likes"));
    assert!(!screen.contains("Share"));
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

#[test]
fn facebook_messenger_keeps_chat_and_drops_nav() {
    let s = WindowContextSnapshot {
        window_title: "Messenger".into(),
        element_name: "Message".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://www.facebook.com/messages/t/123".into()),
        ax_html: Some(
            r#"
            <pane name="Messenger">
              <list name="Chats"><item name="Dad"/></list>
              <group name="Conversation with Dana">
                <item name="Dana: Are we still meeting at 4 PM?"/>
                <item name="You: Yes, I can bring the notes."/>
                <item name="Dana: Please send the room number too."/>
                <edit name="Message" focus="1"></edit>
              </group>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Dana: Are we still meeting"));
    assert!(screen.contains("You: Yes"));
    assert!(screen.contains("Dana: Please send"));
    assert!(!screen.contains("Dad"));
}

#[test]
fn messenger_item_name_with_inline_body_reconstructs_speaker_turns() {
    let s = WindowContextSnapshot {
        window_title: "Messenger".into(),
        element_name: "Message".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://www.messenger.com/t/100087".into()),
        ax_html: Some(
            r#"
            <doc name="Messenger">
              <group name="Message thread">
                <list name="Messages in conversation with Maya Chen">
                  <item name="Maya Chen">Hey, are we still on for Friday's standup?</item>
                  <item name="Maya Chen">I can move it to 10 if that works better for you.</item>
                  <item name="You">let me check my calendar</item>
                  <item name="Maya Chen">No rush! Just let me know by tonight.</item>
                </list>
                <edit name="Message" focus="1"></edit>
              </group>
            </doc>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(
        screen.contains("Maya Chen: Hey, are we still on"),
        "{screen}"
    );
    assert!(screen.contains("You: let me check my calendar"), "{screen}");
    assert!(screen.contains("Maya Chen: No rush"), "{screen}");
}

#[test]
fn zoom_timestamped_groups_reconstruct_speaker_turns() {
    let s = WindowContextSnapshot {
        window_title: "Zoom Meeting".into(),
        element_name: "Type message here...".into(),
        app_exe: Some("zoom.exe".into()),
        ax_html: Some(
            r#"
            <pane name="Chat">
              <list name="Chat Messages">
                <group name="Alex Rivera 10:02 AM">
                  <text>Can you send me the Q3 numbers before we wrap up?</text>
                </group>
                <group name="Priya Shah 10:03 AM">
                  <text>I have the deck open, sharing now.</text>
                </group>
                <group name="Alex Rivera 10:04 AM">
                  <text>Thanks. Also who owns the migration timeline?</text>
                </group>
              </list>
              <edit name="Type message here..." focus="1"></edit>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Alex Rivera: Can you send"), "{screen}");
    assert!(screen.contains("Priya Shah: I have the deck"), "{screen}");
    assert!(screen.contains("Alex Rivera: Thanks"), "{screen}");
    assert!(!screen.contains("10:02 AM:"));
}

#[test]
fn facebook_main_bubble_keeps_feed_comment_thread() {
    let s = WindowContextSnapshot {
        window_title: "Facebook".into(),
        element_name: "Write a comment".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://www.facebook.com/".into()),
        ax_html: Some(
            r#"
            <pane name="Facebook">
              <group name="Navigation"><item name="Home"/><item name="Friends"/></group>
              <article name="Post by Nina">
                <item name="Nina: The prototype demo is tomorrow."/>
                <item name="Omar: I can review the deck tonight."/>
                <item name="You: I added the metrics slide."/>
                <edit name="Write a comment" focus="1"></edit>
              </article>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Nina: The prototype"));
    assert!(screen.contains("Omar: I can review"));
    assert!(screen.contains("You: I added"));
    assert!(!screen.contains("Friends"));
}

#[test]
fn slack_channel_keeps_messages_and_drops_workspace_chrome() {
    let s = WindowContextSnapshot {
        window_title: "Slack | #launch".into(),
        element_name: "Message #launch".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://app.slack.com/client/T123/C456".into()),
        ax_html: Some(
            r##"
            <pane name="Slack">
              <list name="Workspaces"><item name="Acme Internal"/></list>
              <list name="Channels"><item name="#random"/><item name="#sales"/></list>
              <group name="Conversation in #launch">
                <list name="Messages">
                  <item name="Priya: The release note needs the Linux caveat."/>
                  <item name="Marco: I can add it after QA signs off."/>
                  <item name="You: Please keep the customer-impact line."/>
                  <edit name="Message #launch" focus="1"></edit>
                </list>
              </group>
            </pane>
            "##
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Priya: The release note"));
    assert!(screen.contains("Marco: I can add"));
    assert!(screen.contains("You: Please keep"));
    assert!(!screen.contains("#random"));
    assert!(!screen.contains("Acme Internal"));
}

#[test]
fn codex_chat_keeps_active_thread_and_drops_recent_threads() {
    let s = WindowContextSnapshot {
        window_title: "Codex".into(),
        element_name: "Ask Codex".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://chatgpt.com/codex".into()),
        ax_html: Some(
            r#"
            <pane name="Codex">
              <list name="Recent threads">
                <item name="Old billing investigation"/>
                <item name="Unrelated private task"/>
              </list>
              <group name="Conversation">
                <item name="User: Please update the context parser."/>
                <item name="Codex: I found the malformed JSON edge case."/>
                <item name="User: Add a regression before continuing."/>
                <edit name="Ask Codex" focus="1"></edit>
              </group>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("User: Please update"));
    assert!(screen.contains("Codex: I found"));
    assert!(screen.contains("User: Add a regression"));
    assert!(!screen.contains("Old billing"));
    assert!(!screen.contains("Unrelated private"));
}

#[test]
fn claude_chat_keeps_dialog_and_drops_project_sidebar() {
    let s = WindowContextSnapshot {
        window_title: "Claude".into(),
        element_name: "Message Claude".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://claude.ai/chat/123".into()),
        ax_html: Some(
            r#"
            <pane name="Claude">
              <list name="Projects"><item name="Hiring docs"/><item name="Personal notes"/></list>
              <group name="Conversation">
                <item name="User: Can you summarize the error report?"/>
                <item name="Claude: The failing component is the context sidecar."/>
                <item name="User: Draft the follow-up with the workaround."/>
                <edit name="Message Claude" focus="1"></edit>
              </group>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("User: Can you summarize"));
    assert!(screen.contains("Claude: The failing"));
    assert!(screen.contains("User: Draft the follow-up"));
    assert!(!screen.contains("Hiring docs"));
    assert!(!screen.contains("Personal notes"));
}

#[test]
fn canvas_surface_uses_ocr_not_raw_ax_tree() {
    let s = WindowContextSnapshot {
        window_title: "Design".into(),
        element_name: "Canvas".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://www.figma.com/file/abc".into()),
        ax_html: Some("<doc>unhelpful canvas internals</doc>".into()),
        ocr_text: Some("Frame title\nPrimary action copy".into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert!(ctx.get("screen").is_none());
    assert_eq!(ctx["screenOcr"], "Frame title\nPrimary action copy");
}

// ── fake reader integration ──

#[test]
fn browser_tab_strip_titles_do_not_leak_into_page_context() {
    let s = WindowContextSnapshot {
        window_title: "Video - YouTube - Google Chrome".into(),
        element_name: "Search".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://www.youtube.com/watch?v=123".into()),
        ax_html: Some(
            r#"
            <window name="Video - YouTube - Google Chrome">
              <toolbar name="Toolbar">
                <button name="Back"/>
                <edit name="Address and search bar">youtube.com/watch?v=123</edit>
              </toolbar>
              <tabs name="Tab strip">
                <tab name="ChatGPT - Part of group pins"/>
                <tab name="New chat - Claude - Part of group pins"/>
                <tab name="Inbox (2,677) - private.sender@gmail.com - Gmail - Part of group social"/>
                <tab name="Facebook - Part of group social"/>
              </tabs>
              <doc name="YouTube">
                <group name="Main content">
                  <item name="Chess analysis: queen sacrifice at move 17"/>
                  <item name="Comment by Alex: The bishop pin was missed."/>
                  <edit name="Search" focus="1"></edit>
                </group>
              </doc>
            </window>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap();
    assert!(screen.contains("Chess analysis"));
    assert!(screen.contains("Comment by Alex"));
    assert!(!screen.contains("private.sender"));
    assert!(!screen.contains("Gmail"));
    assert!(!screen.contains("Facebook"));
    assert!(!screen.contains("Claude"));
    assert!(!screen.contains("ChatGPT"));
}

// ── A1/A2: page-spanning caret reroutes to the pruned tree ──

// Gmail inline reply: the composer's UIA TextPattern range spans the whole
// page, so text_before is "rich" but full of left-nav + inbox rows + an OTP
// email that lives in OTHER inbox rows (not the open email). With an ax_html
// tree present, the formatter must route to the pruned `screen` and NOT leak
// the inbox/OTP via beforeCaret. (Real Gmail leak shape from the artifact.)
#[test]
fn gmail_page_spanning_caret_reroutes_to_clean_screen_no_inbox_or_otp() {
    let before = [
        "Compose",
        "Inbox 2,677",
        "Snoozed",
        "Sent",
        "Drafts",
        "Promotions 25,370",
        "Amazon.sa",
        "Delivered: 1 item Order # 405-1234567",
        "May 13",
        "Google",
        "Your Google verification code is 622297",
        "May 13",
        "Qiwa",
        "One time password 7596",
        "Jun 9",
        "Kiwi.com",
        "Thinking of adding travel insurance to your trip?",
        "to me",
        "Show details",
        "Hi Mostafa, your upcoming trip to Rome is in two weeks.",
        "We noticed you have not added travel insurance yet.",
    ]
    .join("\n");
    let s = WindowContextSnapshot {
        window_title: "Thinking of adding travel insurance - Gmail".into(),
        element_name: "Message Body".into(),
        app_exe: Some("chrome.exe".into()),
        // url is EMPTY for Chrome captures — detection must not rely on it.
        text_before: Some(before),
        ax_html: Some(
            r#"
            <pane name="Gmail">
              <list name="Mailbox"><item name="Compose"/><item name="Inbox 2,677"/><item name="Snoozed"/></list>
              <list name="Inbox">
                <item name="Amazon.sa: Delivered: 1 item Order # 405-1234567"/>
                <item name="Google: Your Google verification code is 622297"/>
                <item name="Qiwa: One time password 7596"/>
              </list>
              <doc name="Thinking of adding travel insurance">
                <group name="Kiwi.com email">
                  <text>Hi Mostafa, your upcoming trip to Rome is in two weeks.</text>
                  <text>We noticed you have not added travel insurance yet.</text>
                </group>
                <edit name="Message Body" focus="1"></edit>
              </doc>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap_or("");
    // the open email body survives
    assert!(screen.contains("upcoming trip to Rome"), "{screen}");
    // inbox rows + OTP codes are structurally gone, and beforeCaret (the
    // polluted blob) must not be emitted at all
    assert!(ctx.get("beforeCaret").is_none(), "{out}");
    assert!(!out.contains("622297"), "OTP leaked: {out}");
    assert!(!out.contains("7596"), "OTP leaked: {out}");
    assert!(!out.contains("Amazon.sa"), "inbox row leaked: {out}");
    assert!(!out.contains("25,370"), "nav counter leaked: {out}");
}

// X reply: the composer TextPattern range spans the whole article, so
// text_before is "rich" but leaks the nav rail, the user's own identity, and
// engagement counts (232.9K / Views / 41 / Show translation). With a tree
// present, the formatter reroutes to the pruned conversation `screen`.
#[test]
fn x_reply_page_spanning_caret_reroutes_clean_screen_drops_nav_and_counts() {
    let before = [
        "Home",
        "Explore",
        "Notifications",
        "Bookmarks",
        "Mostafa",
        "@Dahshury",
        "Post",
        "Conversation",
        "Saker",
        "@SakerSport",
        "Everyone thought Brazil was the team playing in red yesterday.",
        "232.9K",
        "Views",
        "Show translation",
        "Replying to @SakerSport",
        "Thamer",
        "@Dexcris17",
        "What hurts is after all those touches there is no finish.",
        "41",
        "82",
        "Post your reply",
    ]
    .join("\n");
    let s = WindowContextSnapshot {
        window_title: "Saker on X: \"Everyone thought...\" / X".into(),
        element_name: "Post text".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(before),
        // Realistic X shape: nav rail + self-identity live in chrome regions
        // (banner / nav list) that json_drop_subtree_role + json_is_nav_chrome
        // strip; the conversation is a content-list inside the article doc.
        ax_html: Some(
            r#"
            <pane name="X">
              <banner name="Top bar"><text>Mostafa</text><text>@Dahshury</text></banner>
              <list name="Primary"><link name="Home"/><link name="Explore"/><link name="Notifications"/></list>
              <doc name="Conversation">
                <list name="Timeline: Conversation">
                  <item name="Saker: Everyone thought Brazil was the team playing in red yesterday."/>
                  <item name="Thamer: What hurts is after all those touches there is no finish."/>
                </list>
                <edit name="Post text" focus="1"></edit>
              </doc>
              <list name="Who to follow"><item name="Suggested account"/></list>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap_or("");
    assert!(
        screen.contains("Saker: Everyone thought Brazil"),
        "{screen}"
    );
    assert!(screen.contains("Thamer: What hurts"), "{screen}");
    // beforeCaret with nav/counts must be gone
    assert!(ctx.get("beforeCaret").is_none(), "{out}");
    assert!(!out.contains("232.9K"), "engagement count leaked: {out}");
    assert!(!out.contains("Show translation"), "chrome leaked: {out}");
    assert!(!out.contains("@Dahshury"), "self identity leaked: {out}");
    assert!(
        !screen.contains("Who to follow"),
        "right column leaked: {screen}"
    );
}

// A short, real typed draft with NO nav markers keeps the fast beforeCaret
// path (does NOT get rerouted to the tree even though a tree exists).
#[test]
fn short_typed_draft_keeps_before_caret_path() {
    let s = WindowContextSnapshot {
        window_title: "Compose - Gmail".into(),
        element_name: "Message Body".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(
            "Hi team, just confirming the rollout window is still Friday at noon.".into(),
        ),
        ax_html: Some("<doc>some page chrome here for reference</doc>".into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert!(
        ctx["beforeCaret"]
            .as_str()
            .unwrap_or("")
            .contains("rollout window is still Friday"),
        "{out}"
    );
    assert!(ctx.get("screen").is_none(), "{out}");
}

// ── B1: X compose (no thread) emits the thin draft shape, not the feed ──

#[test]
fn x_compose_emits_thin_field_text_not_timeline_feed() {
    let s = WindowContextSnapshot {
        window_title: "Home / X - Google Chrome".into(),
        element_name: "Post text".into(),
        app_exe: Some("chrome.exe".into()),
        focused_text: "so excited to finally ship the new dictation context feature".into(),
        ax_html: Some(
            r#"
            <pane name="X">
              <list name="Primary"><link name="Home"/><link name="Explore"/></list>
              <doc name="Home timeline">
                <list name="Timeline: Your Home Timeline">
                  <item name="Someone: a random post on the home feed about lunch"/>
                  <item name="Bitget TradFi Ad"/>
                  <item name="Another: yet another unrelated home feed post"/>
                </list>
              </doc>
              <group name="Composer"><edit name="Post text" focus="1"></edit></group>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    // thin shape: the draft is present, the feed is NOT dumped as screen
    assert!(
        ctx["fieldText"]
            .as_str()
            .unwrap_or("")
            .contains("ship the new dictation context feature"),
        "{out}"
    );
    assert!(ctx.get("screen").is_none(), "feed dumped on compose: {out}");
    assert!(!out.contains("random post on the home feed"), "{out}");
    assert!(!out.contains("Bitget TradFi Ad"), "{out}");
}

// ── A5: standalone 'Ad' / '<account> Ad' promoted blocks are dropped ──

#[test]
fn x_promoted_ad_block_is_dropped_from_thread_context() {
    let s = WindowContextSnapshot {
        window_title: "Saker on X / X".into(),
        element_name: "Post text".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(
            r#"
            <pane name="X">
              <doc name="Conversation">
                <list name="Timeline: Conversation">
                  <item name="Saker: The original tweet text that should be kept."/>
                  <item name="Bitget TradFi Ad"/>
                  <item name="Ad"/>
                  <item name="Thamer: A genuine reply that must survive."/>
                  <edit name="Post text" focus="1"></edit>
                </list>
              </doc>
            </pane>
            "#
            .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap_or("");
    assert!(screen.contains("Saker: The original tweet"), "{screen}");
    assert!(screen.contains("Thamer: A genuine reply"), "{screen}");
    assert!(!screen.contains("Bitget TradFi Ad"), "{screen}");
    assert!(
        !screen.lines().any(|l| l.trim() == "Ad"),
        "bare Ad line leaked: {screen}"
    );
}

// ── D4: Messenger left-rail search box is treated as an omnibox ──

#[test]
fn messenger_search_box_is_not_picked_as_field_content() {
    let node = JsonAxNode {
        children: Vec::new(),
        focused: false,
        name: "Search Messenger".to_string(),
        role: "edit".to_string(),
        text: String::new(),
    };
    assert!(json_is_omnibox(&node));
}

// ── REAL-CAPTURE shapes: flat-stream speaker attribution ──────────────
//
// The following fixtures are lightly-truncated excerpts of ACTUAL Chrome UIA
// captures (artifacts/context-cdp/*/rawSnapshot.json). They exercise the flat
// beforeCaret / page-spanning-doc shapes that the synthetic <item> fixtures
// above do NOT cover, and which were producing wrong attribution.

// Discord DM: the focused composer's `textBefore` is a flat newline stream of
// `author / [Server Tag: CLAN] / timestamp / full-datetime / body` rows, with
// same-author continuations marked by a bare clock line. The reconstruction
// must (a) attribute each body to its real author header (Fancy / Master),
// (b) DROP the "Server Tag: W00T"/"Server Tag: CCO" badge lines (the prior bug
// attributed those as speakers), and (c) carry the author across continuations.
#[test]
fn discord_real_flat_stream_attributes_authors_and_drops_server_tag() {
    let text_before = "\
Fancy chat
June 11, 2026
Fancy
6/11/26, 2:07 PM
Thursday, June 11, 2026 at 2:07 PM
Feeh 7agat htt3ml fel nos ofcourse
Master
Server Tag: W00T
6/11/26, 2:07 PM
Thursday, June 11, 2026 at 2:07 PM
can we talk a little
Fancy
6/11/26, 2:07 PM
Thursday, June 11, 2026 at 2:07 PM
Yeah sure
Master
Server Tag: W00T
6/11/26, 11:56 PM
Thursday, June 11, 2026 at 11:56 PM
Did you do whatever you wanted to do before pushing
11:57 PM
Thursday, June 11, 2026 at 11:57 PM
Can I test";
    let s = WindowContextSnapshot {
        window_title: "(1153) Discord | @Fancy - Google Chrome".into(),
        element_name: "Message @Fancy".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(text_before.into()),
        ax_html: Some(
            "<window name=\"Discord\"><edit name=\"Message @Fancy\" focus=\"1\"/></window>".into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let before = ctx["beforeCaret"].as_str().unwrap_or("");
    assert!(
        before.contains("Fancy: Feeh 7agat htt3ml fel nos ofcourse"),
        "{before}"
    );
    assert!(before.contains("Master: can we talk a little"), "{before}");
    assert!(before.contains("Fancy: Yeah sure"), "{before}");
    // continuation line keeps the Master author across the bare clock line
    assert!(before.contains("Master: Can I test"), "{before}");
    // the Server Tag badge is NOT a speaker and must be gone entirely
    assert!(!out.contains("Server Tag"), "server tag leaked: {out}");
    // and the datetime rows must not appear as bodies
    assert!(!before.contains("Thursday, June 11"), "{before}");
    // two distinct real authors are attributed (multi-speaker correct)
    let speakers = before
        .lines()
        .filter_map(|l| l.split_once(": ").map(|(a, _)| a))
        .filter(|a| *a == "Fancy" || *a == "Master")
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(speakers.len(), 2, "{before}");
}

// A real typed Discord draft (short, no timestamp grouping) must NOT be
// mangled by the stream reconstructor — it stays on the plain beforeCaret path.
#[test]
fn discord_short_typed_draft_is_not_reconstructed() {
    let s = WindowContextSnapshot {
        window_title: "Discord | @Fancy".into(),
        element_name: "Message @Fancy".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(
            "hey can you take a look at the deploy script before we ship it tonight".into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    assert!(
        ctx["beforeCaret"]
            .as_str()
            .unwrap_or("")
            .contains("deploy script before we ship"),
        "{out}"
    );
}

// Messenger (facebook.com/messages): the conversation is a single flat `<doc>`
// TextPattern blob that embeds authorship as `… Message sent <when> by
// <Author>: <body>`. Reconstruction must attribute each segment to the author
// after "by", and must NOT false-match the scripture "قوله تعالى:" as a speaker.
#[test]
fn messenger_real_by_author_blob_attributes_authors() {
    let s = WindowContextSnapshot {
        window_title: "Messenger | Facebook - Google Chrome".into(),
        element_name: "Write to موه".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(
            "<window name=\"Messenger | Facebook - Google Chrome\">\
             <doc name=\"Messenger | Facebook\">Conversation titled موه \
             Enter, Message sent Saturday 5:14am by سول: السلام عليكم \
             Enter, Message sent Saturday 8:15am by موه: وعليكم السلام ورحمة الله \
             Enter, Message sent Saturday 8:18am by موه: قوله تعالى: ماتعبدون من بعدي</doc>\
             <edit name=\"Write to موه\" focus=\"1\"></edit></window>"
                .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap_or("");
    assert!(screen.contains("سول: السلام عليكم"), "{screen}");
    assert!(screen.contains("موه: وعليكم السلام"), "{screen}");
    // the scripture colon must NOT be picked as a separate speaker
    assert!(
        !screen
            .lines()
            .any(|l| l.trim_start().starts_with("قوله تعالى:")),
        "scripture matched as speaker: {screen}"
    );
}

// X reply: the conversation lives in a single flat `<doc>` blob with no
// `Author:` prefixes — each tweet is `<DisplayName> @handle [time] <body>`.
// Reconstruction must attribute the original tweet to its author handle and
// drop the logged-in user's own top-bar identity + the "The short reason:"
// sentence-colon false positive.
#[test]
fn x_real_flat_conversation_attributes_tweet_author() {
    let doc = "To view keyboard shortcuts Home Explore Notifications Post \
        Mostafa @Dahshury Post Conversation Andrew Trask @iamtrask This is a bigger deal \
        than it seems. The short reason: combinations of models will always outperform \
        individual models. More in article below Quote OpenRouter @OpenRouter 20h \
        Introducing the Fusion API 7:59 AM Replying to @iamtrask Post your reply \
        Delta, Dirac @DeltaClimbs 8h A neat thing about AI is that it gradually teaches people";
    // Real shape: the X reply page exposes ONE <doc> whose flat TextPattern
    // text is the whole conversation; the composer carries no focus marker in
    // the captured tree (verified against artifacts/context-cdp/x-reply).
    let s = WindowContextSnapshot {
        window_title: "Andrew Trask on X / X - Google Chrome".into(),
        element_name: "Post text".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(format!(
            "<window name=\"Andrew Trask on X / X\">\
             <doc name=\"Andrew Trask on X\">{doc}</doc></window>"
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    let screen = ctx["screen"].as_str().unwrap_or("");
    // the original tweet is attributed to its real author (display name) — the
    // `DisplayName: body` form matches the speaker-prefix contract.
    assert!(
        screen.contains("Andrew Trask: This is a bigger deal"),
        "{screen}"
    );
    // a second distinct author is attributed (the comma-suffix is normalized
    // off, so 'Delta, Dirac' becomes 'Delta')
    assert!(screen.contains("Delta: "), "{screen}");
    // the logged-in user's own identity is NOT emitted as a turn
    assert!(
        !screen.lines().any(|l| l.starts_with("Mostafa:")),
        "self identity leaked as a turn: {screen}"
    );
    // 'The short reason:' must NOT be treated as a speaker turn (it can appear
    // INSIDE the tweet body, but never as a line prefix)
    assert!(
        !screen
            .lines()
            .any(|l| l.trim_start().starts_with("The short reason:")),
        "sentence-colon matched as speaker: {screen}"
    );
    // the 'Replying to @x' marker is not attributed as an author
    assert!(
        !screen.lines().any(|l| l.starts_with("Replying to:")),
        "replying-to marker leaked as a speaker: {screen}"
    );
}

// WhatsApp Web's composer caret TextPattern range spans the chat-LIST rail,
// not the open conversation — so its beforeCaret is the roster of contacts +
// previews (incl. a delivery/OTP 6-digit code). The Discord stream
// reconstructor must NOT fabricate "Contact: preview" turns from it, and the
// formatter must NOT leak the list (or its codes) through beforeCaret. (Real
// shape from artifacts/context-cdp/whatsapp.)
#[test]
fn whatsapp_chat_list_pane_is_not_attributed_and_does_not_leak() {
    let chat_list = "\
Chats 2 Status Updates in Status Channels Communities
Search or start a new chat
All Unread Favorites Groups
Cousin Omar
5:08 PM
Turing intelligence test passed
Muted chat
Bosta
برجاء إظهار الكود 3005137 مندوب بوسطة وصل عندك
1 unread message
Momen
2 unread messages
Archived";
    // chat-list guard fires on the flat stream
    assert!(json_text_is_chat_list_pane(chat_list));
    assert!(json_reconstruct_discord_stream(chat_list).is_none());
    let s = WindowContextSnapshot {
        window_title: "(2) WhatsApp - Google Chrome".into(),
        element_name: "Type a message to Cousin Omar".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(chat_list.into()),
        ax_html: Some(
            "<window name=\"WhatsApp\"><doc name=\"WhatsApp\">chat list pane only</doc></window>"
                .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    // no fabricated 'Cousin Omar:' speaker turn, and the delivery code is gone
    assert!(
        !out.contains("Cousin Omar:"),
        "fabricated chat-list speaker: {out}"
    );
    assert!(!out.contains("3005137"), "delivery/OTP code leaked: {out}");
}

// The false-speaker filter is uniform: 'Server Tag: X', sentence fragments and
// scripture colons are never counted as speaker turns by the central gate.
#[test]
fn false_speaker_prefixes_are_rejected() {
    assert!(json_is_speaker_turn_line("Fancy: hey there"));
    assert!(json_is_speaker_turn_line("You: sure"));
    assert!(json_is_speaker_turn_line("Alex Rivera: can you review"));
    assert!(!json_is_speaker_turn_line("Server Tag: W00T"));
    assert!(!json_is_speaker_turn_line(
        "The short reason: combinations win"
    ));
    assert!(!json_is_speaker_turn_line("Replying to: @someone"));
    assert!(!json_is_speaker_turn_line("قوله تعالى: ماتعبدون"));
}

// ─────────── real-capture chrome scrubbing (discord / gemini) ───────────
//
// The slices below are lifted verbatim from the actual captured `<doc>` blobs
// in artifacts/context-cdp/{discord,gemini}/rawSnapshot.json — the exact flat
// (space-joined, no-newline) shapes the extractor must strip.

/// On the real Discord capture the page arrives as ONE space-joined `<doc>`
/// blob, so the per-user `Server Tag: <CLAN>` clan badge and the trailing
/// user-profile card (`Member Since` / `Mutual Servers` / `View Full Profile`)
/// sit inline and survive the line filters. `json_scrub_discord_blob` removes
/// both. Slice lifted verbatim from artifacts/context-cdp/discord/rawSnapshot.
#[test]
fn discord_blob_scrub_drops_server_tag_and_profile_card() {
    let blob = "Direct Messages Create Message !Evirios! Fancy FLX MO PriNce OoS \
        anaskame1 Pacok Jake Edvin Server Tag: CCO Home Dachi Speranski Pinned Messages \
        Master Server Tag: W00T 6/13/26, 1:13 AM but I didn't make the websites \
        !Evirios! Yesterday at 10:18 PM yeah on 15k$ tourney grandfinals ek \
        More message options Send GIF !Evirios!'s profile Friend More View Full Profile \
        !Evirios! Add Note (only visible to you) evirios Originally known as !Evirios!#1950 \
        Bio . Member Since Mar 12, 2017 Mutual Servers — 3 Mutual Friends — 3 View Full Profile";
    let out = json_scrub_discord_blob(blob);
    // Every Server Tag clan badge is gone (it appears twice in the real blob).
    assert!(
        !out.contains("Server Tag"),
        "Server Tag badge leaked: {out}"
    );
    // The whole trailing profile card is cut.
    assert!(!out.contains("Member Since"), "profile card leaked: {out}");
    assert!(
        !out.contains("Mutual Servers"),
        "profile card leaked: {out}"
    );
    assert!(
        !out.contains("Mutual Friends"),
        "profile card leaked: {out}"
    );
    assert!(
        !out.contains("View Full Profile"),
        "profile card leaked: {out}"
    );
    assert!(
        !out.contains("Originally known as"),
        "profile card leaked: {out}"
    );
    // The real conversation survives untouched.
    assert!(out.contains("but I didn't make the websites"));
    assert!(out.contains("yeah on 15k$ tourney grandfinals ek"));
    // A non-Discord blob is returned unchanged.
    let other = "Subject: Q3 plan To me Sat 2:07 PM Hi team, here is the plan.";
    assert_eq!(json_scrub_discord_blob(other), other);
}

/// End-to-end through `format_context_for_prompt`: the real Discord `axHtml`
/// doc must yield a `screen` with no `Server Tag` badge and no profile card.
#[test]
fn discord_screen_has_no_server_tag_or_profile_card() {
    let ax = "<window name=\"Discord\" focus=\"1\"><pane name=\"Discord\">\
        <doc name=\"Discord\"> Direct Messages Find or start a conversation \
        Friends Message Requests Add a Server Pinned Messages \
        Master Server Tag: W00T 6/13/26, 1:13 AM Saturday, June 13, 2026 at 1:13 AM \
        but I didn't make the websites 1:13 AM I just used them \
        !Evirios! 6/13/26, 1:19 AM Saturday, June 13, 2026 at 1:19 AM Yeah after nod that's cool \
        Master Server Tag: W00T Yesterday at 10:17 PM hw show off? \
        More message options Send GIF !Evirios!'s profile Friend More View Full Profile \
        evirios Originally known as !Evirios!#1950 Member Since Mar 12, 2017 \
        Mutual Servers — 3 Mutual Friends — 3 View Full Profile </doc></pane></window>";
    let s = WindowContextSnapshot {
        window_title: "(1155) Discord | @!Evirios! - Google Chrome".into(),
        element_name: "(1155) Discord | @!Evirios! - Google Chrome".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(ax.into()),
        ..snap()
    };
    let screen = screen_text(s);
    assert!(!screen.is_empty(), "screen unexpectedly empty");
    assert!(
        !screen.contains("Server Tag"),
        "Server Tag leaked: {screen}"
    );
    assert!(
        !screen.contains("Member Since"),
        "profile card leaked: {screen}"
    );
    assert!(
        !screen.contains("Mutual Friends"),
        "profile card leaked: {screen}"
    );
    assert!(
        !screen.contains("View Full Profile"),
        "profile card leaked: {screen}"
    );
    assert!(screen.contains("but I didn't make the websites"));
}

/// The real Gemini capture exposes the whole app as ONE undelimited `<doc>`
/// (per-turn `User:`/`Gemini:` attribution is structurally NOT recoverable from
/// UIA — see the function docs); the only job is to drop the leading Recents
/// rail. `json_scrub_gemini_sidebar_blob` must remove the roster titles and keep
/// the first real prompt. Slice lifted verbatim from
/// artifacts/context-cdp/gemini/rawSnapshot.json.
#[test]
fn gemini_sidebar_scrub_drops_recents_roster_keeps_first_prompt() {
    // Sidebar nav head + Recents roster + first real prompt, verbatim shapes
    // (incl. the `TitleTitle…` truncation echo Gemini renders per entry).
    let blob = "Gemini Temporary chat Close sidebar New chat Search chats Images New \
        Videos Library Notebooks New notebook \
        Recents Coffee Vending Machines Explained Queue Management System Explained \
        Ants on Food: Is It Safe? Text Formatting Models on Hugging Face \
        RTX 50 Series Laptop Pricing Turning Off AC Before Car Papaya Tree Health and Pests \
        WhatsApp Premium Subscription Rumors\u{2026} AI Coding Language Performance \
        a picture of a VR headset as an app icon with a speech visualizer inside it, \
        dynamic lighting, mascot Enter a prompt for Gemini Gemini can make mistakes";
    let out = json_scrub_gemini_sidebar_blob(blob).expect("gemini sidebar shape");
    // Every recents-roster title is gone.
    for title in [
        "Recents",
        "Coffee Vending Machines Explained",
        "Queue Management System Explained",
        "Papaya Tree Health and Pests",
        "RTX 50 Series Laptop Pricing",
        "WhatsApp Premium Subscription Rumors",
        "AI Coding Language Performance",
    ] {
        assert!(
            !out.contains(title),
            "recents roster leaked {title:?}: {out}"
        );
    }
    // The first real prompt survives, leading article intact (not over-trimmed).
    assert!(
        out.starts_with("a picture of a VR headset as an app icon"),
        "first prompt lost / over-trimmed: {out}"
    );
    // Trailing composer/footer chrome is dropped.
    assert!(
        !out.contains("Enter a prompt for Gemini"),
        "footer leaked: {out}"
    );
    assert!(!out.contains("can make mistakes"), "footer leaked: {out}");
}

/// The roster-strip is conservative: a blob with no lowercase-prompt boundary
/// (all Title-Case) is returned unchanged so a real Title-Case opening turn is
/// never eaten, and a connector-only/empty input is a no-op.
#[test]
fn gemini_recents_roster_strip_is_conservative() {
    // No lowercase non-connector boundary → unchanged.
    let all_titles = "Coffee Vending Machines Explained Queue Management System Explained";
    assert_eq!(json_strip_gemini_recents_roster(all_titles), all_titles);
    // Empty / whitespace → unchanged.
    assert_eq!(json_strip_gemini_recents_roster(""), "");
    // Boundary at index 0 (starts lowercase) → unchanged (nothing to strip).
    let starts_lower = "a picture of a VR headset as an app icon with a visualizer";
    assert_eq!(json_strip_gemini_recents_roster(starts_lower), starts_lower);
}

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
// tree walk). The fragment must stay a clean focused-field shape — never the
// old `screen` tree dump that leaked sidebars / inbox rows.

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
    assert!(ctx["beforeCaret"]
        .as_str()
        .unwrap_or("")
        .contains("thanks for the update"));
    assert!(ctx["afterCaret"]
        .as_str()
        .unwrap_or("")
        .contains("Dana Lee wrote"));
    // The focused-field path must NOT emit a whole-window tree dump.
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

// ───────── real-capture speaker attribution (who-said-what) ─────────
//
// Each fixture below is a representative slice of the ACTUAL captured tree in
// artifacts/context-cdp/<app>/rawSnapshot.json — the exact UI shapes the
// extractor must attribute correctly (or filter as false speakers).

fn before_caret_text(snapshot: WindowContextSnapshot) -> String {
    let out = format_context_for_prompt(&snapshot);
    context_json(&out)["beforeCaret"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

/// The Discord "Server Tag: CCO" clan-tag badge (renders right under a user
/// header) must NEVER become an `Author:` speaker line — it is a per-user
/// badge, not a sender. Shape lifted from the real Discord friends-page doc.
#[test]
fn discord_server_tag_badge_is_not_a_speaker() {
    assert!(JSON_FALSE_SPEAKER_PREFIX_RE.is_match("Server Tag: CCO"));
    assert!(!json_is_speaker_turn_line("Server Tag: CCO"));
    // And in a real flat blob the badge is plain roster text, never a turn.
    let blob = "anaskame1 Pacok Jake Edvin Server Tag: CCO Home Dachi Speranski";
    assert_eq!(json_attribute_flat_blob(blob), blob);
    assert!(!blob
        .lines()
        .any(|l| json_is_speaker_turn_line(l) && l.starts_with("Server Tag")));
}

/// Discord renders a real message group as `<Author>` / [`Server Tag: X`] /
/// `<H:MM AM>` / `<full datetime>` / `<body…>`. The username heads the group;
/// the Server-Tag badge under it must be dropped, not treated as the author.
#[test]
fn discord_thread_attributes_username_not_server_tag() {
    let stream = [
        "Maya",
        "Server Tag: CCO",
        "9:41 AM",
        "Today at 9:41 AM",
        "The Windows build still needs signing.",
        "Chris",
        "Server Tag: CCO",
        "9:43 AM",
        "Today at 9:43 AM",
        "I uploaded the cert bundle.",
    ]
    .join("\n");
    let s = WindowContextSnapshot {
        window_title: "Discord | #release".into(),
        element_name: "Message #release".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(stream),
        ..snap()
    };
    let before = before_caret_text(s);
    assert!(before.contains("Maya: The Windows build still needs signing."));
    assert!(before.contains("Chris: I uploaded the cert bundle."));
    // The clan-tag badge is gone and never attributed.
    assert!(!before.contains("Server Tag"));
    assert!(!before.contains("Server Tag: CCO"));
}

/// Facebook Messenger embeds authorship as `Enter, Message sent <when> by
/// <Author>: <body>` with the body ALSO previewed before the marker. The
/// reconstructor must (1) attribute each turn to its real author, (2) not let
/// one turn's body bleed into the next preview, and (3) keep a Quran-verse
/// "قوله تعالى:" line as a BODY of its sender — never as a fabricated speaker.
/// Shape lifted verbatim from the real facebook/rawSnapshot.json textBefore.
#[test]
fn messenger_by_author_marker_attributes_turns_without_bleed() {
    let text = concat!(
        "السلام عليكم\n\u{fffc}\n",
        "Enter, Message sent Saturday 5:14am by سول: السلام عليكم\n",
        "صباح الخير\n\u{fffc}\n",
        "Enter, Message sent Saturday 5:14am by سول: صباح الخير\n",
        "وعليكم السلام ورحمة الله وبركاته شكرا ياعمورة على الدعوة الصباحية الجميلة\n\u{fffc}\n",
        "Enter, Message sent Saturday 8:15am by موه: وعليكم السلام ورحمة الله وبركاته شكرا ياعمورة على الدعوة الصباحية الجميلة\n",
        "قوله تعالى: ﴿أَمْ كُنتُمْ شُهَدَاءَ﴾\n\u{fffc}\n",
        "Enter, Message sent Saturday 9:23am by موه: قوله تعالى: ﴿أَمْ كُنتُمْ شُهَدَاءَ﴾\n",
        "Compose\nOpen more actions\nWrite to ماما\n"
    );
    let s = WindowContextSnapshot {
        window_title: "Messenger | Facebook - Google Chrome".into(),
        element_name: "Write to ماما".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(text.into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
    // Each message attributed to its real author.
    assert!(screen.contains("سول: السلام عليكم"));
    assert!(screen.contains("سول: صباح الخير"));
    assert!(screen.contains("موه: وعليكم السلام"));
    // The first سول turn must NOT have swallowed the next preview line.
    assert!(!screen.contains("سول: السلام عليكم صباح الخير"));
    // The Quran verse is a BODY of موه, not a standalone "قوله تعالى:" speaker.
    assert!(screen.contains("موه: قوله تعالى:"));
    assert!(!screen.contains("\nقوله تعالى:"));
    // The trailing composer toolbar chrome never leaks into a turn.
    assert!(!screen.contains("Compose"));
    assert!(!screen.contains("Open more actions"));
    assert!(!screen.contains("Write to ماما"));
}

/// X (Twitter) reply page: no `Author:` prefix — each tweet is positionally
/// `<DisplayName> @handle [time] <body> <engagement-counts>`. The
/// reconstructor attributes by handle, strips the trailing count run, and must
/// not fuse the NEXT author's display name onto a body. Shape from the real
/// x-reply/rawSnapshot.json doc blob; "The short reason:" is body text, not a
/// speaker. The whole-blob flows through the doc-landmark + flat-attribution
/// path, so this drives format_context_for_prompt end-to-end.
#[test]
fn x_reply_attributes_by_handle_and_strips_counts() {
    let doc = concat!(
        "Conversation ",
        "Andrew Trask @iamtrask ",
        "This is a way bigger deal than it seems. The short reason: combinations of models will always outperform individual models ",
        "Quote OpenRouter @OpenRouter 20h Introducing the Fusion API ",
        "7:59 AM Jun 14, 2026 563.4K Views 148 237 2.8K 2.3K Relevant View quotes Replying to @iamtrask Post your reply ",
        "Trevor I. Lasn @trevorlasn 4h yeah different models miss different things so ensembling cancels the errors. what is fusion using? 146 ",
        "Christian Niven @christian_niven 6h No it is not. I do not understand how you were fooled by this marketing. 2 1 305 ",
        "Relevant people Andrew Trask @iamtrask Follow Live on X العربية is hosting trending"
    );
    // Real X-reply shape: the conversation is a flat `<doc>` content landmark
    // (page-spanning TextPattern blob, no per-tweet nodes) and the focused
    // composer is a sibling `<edit>` — so the landmark resolver picks the doc
    // and routes it through the flat positional @handle attribution path.
    let s = WindowContextSnapshot {
        window_title: "Andrew Trask on X - Google Chrome".into(),
        element_name: "Post text".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(format!(
            r#"<pane name="X"><doc name="Conversation">{doc}</doc><edit name="Post text" focus="1"></edit></pane>"#
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
    assert!(
        screen.contains("Andrew Trask: This is a way bigger deal"),
        "{screen}"
    );
    assert!(
        screen.contains("Trevor I. Lasn: yeah different models miss"),
        "{screen}"
    );
    assert!(
        screen.contains("Christian Niven: No it is not."),
        "{screen}"
    );
    // "The short reason:" stays inside Andrew Trask's body, not a speaker line.
    assert!(!screen.contains("\nThe short reason:"));
    // Trailing engagement counts and the next author's name are stripped.
    assert!(!screen.contains("146 Christian"));
    assert!(!screen.contains("305 Relevant"));
    assert!(!screen.contains("2 1 305"));
    // The post-thread footer (Relevant people / Live on X / trending) is cut.
    assert!(!screen.contains("Live on X"));
    assert!(!screen.contains("Relevant people"));
}

/// An AI chat (ChatGPT/Claude/Gemini) renders alternating role-labeled blocks
/// (`You said:` / `ChatGPT said:`). They must collapse to a clean two-role
/// `User:` / `Assistant:` alternation so the LLM sees who said what.
#[test]
fn ai_chat_collapses_to_user_assistant_turns() {
    let doc = "ChatGPT You said: How do I reverse a string in Rust? \
        ChatGPT said: Call chars rev collect on the input. \
        You said: Does that handle Unicode correctly? \
        ChatGPT said: It reverses by Unicode scalar values so most text is fine.";
    let s = WindowContextSnapshot {
        window_title: "ChatGPT - Google Chrome".into(),
        element_name: "Ask anything".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://chatgpt.com/c/abc".into()),
        ax_html: Some(format!(
            r#"<window name="ChatGPT"><doc name="ChatGPT" focus="1">{doc}</doc></window>"#
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
    assert!(screen.contains("User: How do I reverse a string in Rust?"));
    assert!(screen.contains("Assistant: Call chars rev collect"));
    assert!(screen.contains("User: Does that handle Unicode correctly?"));
    assert!(screen.contains("Assistant: It reverses by Unicode scalar values"));
    // The brand label never survives as a speaker; only User/Assistant do.
    assert!(!screen.contains("ChatGPT:"));
    assert!(!screen.contains("You said:"));
}

/// A page that merely MENTIONS an assistant brand (a "ChatGPT:" footer link)
/// without a real two-role exchange must NOT be mistaken for a conversation.
#[test]
fn ai_chat_requires_both_roles() {
    // Only an assistant label, no "You" — not a conversation.
    assert!(json_reconstruct_ai_chat_blob(
        "ChatGPT: the smartest model. Gemini: also great. Footer links here."
    )
    .is_none());
    // Only a user label — not a conversation either.
    assert!(json_reconstruct_ai_chat_blob("You: typed this. Some other text here.").is_none());
}

/// Generic false-speaker guard: a `prefix:` whose prefix is a sentence
/// fragment, a known UI string, or a scripture/quote opener must be filtered,
/// while genuine display names (incl. non-Latin and `You`) are kept.
#[test]
fn false_speaker_prefixes_are_filtered() {
    // False speakers (UI badges, sentence fragments, scripture openers).
    for line in [
        "Server Tag: CCO",
        "The short reason: combinations of models win",
        "Replying to: @someone",
        "Original message: text",
        "قوله تعالى: ﴿آية﴾",
    ] {
        assert!(
            !json_is_speaker_turn_line(line),
            "{line:?} must NOT be a speaker turn"
        );
    }
    // Genuine speakers.
    for line in [
        "Maya: the build needs signing",
        "You: I will ship it",
        "علي: تمام يا باشا",
        "Trevor I. Lasn: ensembling cancels the errors",
    ] {
        assert!(
            json_is_speaker_turn_line(line),
            "{line:?} SHOULD be a speaker turn"
        );
    }
}

/// A sentence fragment ending the body that ALSO ends in a colon (e.g. an
/// over-long prefix) is rejected by the >40-char / sentence-shape guard so it
/// never fabricates a speaker out of mid-sentence text.
#[test]
fn over_long_or_sentence_prefix_is_not_a_speaker() {
    let long =
        "This is a very long sentence fragment that clearly is not a chat author name at all: body";
    assert!(!json_is_speaker_turn_line(long));
    // A prefix carrying terminal sentence punctuation is not a name.
    assert!(!json_looks_like_author_header(
        "but anyway, that is the whole point."
    ));
}

// ─────────── REAL CAPTURE shapes: AI chat + Outlook attribution ───────────
//
// The fixtures below are lifted VERBATIM from the on-disk captures in
// artifacts/context-cdp/{claude,gemini,chatgpt,outlook}/rawSnapshot.json (the
// axHtml `<doc>` blob / the composer `textBefore`). They pin the four problem
// shapes the finalize-attribution pass had to fix.

/// Claude (artifacts/context-cdp/claude): the real app renders the transcript
/// as `You said: …` / `Claude responded: …` app literals inside one flat
/// `<doc>` TextPattern blob, surrounded by heavy UI chrome (the sidebar nav,
/// the per-turn `Retry Edit Copy / Read aloud / Give positive feedback`
/// toolbar, the artifact card `View <name> … Code · HTML Download Copy`, the
/// composer + model picker, the `Claude is AI and can make mistakes` footer,
/// and a `Your previous message wasn't sent` notice). The reconstruction must
/// collapse to `User:` / `Assistant:` and filter ALL of that chrome.
#[test]
fn claude_real_doc_collapses_to_user_assistant_and_drops_chrome() {
    // Verbatim slice of the real claude/rawSnapshot.json axHtml `<doc>` text.
    let doc = "New chat Chats Projects Artifacts Customize M Mostafa Max plan \
        HTML CSS pixel perfect clone More options for HTML CSS pixel perfect clone \
        You said: clone this in html css pixel perfect clone this in html css pixel perfect \
        1:33 AM Retry Edit Copy \
        Claude responded: This is a faithful clone task—the brief pins down everything. \
        Architected pixel-perfect HTML/CSS layout with dark theme and chart \
        Done. Single-file uplinq.html — two-column dark panel, mint headline. \
        View Uplinq Uplinq Code · HTML Download Copy Read aloud Give positive feedback \
        Give negative feedback Retry \
        You said: not exact. not exact. edge highlights of the main card missing \
        1:36 AM Retry Edit Copy \
        Claude responded: Found the gaps. The original has a bright top-edge highlight. \
        View Uplinq Uplinq Code · HTML Download Copy Read aloud Give positive feedback \
        Give negative feedback Retry Claude Fable 5 is currently unavailable. \
        Learn more (opens in new tab) \
        Add files, connectors, and more Opus 4.8 High Press and hold to record \
        Claude is AI and can make mistakes. Please double-check responses. Files Share \
        Your previous message wasn't sent. You can try again. Close";
    let s = WindowContextSnapshot {
        window_title: "HTML CSS pixel perfect clone - Claude - Google Chrome".into(),
        element_name: "Write your prompt to Claude".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(format!(
            r#"<window name="HTML CSS pixel perfect clone - Claude - Google Chrome"><doc name="HTML CSS pixel perfect clone - Claude" focus="1">{doc}</doc></window>"#
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
    // Collapsed to the canonical two roles.
    assert!(
        screen.contains("User: clone this in html css pixel perfect"),
        "{screen}"
    );
    assert!(
        screen.contains("Assistant: This is a faithful clone task"),
        "{screen}"
    );
    assert!(screen.contains("User: not exact."), "{screen}");
    assert!(screen.contains("Assistant: Found the gaps."), "{screen}");
    // App literals never survive as speaker labels.
    assert!(!screen.contains("You said:"), "{screen}");
    assert!(!screen.contains("Claude responded:"), "{screen}");
    // Every named chrome run is filtered.
    for chrome in [
        "New chat Chats Projects",
        "Retry Edit Copy",
        "Read aloud",
        "Give positive feedback",
        "Give negative feedback",
        "Add files, connectors, and more",
        "Opus 4.8",
        "Press and hold to record",
        "Claude is AI and can make mistakes",
        "double-check responses",
        "Your previous message wasn't sent",
        "Code · HTML",
        "Download Copy",
        "View Uplinq",
        "is currently unavailable",
    ] {
        assert!(
            !screen.contains(chrome),
            "chrome leaked ({chrome}): {screen}"
        );
    }
    // Per-turn timestamps are stripped off the user-message tails.
    assert!(!screen.contains("1:33 AM"), "{screen}");
    assert!(!screen.contains("1:36 AM"), "{screen}");
}

/// The role regex matches the real Claude / ChatGPT verbs and the speaker
/// classifier collapses them, but a bare brand mention WITHOUT a colon (the
/// `Claude is AI and can make mistakes` footer) is never a role marker.
#[test]
fn ai_chat_role_markers_match_real_verbs_only_with_colon() {
    assert_eq!(json_ai_chat_role_speaker("You said"), Some("User"));
    assert_eq!(
        json_ai_chat_role_speaker("Claude responded"),
        Some("Assistant")
    );
    assert_eq!(json_ai_chat_role_speaker("ChatGPT said"), Some("Assistant"));
    assert_eq!(
        json_ai_chat_role_speaker("Gemini replied"),
        Some("Assistant")
    );
    assert_eq!(json_ai_chat_role_speaker("Random label"), None);
    // A bare brand WITHOUT a colon is not a marker (footer text is not a turn).
    assert!(json_reconstruct_ai_chat_blob(
        "Claude is AI and can make mistakes. Please double-check responses."
    )
    .is_none());
}

/// Claude/ChatGPT collapse also covers the `ChatGPT said:` shape the recipe is
/// being fixed to capture (artifacts/context-cdp/chatgpt, label `claude`).
#[test]
fn chatgpt_said_shape_collapses_and_filters_chrome() {
    let doc = "Skip to content Chat history Home Close sidebar New chat Search chats \
        You said: please find this website \
        ChatGPT said: Found it: Specc. Website: speccapp.com. It matches the product. \
        You said: does it have a free tier? \
        ChatGPT said: Yes, the launch post mentions a free plan. \
        Ask anything ChatGPT can make mistakes. Check important info.";
    let s = WindowContextSnapshot {
        window_title: "ChatGPT - Google Chrome".into(),
        element_name: "Message ChatGPT".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(format!(
            r#"<window name="ChatGPT - Google Chrome"><doc name="ChatGPT" focus="1">{doc}</doc></window>"#
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
    assert!(
        screen.contains("User: please find this website"),
        "{screen}"
    );
    assert!(screen.contains("Assistant: Found it: Specc"), "{screen}");
    assert!(
        screen.contains("User: does it have a free tier?"),
        "{screen}"
    );
    assert!(
        screen.contains("Assistant: Yes, the launch post"),
        "{screen}"
    );
    assert!(!screen.contains("ChatGPT said:"), "{screen}");
    assert!(!screen.contains("You said:"), "{screen}");
    assert!(!screen.contains("Skip to content"), "{screen}");
    assert!(!screen.contains("ChatGPT can make mistakes"), "{screen}");
    assert!(!screen.contains("Ask anything"), "{screen}");
}

/// ChatGPT's CURRENT real capture (artifacts/context-cdp/chatgpt) uses
/// affordance-based turns (no role labels): the doc opens with `Skip to content
/// Open sidebar …`, interleaves `Copy message`/`Copy response`/`Good response`
/// affordances + a `Thought for 26s` reasoning header, and closes with `Add
/// files and more Ask anything … ChatGPT can make mistakes`. Even without role
/// markers the framing + inline chrome must be stripped so the user query and
/// the answer survive cleanly.
#[test]
fn chatgpt_affordance_doc_strips_framing_and_inline_chrome() {
    // Verbatim slice of the real chatgpt/rawSnapshot.json `<doc>` blob.
    let doc = "Skip to content Open sidebar Copy link Open conversation options \
        please find this website Copy message Edit message Thought for 26s \
        Found it: Specc Website: speccapp.com Specc \
        It matches the screenshot's product: AI that turns calls/transcripts into \
        developer-ready tickets and specs, with Jira/Linear/Notion integrations. \
        indiehackers.com Copy response Good response Bad response Share Switch model \
        More actions Sources Add files and more Ask anything Medium Start Voice \
        ChatGPT can make mistakes. Check important info.";
    let s = WindowContextSnapshot {
        window_title: "Website Search Result - Google Chrome".into(),
        element_name: "Message ChatGPT".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(format!(
            r#"<window name="Website Search Result - Google Chrome"><doc name="Website Search Result">{doc}</doc></window>"#
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
    // Real content survives.
    assert!(screen.contains("please find this website"), "{screen}");
    assert!(screen.contains("speccapp.com"), "{screen}");
    // Framing + inline affordance chrome is stripped.
    for chrome in [
        "Skip to content",
        "Open sidebar",
        "Copy link",
        "Copy message",
        "Edit message",
        "Copy response",
        "Good response",
        "Bad response",
        "Switch model",
        "More actions",
        "Thought for 26s",
        "Add files and more",
        "Ask anything",
        "ChatGPT can make mistakes",
    ] {
        assert!(
            !screen.contains(chrome),
            "chrome leaked ({chrome}): {screen}"
        );
    }
}

/// Gemini (artifacts/context-cdp/gemini): the real app exposes the whole UI as
/// one structureless `<doc>` — a sidebar nav prefix, a `Recents` roster of past
/// chat titles (each echoed `TitleTitle…`), then the user's prompts, closing
/// with `Ask Gemini`. The scrub must drop the sidebar nav, the `Recents` label,
/// the placeholder, and the footer, keeping the real prompt content.
#[test]
fn gemini_real_sidebar_doc_drops_nav_recents_and_placeholder() {
    // Verbatim slice of the real gemini/rawSnapshot.json `<doc>` blob.
    let doc = "Gemini Temporary chat Close sidebar New chat Search chats Images New \
        Videos Library Notebooks New notebook \
        Health in Hajj: Training and Guidance ManualHealth in Hajj: Training and Guida… \
        Recents Coffee Vending Machines Explained Queue Management System Explained \
        WhatsApp Premium Subscription RumorsWhatsApp Premium Subscription Rum… \
        Create a neon, cyberpunk-inspired logo of a stylized soundwave piercing through \
        a glowing text caret, with bright glowing lines and vibrant colors for a sleek \
        modern look using electric blue, neon pink, and bright purple gradients. \
        Conversation with Gemini Let's jump in, Mostafa Ask Gemini";
    let s = WindowContextSnapshot {
        window_title: "Google Gemini - Google Chrome".into(),
        element_name: "Enter a prompt for Gemini".into(),
        app_exe: Some("chrome.exe".into()),
        ax_html: Some(format!(
            r#"<window name="Google Gemini - Google Chrome"><doc name="Google Gemini">{doc}</doc></window>"#
        )),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
    // The real prompt content survives.
    assert!(screen.contains("neon, cyberpunk-inspired logo"), "{screen}");
    // Sidebar nav / Recents label / placeholder / footer are gone.
    for chrome in [
        "Gemini Temporary chat",
        "Close sidebar",
        "New notebook",
        "Recents",
        "Ask Gemini",
        "Enter a prompt for Gemini",
        "Let's jump in",
        "Conversation with Gemini",
    ] {
        assert!(
            !screen.contains(chrome),
            "chrome leaked ({chrome}): {screen}"
        );
    }
    // The `TitleTitle…` truncation echo is collapsed (no stray `…`).
    assert!(
        !screen.contains('\u{2026}'),
        "truncation echo leaked: {screen}"
    );
}

/// Outlook (artifacts/context-cdp/outlook, label `gmail`): the composer focuses
/// (`Message body`) but its caret TextPattern range spans the WHOLE mail app —
/// the left-rail folders, the inbox message LIST (rows like `Reminder: …
/// birthday`, `amazon.eg: Sign-in`, `… Account Verification`), then the open
/// thread. The Outlook folder/sort markers must reroute it to the pruned path,
/// and the message-list + any sign-in / verification / OTP rows must be dropped
/// — only the open thread (sender + subject + body) survives. Shape lifted
/// verbatim from the real outlook/rawSnapshot.json textBefore.
#[test]
fn outlook_inbox_list_reroutes_and_drops_message_list_and_otp() {
    let text_before = "\
Hide navigation pane
File
Home
Navigation pane
Favorites
Inbox
10927
unread
Sent Items
Drafts
Archive
Junk Email
Deleted Items
Conversation HistoryConversation Histo…
Focused
Other
Sorted: By Date
Other Emails (90)
info@codebasics.io
CodeBasics | Account Verification
Yesterday
Header action menu
support@storyblocks.com
Verify Your Storyblocks API AccountVerify Your Storyblocks API…
Sun 1:32 PM
amazon.eg
amazon.eg: Sign-in
Mon 6/1
Mostafa Eldahsory, Someone signed-in to your account.
SaSa Darsh
Reminder: kevin.e.13's birthdayReminder: kevin.e.13's birth…
Fri 12:00 PM
Your reminder for kevin.e.13's birthday 6/13/2026 All DayYour reminder for kevin.e.13's birthday 6…
Reminder: kevin.e.13's birthday
SaSa Darsh
View with a light background
Reply
Reply all
Forward
Apps
More items
To:
SaSa Darsh <MASTER_X_3@live.com>
Fri 6/12/2026 12:00 PM
Show original size
Your reminder for kevin.e.13's birthday
6/13/2026
All Day
Expand header and show message history
Pop Out";
    let s = WindowContextSnapshot {
        window_title: "Mail - SaSa Darsh - Outlook - Google Chrome".into(),
        element_name: "Message body".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(text_before.into()),
        // The real Outlook tree is one structureless <doc> whose entire content
        // is a single page-spanning TextPattern blob the role pruner classifies
        // as one low-signal line (it ends in an ` Ad` chrome token) and drops —
        // so the pruner yields nothing and the formatter scrubs the newline
        // `textBefore` instead. A bare toolbar-only tree reproduces that
        // "tree prunes to empty" condition.
        ax_html: Some(
            "<window name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
             <pane name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
             <toolbar name=\"Bookmarks\"><button name=\"Work\"></button></toolbar>\
             </pane></window>"
                .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    let ctx = context_json(&out);
    // Rerouted to the pruned `screen`; the polluted beforeCaret is NOT emitted.
    let screen = ctx["screen"].as_str().unwrap_or("");
    assert!(
        ctx.get("beforeCaret").is_none(),
        "beforeCaret leaked: {out}"
    );
    // The open email thread survives.
    assert!(
        screen.contains("Your reminder for kevin.e.13's birthday"),
        "{screen}"
    );
    // The message LIST + the sign-in / verification / OTP rows are gone.
    for leaked in [
        "amazon.eg: Sign-in",
        "Sign-in",
        "Account Verification",
        "Verify Your Storyblocks",
        "Someone signed-in",
        "Inbox",
        "Junk Email",
        "Deleted Items",
        "Sent Items",
        "Conversation History",
        "Sorted: By Date",
        "Header action menu",
        "Other Emails",
        // per-message reading-pane action chrome
        "View with a light background",
        "Reply all",
        "Expand header and show message history",
        "Pop Out",
    ] {
        assert!(
            !out.contains(leaked),
            "outlook chrome leaked ({leaked}): {out}"
        );
    }
    // No verification / single-use / sign-in OTP phrase survives anywhere.
    assert!(json_is_otp_or_signin_row("amazon.eg: Sign-in"));
    assert!(json_is_otp_or_signin_row(
        "Google: Your verification code is 622297"
    ));
    assert!(json_is_otp_or_signin_row("Qiwa: One time password 7596"));
    assert!(!out.to_lowercase().contains("verification code"), "{out}");
    assert!(!out.to_lowercase().contains("single-use"), "{out}");
}

/// The Outlook folder / sort markers are present in JSON_PAGE_NAV_MARKERS so a
/// mail caret blob is detected as page-spanning scrollback (and rerouted off
/// the flat beforeCaret path).
#[test]
fn outlook_folder_markers_detected_as_page_scrollback() {
    let blob = "Favorites Inbox Sent Items Drafts Archive Junk Email Deleted Items \
        Conversation History Focused Other Sorted: By Date";
    assert!(json_caret_is_page_scrollback(blob));
}

/// The mail-blob scrubber cuts the inbox-list scrollback at the last
/// `…`-truncated preview row and drops the per-message Outlook chrome, keeping
/// only the open thread.
#[test]
fn mail_blob_scrubber_cuts_list_and_keeps_thread() {
    let text = "\
Inbox
amazon.eg: Sign-inamazon.eg: Sign-…
Mon 6/1
Reminder: kevin.e.13's birthdayReminder: kevin.e.13's birth…
SaSa Darsh
View with a light background
Reply
Reply all
Forward
To:
SaSa Darsh <MASTER_X_3@live.com>
Your reminder for kevin.e.13's birthday
All Day
Pop Out";
    let scrubbed = json_scrub_mail_blob(text).expect("mail shape recognized");
    assert!(
        scrubbed.contains("Your reminder for kevin.e.13's birthday"),
        "{scrubbed}"
    );
    assert!(!scrubbed.contains("amazon.eg"), "{scrubbed}");
    assert!(!scrubbed.contains("Sign-in"), "{scrubbed}");
    assert!(
        !scrubbed.contains("View with a light background"),
        "{scrubbed}"
    );
    assert!(!scrubbed.contains("Reply all"), "{scrubbed}");
    assert!(!scrubbed.contains("Pop Out"), "{scrubbed}");
}

// ── unconditional final OTP / secret-code scrub (privacy-critical) ──

/// The exact Outlook leak shape from artifacts/context-cdp/outlook: the whole
/// mail app is a single structureless `<doc>` whose TextPattern blob carries
/// the open email body `... Your account verification OTP is: 17042 ...`. With
/// empty caret fields the formatter falls all the way through to the raw
/// window-dump (`screen = ax_html`), which the per-ROW OTP filter never sees
/// because the whole `<doc>` is ONE line. The unconditional final scrub must
/// still strip the code on THIS path.
#[test]
fn outlook_window_dump_scrubs_verification_otp_code() {
    let ax_html = "<window name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
        <doc name=\"Mail - SaSa Darsh - Outlook\"> Inbox 10926 unread \
        CodeBasics | Account Verification info@codebasics.io View with a light background \
        Reply Reply all More items Mon 2/26/2024 10:28 PM Show original size \
        Dear master el master, Your account verification OTP is: 17042 \
        If you have any questions, please do not hesitate to reach out to us. \
        Best regards, Team Codebasics Questions or FAQ? Contact us at info@codebasics.io. \
        Copyright 2024 codebasics.io. Pop Out </doc></window>";
    let s = WindowContextSnapshot {
        window_title: "Mail - SaSa Darsh - Outlook - Google Chrome".into(),
        element_name: "Mail - SaSa Darsh - Outlook - Google Chrome".into(),
        app_exe: Some("chrome.exe".into()),
        // No caret / focused text: forces the raw window-dump branch.
        ax_html: Some(ax_html.into()),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    assert!(!out.is_empty());
    assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok());
    // THE leak: the real OTP code and its announcing phrase are gone.
    assert!(
        !out.contains("17042"),
        "OTP code leaked via window-dump: {out}"
    );
    assert!(
        !out.to_lowercase().contains("verification otp"),
        "OTP phrase leaked: {out}"
    );
    assert!(
        !out.to_lowercase().contains("otp is"),
        "OTP phrase leaked: {out}"
    );
    // Benign surrounding context (the sender, the signature) still survives,
    // and incidental numbers in the dump (the year 2024, the 10926 unread
    // count) are NOT collateral-damaged.
    assert!(out.contains("Team Codebasics"), "body context lost: {out}");
    assert!(out.contains("2024"), "year over-redacted: {out}");
    assert!(out.contains("10926"), "unread count over-redacted: {out}");
}

/// Same Outlook OTP body, but delivered through the page-spanning caret
/// REROUTE path (rich `textBefore` + a tree present). The mail-blob scrubber
/// handles most of it, but the final scrub is the guarantee the code never
/// survives regardless of which branch wins.
#[test]
fn outlook_reroute_path_scrubs_verification_otp_code() {
    let text_before = "\
Inbox
amazon.eg: Sign-inamazon.eg: Sign-…
Sorted: By Date
CodeBasics | Account VerificationCodeBasics | Account Verif…
info@codebasics.io
View with a light background
Reply
Reply all
Show original size
Dear master el master,
Your account verification OTP is: 17042
If you have any questions, please do not hesitate to reach out to us.
Best regards, Team Codebasics";
    let s = WindowContextSnapshot {
        window_title: "Mail - SaSa Darsh - Outlook - Google Chrome".into(),
        element_name: "Message body".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(text_before.into()),
        ax_html: Some(
            "<window name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
             <pane name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
             <toolbar name=\"Bookmarks\"><button name=\"Work\"></button></toolbar>\
             </pane></window>"
                .into(),
        ),
        ..snap()
    };
    let out = format_context_for_prompt(&s);
    assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok());
    assert!(!out.contains("17042"), "OTP code leaked via reroute: {out}");
    assert!(
        !out.to_lowercase().contains("verification otp"),
        "OTP phrase leaked via reroute: {out}"
    );
}

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
