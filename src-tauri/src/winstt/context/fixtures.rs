//! Shared snapshot fixture corpus for the A/B evaluation harness
//! (`bin/context_ab_eval.rs`) and the generic-path unit tests.
//!
//! Each fixture is a representative `WindowContextSnapshot` for one capture
//! shape (Discord flat stream, X reply blob, Messenger by-author blob, AI-chat
//! role turns, Gmail/Outlook mail blobs, and a plain generic field). The
//! `kind` string is the coarse surface label the harness emits per line. These
//! snapshots are the SAME shapes the legacy formatter tests pin, extracted here
//! so the harness runs both formatter paths over identical inputs.

use super::WindowContextSnapshot;

/// One named fixture plus its coarse surface label.
pub struct ContextFixture {
    pub name: &'static str,
    /// Coarse surface class: discord | x | messenger | ai_chat | gmail |
    /// outlook | generic.
    pub kind: &'static str,
    pub snapshot: WindowContextSnapshot,
}

fn snap() -> WindowContextSnapshot {
    WindowContextSnapshot::default()
}

/// Discord — the real FLAT author/timestamp/body line stream in `textBefore`
/// (the focused composer's caret range), plus a bare focused `<edit>` tree.
fn discord_flat_stream() -> WindowContextSnapshot {
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
    WindowContextSnapshot {
        window_title: "(1153) Discord | @Fancy - Google Chrome".into(),
        element_name: "Message @Fancy".into(),
        app_exe: Some("chrome.exe".into()),
        text_before: Some(text_before.into()),
        ax_html: Some(
            "<window name=\"Discord\"><edit name=\"Message @Fancy\" focus=\"1\"/></window>".into(),
        ),
        ..snap()
    }
}

/// Discord — a structured message tree (per-author `<item>` nodes) exposed in
/// axHtml, with server/member nav rails to prune.
fn discord_tree() -> WindowContextSnapshot {
    WindowContextSnapshot {
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
    }
}

/// X (Twitter) reply — the flat `<doc>` conversation blob (no per-tweet nodes),
/// composer as a sibling `<edit>`.
fn x_reply_blob() -> WindowContextSnapshot {
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
    WindowContextSnapshot {
        window_title: "Andrew Trask on X - Google Chrome".into(),
        element_name: "Post text".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://x.com/iamtrask/status/1".into()),
        ax_html: Some(format!(
            r#"<pane name="X"><doc name="Conversation">{doc}</doc><edit name="Post text" focus="1"></edit></pane>"#
        )),
        ..snap()
    }
}

/// Facebook Messenger — the flat `<doc>` blob embedding authorship as
/// `… Message sent <when> by <Author>: <body>` markers.
fn messenger_by_author_blob() -> WindowContextSnapshot {
    WindowContextSnapshot {
        window_title: "Messenger | Facebook - Google Chrome".into(),
        element_name: "Write to موه".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://www.messenger.com/t/100087".into()),
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
    }
}

/// AI chat (ChatGPT/Claude/Gemini) — alternating `You said:` / `<Assistant>
/// said:` role blocks flattened into one `<doc>` blob.
fn ai_chat_role_blob() -> WindowContextSnapshot {
    let doc = "ChatGPT You said: How do I reverse a string in Rust? \
        ChatGPT said: Call chars rev collect on the input. \
        You said: Does that handle Unicode correctly? \
        ChatGPT said: It reverses by Unicode scalar values so most text is fine.";
    WindowContextSnapshot {
        window_title: "ChatGPT - Google Chrome".into(),
        element_name: "Ask anything".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://chatgpt.com/c/abc".into()),
        ax_html: Some(format!(
            r#"<window name="ChatGPT"><doc name="ChatGPT" focus="1">{doc}</doc></window>"#
        )),
        ..snap()
    }
}

/// Gmail reply — a page-spanning caret range in `textBefore` that leaks the
/// inbox list + nav, plus the reading-pane tree in axHtml.
fn gmail_reply() -> WindowContextSnapshot {
    let text_before = "\
Inbox
Compose
Snoozed
Drafts
Promotions
10:24 AM
Team standup notes and the release checklist…
9:15 AM
Your invoice is ready…
Jun 12
Weekly digest…
On Mon, Jun 15, 2026, Dana Lee wrote:
Hi there, following up on the release checklist — can we confirm the signing step is done before we ship tonight?
Thanks,
Dana";
    WindowContextSnapshot {
        window_title: "Inbox (3) - me@example.com - Gmail - Google Chrome".into(),
        element_name: "Message Body".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://mail.google.com/mail/u/0/".into()),
        text_before: Some(text_before.into()),
        ax_html: Some(
            r#"<pane name="Gmail">
              <list name="Navigation"><item name="Inbox"/><item name="Compose"/></list>
              <doc name="Conversation">
                <group name="Message"><text>On Mon, Jun 15, 2026, Dana Lee wrote:</text>
                  <text>Hi there, following up on the release checklist — can we confirm the signing step is done before we ship tonight?</text>
                </group>
              </doc>
              <edit name="Message Body" focus="1"></edit>
            </pane>"#
                .into(),
        ),
        ..snap()
    }
}

/// Outlook web — the entire mail app exposed as one structureless `<doc>` blob
/// (left rail + inbox list + open thread), with the same content in the
/// composer's `textBefore`.
fn outlook_mail_blob() -> WindowContextSnapshot {
    let text_before = "\
Navigation pane
Favorites
Inbox
Junk Email
Sent Items
Deleted Items
Sorted: By date
Focused
Other
10:24 AM
Acme Billing
Your invoice is ready…
9:15 AM
Dana Lee
Release checklist…
View with a light background
Reply
Reply all
Forward
To:
Hi team, the signing step is complete. Please confirm the final build is uploaded before tonight's release.
Regards,
Dana";
    WindowContextSnapshot {
        window_title: "Mail - me@example.com - Outlook - Google Chrome".into(),
        element_name: "Message body".into(),
        app_exe: Some("chrome.exe".into()),
        url: Some("https://outlook.office.com/mail/".into()),
        text_before: Some(text_before.into()),
        ax_html: Some(
            r#"<pane name="Outlook"><doc name="Mail">Navigation pane Favorites Inbox Junk Email Sent Items 10:24 AM Acme Billing Your invoice is ready… 9:15 AM Dana Lee Release checklist… View with a light background Reply Reply all Forward To: Hi team, the signing step is complete. Please confirm the final build is uploaded before tonight's release. Regards, Dana</doc><edit name="Message body" focus="1"></edit></pane>"#
                .into(),
        ),
        ..snap()
    }
}

/// A plain generic focused field — a short typed draft with app identity, no
/// conversation shape at all (the common dictation case).
fn generic_field() -> WindowContextSnapshot {
    WindowContextSnapshot {
        window_title: "Untitled - Notepad".into(),
        element_name: "Text editor".into(),
        app_exe: Some("notepad.exe".into()),
        text_before: Some("Draft of the release announcement. We are shipping the ".into()),
        text_after: Some(" build tonight after final tests.".into()),
        ..snap()
    }
}

/// The full fixture corpus, one entry per representative capture shape.
pub fn all_fixtures() -> Vec<ContextFixture> {
    vec![
        ContextFixture {
            name: "discord_flat_stream",
            kind: "discord",
            snapshot: discord_flat_stream(),
        },
        ContextFixture {
            name: "discord_tree",
            kind: "discord",
            snapshot: discord_tree(),
        },
        ContextFixture {
            name: "x_reply_blob",
            kind: "x",
            snapshot: x_reply_blob(),
        },
        ContextFixture {
            name: "messenger_by_author_blob",
            kind: "messenger",
            snapshot: messenger_by_author_blob(),
        },
        ContextFixture {
            name: "ai_chat_role_blob",
            kind: "ai_chat",
            snapshot: ai_chat_role_blob(),
        },
        ContextFixture {
            name: "gmail_reply",
            kind: "gmail",
            snapshot: gmail_reply(),
        },
        ContextFixture {
            name: "outlook_mail_blob",
            kind: "outlook",
            snapshot: outlook_mail_blob(),
        },
        ContextFixture {
            name: "generic_field",
            kind: "generic",
            snapshot: generic_field(),
        },
    ]
}
