// AUTO-GENERATED from the context-parser-app-profiles workflow (2026-05-30).
// 22 per-app UIA fixtures used as a regression harness for the Tier-3 pruner.
// These are SYNTHESIZED fixtures (idealized structure); the live per-app phase
// validates against REAL Context Playground captures. Do not hand-edit — re-run
// the workflow + regenerate. See context-parsing-roadmap.md.

export interface AppFixture {
	app: string;
	exampleAxHtml: string;
	exampleTextBefore: string;
	exe: string;
	expectedTier: number;
	focusedRole: string;
	idealAsrTail: string;
	idealLlmContext: string;
	surfaceType: string;
}

export const APP_FIXTURES: readonly AppFixture[] = [
	{
		app: "Gmail",
		exe: "chrome.exe",
		surfaceType: "webmail",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Inbox (3) - you@gmail.com - Gmail - Google Chrome">\n  <tabs name="Chrome tabs"><tab name="Inbox - Gmail" focus="0"/><tab name="Calendar"/></tabs>\n  <toolbar name="App Bar"><button name="Main menu"/><edit name="Search mail"/><button name="Settings"/></toolbar>\n  <pane name="Gmail">\n    <tree name="Mailbox folders"><node name="Inbox 3"/><node name="Starred"/><node name="Sent"/><node name="Drafts"/></tree>\n    <toolbar name="Toolbar"><button name="Archive"/><button name="Delete"/><button name="Mark as unread"/></toolbar>\n    <list name="Conversation list">\n      <item name="Sarah Lee, Re: Q3 roadmap — Can we push the review to Thursday?"/>\n      <item name="GitHub, [winstt] CI passed on main"/>\n      <item name="LinkedIn, You have 4 new notifications"/>\n    </list>\n    <doc name="Re: Q3 roadmap">\n      <group name="Message">\n        <text>Sarah Lee &lt;sarah@acme.com&gt;</text>\n        <text>to me</text>\n        <text>Hi — quick one before the review. Can we push the Q3 roadmap sync to Thursday 2pm? I want the metrics deck finalized first. Let me know if that works.</text>\n      </group>\n      <group name="Reply">\n        <text>To: Sarah Lee</text>\n        <edit name="Message Body" focus="1"></edit>\n        <toolbar name="Formatting options"><button name="Bold"/><button name="Send"/></toolbar>\n      </group>\n    </doc>\n  </pane>\n  <status name="1 of 1,284"/>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			'The email being replied to (Sarah Lee, Re: Q3 roadmap): "Hi — quick one before the review. Can we push the Q3 roadmap sync to Thursday 2pm? I want the metrics deck finalized first. Let me know if that works." plus the user\'s empty reply draft (Message Body). No inbox/conversation list, no folder tree, no search bar, no toolbars, no Chrome tab strip.',
		idealAsrTail: "",
	},
	{
		app: "Cursor",
		exe: "cursor.exe",
		surfaceType: "editor",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="index.ts — winstt — Cursor">\n  <toolbar name="App Actions"><button name="Minimize"/><button name="Close"/></toolbar>\n  <tabs name="Activity Bar"><tab name="Explorer"/><tab name="Search"/><tab name="Source Control"/><tab name="Cursor"/></tabs>\n  <pane name="Side Bar">\n    <tree name="Explorer">\n      <node name="src"><node name="main.ts"/><node name="index.ts"/></node>\n      <node name="package.json"/>\n    </tree>\n  </pane>\n  <group name="Editor Group">\n    <tabs name="Open Editors"><tab name="main.ts"/><tab name="index.ts" focus="0"/></tabs>\n    <toolbar name="Breadcrumbs"><link name="src"/><link name="index.ts"/></toolbar>\n    <doc name="index.ts">\n      <edit name="Editor content" focus="1">export function parseConfig(raw: string) {\n  const cfg = JSON.parse(raw);\n  return cfg;\n}</edit>\n      <text name="Minimap"/>\n    </doc>\n  </group>\n  <pane name="Cursor Chat">\n    <list name="Conversation">\n      <item name="You: explain parseConfig"/>\n      <item name="Assistant: parseConfig parses a JSON string into a config object."/>\n    </list>\n    <edit name="Ask Cursor"/>\n  </pane>\n  <pane name="Panel">\n    <tabs name="Panel Tabs"><tab name="Terminal"/><tab name="Problems"/></tabs>\n    <doc name="Terminal">PS E:\\winstt> bun dev</doc>\n  </pane>\n  <status name="Status Bar"><text name="Ln 2, Col 3"/><text name="TypeScript"/></status>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"export function parseConfig(raw: string) {\n  const cfg = JSON.parse(raw);\n  return cfg;\n}",
		idealAsrTail: "return cfg;\n}",
	},
	{
		app: "Visual Studio Code",
		exe: "code.exe",
		surfaceType: "editor",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="server.ts — winstt — Visual Studio Code">\n  <toolbar name="Activity Bar">\n    <button name="Explorer"/><button name="Search"/><button name="Source Control"/><button name="Run and Debug"/><button name="Extensions"/>\n  </toolbar>\n  <tree name="Explorer: WINSTT">\n    <node name="frontend"/><node name="server"/>\n    <node name="electron"><node name="main.ts"/><node name="server.ts"/></node>\n    <node name="package.json"/><node name="README.md"/>\n  </tree>\n  <group name="Editor Group">\n    <tabs name="Open editors">\n      <tab name="main.ts"/><tab name="server.ts" focus="0"/><tab name="package.json"/>\n    </tabs>\n    <toolbar name="Breadcrumbs"><button name="winstt"/><button name="electron"/><button name="server.ts"/></toolbar>\n    <doc name="server.ts">\n      <edit name="server.ts editor" focus="1">export function startServer(port: number) {\n  const wss = new WebSocketServer({ port });\n  wss.on("connection", (socket) => {\n    // TODO: handle the control vs binary channel split here\n  });\n  return wss;\n}</edit>\n    </doc>\n  </group>\n  <group name="Panel">\n    <tabs name="Panel"><tab name="Problems"/><tab name="Output"/><tab name="Terminal"/></tabs>\n  </group>\n  <status name="Status Bar">\n    <button name="main*"/><text>Ln 14, Col 3</text><button name="Spaces: 2"/><button name="UTF-8"/><button name="TypeScript"/>\n  </status>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			'The server.ts editor body the user is editing:\n\nexport function startServer(port: number) {\n  const wss = new WebSocketServer({ port });\n  wss.on("connection", (socket) => {\n    // TODO: handle the control vs binary channel split here\n  });\n  return wss;\n}',
		idealAsrTail: "    // TODO: handle the control vs binary channel split here",
	},
	{
		app: "Discord",
		exe: "discord.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="#general | My Server - Discord"><group name="Servers sidebar"><toolbar name="Servers"><button name="My Server">MS</button><button name="Game Hub">GH</button><button name="Add a Server">+</button></toolbar></group><group name="Channels"><tree name="Channels"><node name="TEXT CHANNELS"><node name="general"># general</node><node name="random"># random</node></node></tree><button name="Mute">Mute</button><button name="Deafen">Deafen</button></group><group name="Messages"><list name="Messages in general"><item name="alice"><text>alice</text><text>Today at 2:14 PM</text><text>can someone review the deploy script before we ship?</text></item><item name="bob"><text>bob</text><text>Today at 2:16 PM</text><text>I looked at it earlier, the rollback step is missing a guard</text></item></list><toolbar name="Message actions"><button name="Add reaction">😀</button><button name="Reply">Reply</button></toolbar><group name="Message composer"><button name="Upload a file">+</button><edit name="Message #general" focus="1"></edit><button name="Open emoji picker">😀</button><button name="Open GIF picker">GIF</button></group></group><list name="Members"><item name="alice">alice</item><item name="bob">bob</item></list><status name="Connection">Voice Connected</status></window>',
		exampleTextBefore: "",
		idealLlmContext:
			'The recent conversation the user is replying to (the message thread being acted on):\nalice: can someone review the deploy script before we ship?\nbob: I looked at it earlier, the rollback step is missing a guard\n\nThe user\'s draft in the "Message #general" composer is empty (they are dictating a new message).',
		idealAsrTail: "",
	},
	{
		app: "Messenger (messenger.com / Facebook Messages in Chrome)",
		exe: "chrome.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Messenger - Google Chrome">\n<group name="Browser chrome">\n<toolbar name="App Bar">\n<edit name="Address and search bar">messenger.com/t/100087</edit>\n<button name="Reload">Reload</button>\n<button name="Bookmarks">Bookmark this tab</button>\n</toolbar>\n<tabs name="Tab strip"><tab name="Messenger">Messenger</tab></tabs>\n</group>\n<doc name="Messenger">\n<group name="Navigation rail">\n<button name="Chats">Chats</button>\n<button name="Marketplace">Marketplace</button>\n<button name="Settings">Settings</button>\n</group>\n<list name="Conversation list">\n<item name="Alex Rivera">Alex Rivera. you: sounds good. 2h</item>\n<item name="Maya Chen">Maya Chen. Are we still on for Friday? 5m</item>\n<item name="Design Team">Design Team. Priya: shipped it. 1d</item>\n</list>\n<group name="Message thread">\n<toolbar name="Conversation actions">\n<button name="Call">Audio call</button>\n<button name="Video">Video call</button>\n<button name="Conversation information">Details</button>\n</toolbar>\n<list name="Messages in conversation with Maya Chen">\n<item name="Maya Chen">Hey, are we still on for Friday\'s standup?</item>\n<item name="Maya Chen">I can move it to 10 if that works better for you.</item>\n<item name="You">let me check my calendar</item>\n<item name="Maya Chen">No rush! Just let me know by tonight.</item>\n</list>\n<edit name="Message" focus="1"></edit>\n<toolbar name="Composer actions">\n<button name="Add files">Attach a file</button>\n<button name="Choose a sticker">Sticker</button>\n<button name="Send a like">Like</button>\n</toolbar>\n</group>\n</doc>\n<status name="Notifications">1 new notification</status>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Conversation with Maya Chen:\nMaya Chen: Hey, are we still on for Friday's standup?\nMaya Chen: I can move it to 10 if that works better for you.\nYou: let me check my calendar\nMaya Chen: No rush! Just let me know by tonight.\n\n[Draft message box is empty — user is composing a reply.]",
		idealAsrTail: "",
	},
	{
		app: "Outlook (desktop)",
		exe: "outlook.exe",
		surfaceType: "webmail",
		expectedTier: 3,
		focusedRole: "doc",
		exampleAxHtml:
			'<window name="Inbox - you@contoso.com - Outlook">\n  <pane name="Ribbon">\n    <toolbar name="Home">\n      <button name="New mail"/><button name="Delete"/><button name="Archive"/>\n      <button name="Reply"/><button name="Reply all"/><button name="Forward"/>\n    </toolbar>\n  </pane>\n  <tree name="Folder Pane">\n    <node name="Favorites"><node name="Inbox 12"/><node name="Sent Items"/></node>\n    <node name="you@contoso.com"><node name="Inbox"/><node name="Drafts 3"/><node name="Archive"/></node>\n  </tree>\n  <list name="Message list">\n    <item name="Maria Chen — Q3 budget review — Can we move the sync? — 9:14 AM"/>\n    <item name="GitHub — [winstt] CI failed on main — 8:02 AM"/>\n    <item name="Maria Chen — Re: Q3 budget review — Thanks, see notes — Yesterday"/>\n  </list>\n  <pane name="Reading pane">\n    <group name="Conversation">\n      <text name="Subject">Re: Q3 budget review</text>\n      <text name="From">Maria Chen &lt;maria@contoso.com&gt;</text>\n      <doc name="Message body">Hi, thanks for the draft. Can we push the budget sync to Thursday 2pm? I also need the updated headcount numbers before the finance review. Let me know if that works.</doc>\n      <group name="Compose">\n        <edit name="To"/>\n        <doc name="Message body" focus="1"></doc>\n      </group>\n    </group>\n  </pane>\n  <toolbar name="Quick actions"><button name="Send"/><button name="Discard"/><button name="Attach file"/></toolbar>\n  <status name="Status bar">All folders are up to date. Connected to: Microsoft Exchange</status>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			'Email being replied to (from Maria Chen, "Re: Q3 budget review"): "Hi, thanks for the draft. Can we push the budget sync to Thursday 2pm? I also need the updated headcount numbers before the finance review. Let me know if that works." User\'s draft reply: (empty).',
		idealAsrTail: "",
	},
	{
		app: "Slack",
		exe: "slack.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Slack | general (Channel) | Acme Workspace">\n  <toolbar name="Workspaces">\n    <button name="Acme Workspace"/><button name="Add workspaces"/>\n  </toolbar>\n  <toolbar name="History">\n    <button name="Back"/><button name="Forward"/>\n    <combo name="Search Acme Workspace"/><button name="Help"/>\n  </toolbar>\n  <tree name="Channels">\n    <node name="Threads"/><node name="Huddles"/><node name="Drafts &amp; sent"/>\n    <node name="# general"/><node name="# random"/><node name="# eng-standup"/>\n    <node name="Direct messages"/><node name="Dana Lee 2"/><node name="Sam Ortiz"/>\n  </tree>\n  <pane name="general">\n    <toolbar name="Channel header">\n      <button name="general details"/><button name="Add people"/>\n      <button name="Huddle"/><button name="Pinned items"/>\n    </toolbar>\n    <list name="Messages">\n      <item><text name="Dana Lee">Dana Lee</text><text>11:02 AM</text>\n        <text>Can someone send the Q3 numbers before the 2pm sync?</text></item>\n      <item><text name="Sam Ortiz">Sam Ortiz</text><text>11:05 AM</text>\n        <text>I have them, finalizing the deck now.</text></item>\n      <item><text name="Dana Lee">Dana Lee</text><text>11:06 AM</text>\n        <text>Great, can you post the revenue and churn lines here?</text></item>\n    </list>\n    <group name="Message input">\n      <toolbar name="Formatting"><button name="Bold"/><button name="Italic"/></toolbar>\n      <edit name="Message to #general" focus="1"></edit>\n      <toolbar name="Composer actions">\n        <button name="Attach"/><button name="Emoji"/><button name="Send"/>\n      </toolbar>\n    </group>\n  </pane>\n  <status name="Connected"/>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Recent #general conversation the user is replying to:\nDana Lee: Can someone send the Q3 numbers before the 2pm sync?\nSam Ortiz: I have them, finalizing the deck now.\nDana Lee: Great, can you post the revenue and churn lines here?\n\nUser's draft (Message to #general): (empty)",
		idealAsrTail: "Great, can you post the revenue and churn lines here?",
	},
	{
		app: "Snapchat",
		exe: "snapchat.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Snapchat">\n  <toolbar name="App Controls"><button name="Minimize"/><button name="Close"/></toolbar>\n  <pane name="Navigation">\n    <button name="Camera"/><button name="Chat" focus="0"/><button name="Stories"/>\n    <button name="Spotlight"/><button name="Profile"/>\n  </pane>\n  <list name="Friends">\n    <item name="Alex Rivera">You: see you then</item>\n    <item name="Mom">Call me when you land</item>\n    <item name="Jess &amp; Sam">Jess: lol that snap</item>\n    <item name="Diego">Diego: 3 New Chats</item>\n  </list>\n  <pane name="Conversation: Alex Rivera">\n    <toolbar name="Chat Header"><button name="Call"/><button name="Video"/><button name="Info"/></toolbar>\n    <list name="Messages">\n      <item name="Alex Rivera"><text>are we still on for dinner saturday?</text></item>\n      <item name="Alex Rivera"><text>thinking that new ramen place downtown</text></item>\n      <item name="Me"><text>yeah saturday works</text></item>\n      <item name="Alex Rivera"><text>cool what time should i book?</text></item>\n    </list>\n    <group name="Composer">\n      <button name="Camera"/>\n      <edit name="Send a chat" focus="1"></edit>\n      <button name="Sticker"/><button name="Send"/>\n    </group>\n  </pane>\n  <status name="Connection">Connected</status>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Conversation with Alex Rivera:\nAlex Rivera: are we still on for dinner saturday?\nAlex Rivera: thinking that new ramen place downtown\nMe: yeah saturday works\nAlex Rivera: cool what time should i book?\n[draft / Send a chat: (empty)]",
		idealAsrTail: "",
	},
	{
		app: "Microsoft Teams",
		exe: "ms-teams.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Chat | Microsoft Teams">\n  <toolbar name="App bar">\n    <tab name="Activity"/><tab name="Chat"/><tab name="Teams"/>\n    <tab name="Calendar"/><tab name="Calls"/>\n  </toolbar>\n  <combo name="Search"/>\n  <pane name="Chat list">\n    <list name="Recent">\n      <item name="Priya Nair  Sounds good, see you then"/>\n      <item name="Design Crew  Mark shared a file"/>\n      <item name="Tomasz K  Can you review the PR?"/>\n    </list>\n  </pane>\n  <pane name="Conversation">\n    <header name="Tomasz K"><button name="Call"/><button name="Video"/></header>\n    <list name="Messages">\n      <group name="Tomasz K, 9:14 AM">\n        <text>Can you review the PR before standup? It touches the auth refactor.</text>\n        <toolbar name="Message actions"><button name="React"/><button name="Reply"/><button name="More options"/></toolbar>\n      </group>\n      <group name="Tomasz K, 9:15 AM">\n        <text>No rush if you\'re heads-down, just want it merged by EOD.</text>\n      </group>\n    </list>\n    <toolbar name="Formatting">\n      <button name="Bold"/><button name="Italic"/><button name="Attach"/><button name="Emoji"/>\n    </toolbar>\n    <edit name="Type a message" focus="1"></edit>\n    <button name="Send"/>\n  </pane>\n  <pane name="Roster">\n    <list name="Members"><item name="Tomasz K"/><item name="You"/></list>\n  </pane>\n  <status name="Available"/>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			'Conversation with Tomasz K:\nTomasz K (9:14 AM): Can you review the PR before standup? It touches the auth refactor.\nTomasz K (9:15 AM): No rush if you\'re heads-down, just want it merged by EOD.\n\n[user draft — empty compose box "Type a message"]',
		idealAsrTail: "",
	},
	{
		app: "Telegram Desktop",
		exe: "telegram.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Telegram"><pane name="Navigation"><toolbar name="Main menu"><button name="Menu"/><button name="Search"/></toolbar><list name="Chats"><item name="Saved Messages">You: meeting notes</item><item name="Alex Rivera">Alex: sounds good, let\'s ship it</item><item name="Design Team">Mara: pushed the new mockups</item><item name="Mom">photo</item></list></pane><pane name="Alex Rivera"><toolbar name="Chat actions"><button name="Search messages"/><button name="Call"/><button name="More"/></toolbar><list name="Message list"><item name="Alex Rivera"><text>Can you send over the Q3 deck before the 3pm sync?</text></item><item name="You"><text>yeah one sec</text></item><item name="Alex Rivera"><text>also did legal sign off on the pricing slide?</text></item></list><group name="Composer"><edit name="Write a message" focus="1"></edit><toolbar name="Compose actions"><button name="Attach"/><button name="Emoji"/><button name="Voice message"/></toolbar></group></pane><status name="Connecting...">online</status></window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Conversation with Alex Rivera:\nAlex Rivera: Can you send over the Q3 deck before the 3pm sync?\nYou: yeah one sec\nAlex Rivera: also did legal sign off on the pricing slide?\n\n(Your draft reply box is empty.)",
		idealAsrTail: "also did legal sign off on the pricing slide?",
	},
	{
		app: "WhatsApp Desktop",
		exe: "whatsapp.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="WhatsApp">\n  <toolbar name="Title bar"><button name="Minimize"/><button name="Close"/></toolbar>\n  <pane name="Navigation">\n    <tabs name="Sections"><tab name="Chats"/><tab name="Status"/><tab name="Channels"/><tab name="Settings"/></tabs>\n  </pane>\n  <pane name="Chat list">\n    <edit name="Search or start a new chat"/>\n    <list name="Chats">\n      <item name="Sarah Chen. Sounds good, talk tomorrow. 9:42 AM. 2 unread"/>\n      <item name="Mom. Did you eat? 8:15 AM"/>\n      <item name="Work Group. Alex: pushed the build. Yesterday"/>\n    </list>\n  </pane>\n  <pane name="Conversation">\n    <header name="Sarah Chen, online">\n      <button name="Video call"/><button name="Voice call"/><button name="Search"/><button name="Menu"/>\n    </header>\n    <list name="Messages">\n      <group name="Sarah Chen">\n        <text>Hey, are we still on for the demo on Thursday?</text>\n        <text>I can move it to 2pm if that\'s easier for you.</text>\n      </group>\n      <group name="You">\n        <text>Thursday works, let me confirm the room.</text>\n      </group>\n    </list>\n    <toolbar name="Composer actions"><button name="Emoji"/><button name="Attach"/><button name="Voice message"/></toolbar>\n    <doc name="Type a message" focus="1"></doc>\n  </pane>\n  <status name="WhatsApp is up to date"/>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Conversation with Sarah Chen:\nSarah Chen: Hey, are we still on for the demo on Thursday?\nSarah Chen: I can move it to 2pm if that's easier for you.\nYou: Thursday works, let me confirm the room.\n\n[user is composing a reply in an empty message box]",
		idealAsrTail: "Thursday works, let me confirm the room.",
	},
	{
		app: "x.com (Twitter)",
		exe: "chrome.exe",
		surfaceType: "social",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Home / X — Google Chrome">\n  <toolbar name="Chrome">\n    <edit name="Address and search bar">x.com/home</edit>\n    <button name="Bookmark this tab"/>\n  </toolbar>\n  <pane name="Browser content">\n    <group name="Primary column">\n      <list name="Primary">\n        <link name="Home"/>\n        <link name="Explore"/>\n        <link name="Notifications"/>\n        <link name="Messages"/>\n        <link name="Profile"/>\n        <button name="Post"/>\n      </list>\n      <tabs name="Timeline tabs">\n        <tab name="For you"/>\n        <tab name="Following"/>\n      </tabs>\n      <list name="Timeline: Conversation">\n        <article name="Post">\n          <group name="Author">\n            <text>Jane Dev</text><text>@jane_dev</text>\n          </group>\n          <text>Hot take: tabs beat spaces and it\'s not close. Fight me in the replies.</text>\n          <group name="Engagement">\n            <button name="Reply"/><button name="Repost"/><button name="Like"/>\n          </group>\n        </article>\n        <group name="Reply composer">\n          <text>Replying to @jane_dev</text>\n          <edit name="Post your reply" focus="1"></edit>\n          <toolbar name="Add to post">\n            <button name="Add photos or video"/>\n            <button name="Add emoji"/>\n            <button name="Schedule post"/>\n          </toolbar>\n          <button name="Reply"/>\n        </group>\n      </list>\n    </group>\n    <group name="Sidebar column">\n      <list name="What\'s happening">\n        <item><text>#TypeScript</text><text>42.1K posts</text></item>\n        <item><text>Trending in Tech</text></item>\n      </list>\n      <list name="Who to follow">\n        <item><text>@some_account</text><button name="Follow"/></item>\n      </list>\n    </group>\n    <status name="Timeline notice"/>\n  </pane>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Replying to @jane_dev — Jane Dev (@jane_dev): \"Hot take: tabs beat spaces and it's not close. Fight me in the replies.\"\n\n[User's draft reply — empty]",
		idealAsrTail: "",
	},
	{
		app: "OneNote",
		exe: "onenote.exe",
		surfaceType: "doc",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="My Notebook - OneNote">\n  <toolbar name="Ribbon">\n    <tab name="Home" focus="0"/><tab name="Insert"/><tab name="Draw"/><tab name="View"/>\n    <button name="Bold"/><button name="Bullets"/><button name="To Do Tag"/>\n  </toolbar>\n  <tabs name="Section Tabs">\n    <tab name="Quick Notes"/><tab name="Project Apollo"/><tab name="Meetings"/>\n  </tabs>\n  <pane name="Navigation">\n    <tree name="Notebooks">\n      <node name="My Notebook"><node name="Project Apollo"/><node name="Meetings"/></node>\n    </tree>\n    <list name="Page List">\n      <item name="Kickoff notes"/><item name="Weekly sync 5/28"/><item name="Action items"/>\n    </list>\n  </pane>\n  <pane name="Page Canvas">\n    <edit name="Title">Weekly sync 5/28</edit>\n    <text>Thursday, May 28, 2026  3:14 PM</text>\n    <group name="Outline">\n      <edit>Attendees: Sarah, Mike, Priya. Sarah will own the migration plan.</edit>\n      <edit name="Body" focus="1"></edit>\n    </group>\n    <group name="Outline">\n      <edit>Parking lot: revisit the caching layer next sprint.</edit>\n    </group>\n  </pane>\n  <status name="Status Bar"><text>Synced</text><button name="Zoom"/></status>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Title: Weekly sync 5/28\nThursday, May 28, 2026 3:14 PM\nAttendees: Sarah, Mike, Priya. Sarah will own the migration plan.\nParking lot: revisit the caching layer next sprint.\n[user draft dictated here into the empty focused body outline]",
		idealAsrTail: "Attendees: Sarah, Mike, Priya. Sarah will own the migration plan.",
	},
	{
		app: "Canva",
		exe: "chrome.exe",
		surfaceType: "canvas",
		expectedTier: 5,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Untitled design - Canva - Google Chrome">\n  <tabs name="Chrome tabs">\n    <tab name="Untitled design - Canva" focus="0"/>\n    <tab name="New Tab"/>\n  </tabs>\n  <toolbar name="Address and search bar">\n    <edit name="Address and search bar">canva.com/design/DAF.../edit</edit>\n    <button name="Bookmark this tab"/>\n  </toolbar>\n  <pane name="Canva">\n    <toolbar name="Top bar">\n      <button name="Home"/>\n      <button name="File"/>\n      <button name="Resize"/>\n      <button name="Undo"/>\n      <button name="Redo"/>\n      <button name="Share"/>\n    </toolbar>\n    <list name="Side panel">\n      <item name="Design"/>\n      <item name="Elements"/>\n      <item name="Text"/>\n      <item name="Brand"/>\n      <item name="Uploads"/>\n      <item name="Apps"/>\n    </list>\n    <toolbar name="Element toolbar">\n      <combo name="Font">Canva Sans</combo>\n      <combo name="Font size">24</combo>\n      <button name="Text color"/>\n      <button name="Bold"/>\n      <button name="Align"/>\n    </toolbar>\n    <pane name="Editing canvas" focus="1">\n      <image name="Page 1 design"/>\n    </pane>\n    <list name="Pages">\n      <item name="Page 1"/>\n      <button name="Add page"/>\n    </list>\n    <status name="Zoom">75%</status>\n  </pane>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"The Canva design canvas content is not exposed via UIA (canvas-rendered). The LLM should receive the OCR'd text of the focused page/text element plus the user's spoken draft, e.g. the headline text being edited on the slide. No toolbar, side-panel, or browser-chrome strings should ever reach the LLM. If OCR is unavailable, the LLM gets only the user's dictation with no app context.",
		idealAsrTail: "",
	},
	{
		app: "ChatGPT (web app in Chrome)",
		exe: "chrome.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="ChatGPT - Google Chrome">\n<pane name="Chrome">\n<tabs><tab name="ChatGPT" focus="0"/><tab name="Gmail"/></tabs>\n<toolbar name="Bookmarks"><button name="Reload"/><edit name="Address and search bar">chatgpt.com/c/abc123</edit></toolbar>\n</pane>\n<pane name="ChatGPT">\n<tree name="Chat history">\n<node name="New chat"/>\n<list name="Conversations">\n<item name="Refactor recorder pipeline"/>\n<item name="WinSTT release notes"/>\n<item name="Trip to Kyoto itinerary"/>\n</list>\n</tree>\n<group name="ChatGPT conversation">\n<group name="You said">\n<text>Explain how ONNX Runtime DirectML picks an execution provider.</text>\n</group>\n<group name="ChatGPT said">\n<text>ORT enumerates registered execution providers in priority order. On Windows the DirectML EP probes for a D3D12-capable adapter; if none is viable it falls through to the CPU EP. You can override the order at session-create time.</text>\n</group>\n</group>\n<toolbar name="Message actions"><button name="Copy"/><button name="Good response"/><button name="Bad response"/></toolbar>\n<edit name="Message ChatGPT" focus="1"></edit>\n<button name="Send prompt"/>\n<text name="disclaimer">ChatGPT can make mistakes. Check important info.</text>\n</pane>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"ChatGPT said: ORT enumerates registered execution providers in priority order. On Windows the DirectML EP probes for a D3D12-capable adapter; if none is viable it falls through to the CPU EP. You can override the order at session-create time.\n\n[user draft: empty]",
		idealAsrTail: "",
	},
	{
		app: "claude.ai",
		exe: "chrome.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Claude - claude.ai - Google Chrome"><pane name="Chrome"><toolbar name="App"><button name="Back"/><edit name="Address and search bar">claude.ai/chat/abc-123</edit><button name="Account"/></toolbar><tabs><tab name="Claude" focus="0"/><tab name="Gmail"/></tabs></pane><pane name="claude.ai"><group name="sidebar"><button name="New chat"/><link name="Chats"/><link name="Projects"/><list name="Recents"><item>Fix the pruner regex</item><item>STT catalog plan</item><item>Invoice draft</item></list></group><group name="main"><header><text>Tier 3 pruner design</text><combo name="Model">Claude Opus 4.8</combo><button name="Share"/></header><group name="conversation"><group name="message"><text name="user">What roles should I keep?</text></group><group name="message"><text name="assistant">For a chat surface, keep the conversation transcript and the draft composer. Drop the nav rail, recents list, model picker, and the send toolbar. Want me to write the keepRoles list?</text></group></group><edit name="Write your reply to Claude" focus="1"></edit><toolbar name="composer"><button name="Attach"/><button name="Tools"/><button name="Send"/></toolbar></group></pane><status name="Ready"/></window>',
		exampleTextBefore: "",
		idealLlmContext:
			'Last assistant message (what the user is replying to): "For a chat surface, keep the conversation transcript and the draft composer. Drop the nav rail, recents list, model picker, and the send toolbar. Want me to write the keepRoles list?" + the user\'s draft from the focused composer (empty at dictation start; the dictated text will be inserted here).',
		idealAsrTail: "",
	},
	{
		app: "Zoom",
		exe: "zoom.exe",
		surfaceType: "chat",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Zoom Meeting">\n  <toolbar name="Meeting Controls">\n    <button name="Mute"/><button name="Start Video"/><button name="Participants"/>\n    <button name="Chat"/><button name="Share Screen"/><button name="Record"/>\n    <button name="Reactions"/><button name="More"/><button name="End"/>\n  </toolbar>\n  <pane name="Gallery View"><pane name="Video Tile Alex"/><pane name="Video Tile You"/></pane>\n  <pane name="Participants">\n    <list name="Participants (3)">\n      <item name="Alex Rivera (Host)"/><item name="Priya Shah"/><item name="You"/>\n    </list>\n  </pane>\n  <pane name="Chat">\n    <tabs name="Chat Tabs"><tab name="Chat"/><tab name="Files"/></tabs>\n    <list name="Chat Messages">\n      <group name="Alex Rivera 10:02 AM">\n        <text>Can you send me the Q3 numbers before we wrap up?</text>\n      </group>\n      <group name="Priya Shah 10:03 AM">\n        <text>I have the deck open, sharing now.</text>\n      </group>\n      <group name="Alex Rivera 10:04 AM">\n        <text>Thanks. Also who owns the migration timeline?</text>\n      </group>\n    </list>\n    <combo name="To:"><text>Everyone</text></combo>\n    <edit name="Type message here..." focus="1"></edit>\n    <toolbar name="Chat Actions"><button name="Emoji"/><button name="File"/><button name="Send"/></toolbar>\n  </pane>\n  <status name="Recording in progress 00:42:11"/>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Chat conversation being replied to:\nAlex Rivera 10:02 AM: Can you send me the Q3 numbers before we wrap up?\nPriya Shah 10:03 AM: I have the deck open, sharing now.\nAlex Rivera 10:04 AM: Thanks. Also who owns the migration timeline?\n\nUser draft (empty — composing now).",
		idealAsrTail: "",
	},
	{
		app: "Google Sheets",
		exe: "chrome.exe",
		surfaceType: "grid",
		expectedTier: 5,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Untitled spreadsheet - Google Sheets - Google Chrome">\n  <pane name="Chrome">\n    <tabs name="Browser tabs"><tab name="Untitled spreadsheet">Untitled spreadsheet</tab><tab name="Inbox (3)">Inbox (3)</tab></tabs>\n    <toolbar name="App bar"><edit name="Address and search bar">docs.google.com/spreadsheets/d/abc123/edit</edit><button name="Bookmark this tab"></button></toolbar>\n    <toolbar name="Bookmarks"><link name="Gmail">Gmail</link><link name="Drive">Drive</link></toolbar>\n  </pane>\n  <pane name="Untitled spreadsheet">\n    <menu name="Menu bar"><menuitem name="File">File</menuitem><menuitem name="Edit">Edit</menuitem><menuitem name="Insert">Insert</menuitem></menu>\n    <toolbar name="Document toolbar"><button name="Undo"></button><button name="Bold"></button><combo name="Font size">10</combo></toolbar>\n    <toolbar name="Formula bar"><text name="Name box">A1</text><edit name="Cell content" focus="1"></edit></toolbar>\n    <pane name="Grid">\n      <image name="Spreadsheet canvas"></image>\n      <header name="Column headers"><text>A</text><text>B</text><text>C</text></header>\n      <header name="Row headers"><text>1</text><text>2</text><text>3</text></header>\n    </pane>\n    <tabs name="Sheet tabs"><tab name="Sheet1">Sheet1</tab><button name="Add sheet"></button></tabs>\n    <status name="Sum">Sum: 0</status>\n  </pane>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			"The visible grid content the user is acting on — the active cell reference (e.g. A1) and the surrounding cell values/headers — plus the user's spoken draft. Because the grid is canvas-rendered, this must come from OCR of the grid region, not the UIA tree (the tree exposes only an empty cell-edit field). No menu bar, document/formula toolbar, sheet tabs, browser frame, bookmark bar, or status bar.",
		idealAsrTail: "",
	},
	{
		app: "GitHub",
		exe: "chrome.exe",
		surfaceType: "editor",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Issue: Crash on startup · acme/widget · GitHub — Google Chrome">\n  <toolbar name="Browser tabs"><tab name="Issue · acme/widget"/></toolbar>\n  <edit name="Address and search bar">github.com/acme/widget/issues/482</edit>\n  <header name="Global">\n    <link name="GitHub Home"/><edit name="Search or jump to…"/>\n    <button name="Notifications"/><button name="Create new"/><button name="Open user account menu"/>\n  </header>\n  <toolbar name="Repository"><tabs name="repo nav"><tab name="Code"/><tab name="Issues" focus="0"/><tab name="Pull requests"/><tab name="Actions"/><tab name="Settings"/></tabs></toolbar>\n  <pane name="content">\n    <group name="issue header"><text>Crash on startup #482</text><text>Open</text></group>\n    <list name="Timeline">\n      <item name="comment"><group name="alice commented">\n        <doc name="comment body">The app crashes on launch with "missing model.onnx". Repro: fresh install, click Record. Happens only on the DirectML build, not CPU.</doc>\n      </group></item>\n      <item name="comment"><group name="bob commented"><doc name="comment body">Can you attach the log from %APPDATA%\\WinSTT\\logs?</doc></group></item>\n    </list>\n    <group name="add a comment">\n      <toolbar name="Markdown formatting"><button name="Bold"/><button name="Italic"/><button name="Add a link"/><button name="Attach files"/></toolbar>\n      <edit name="Comment body" focus="1"></edit>\n      <button name="Close issue"/><button name="Comment"/>\n    </group>\n  </pane>\n  <list name="metadata">\n    <item><text>Assignees</text><link name="alice"/></item>\n    <item><text>Labels</text><link name="bug"/><link name="directml"/></item>\n    <item><text>Projects</text></item><item><text>Milestone</text></item>\n  </list>\n  <status name="footer">© 2026 GitHub, Inc.</status>\n</window>',
		exampleTextBefore: "",
		idealLlmContext:
			'Issue #482 "Crash on startup" (Open).\nalice commented: The app crashes on launch with "missing model.onnx". Repro: fresh install, click Record. Happens only on the DirectML build, not CPU.\nbob commented: Can you attach the log from %APPDATA%\\WinSTT\\logs?\n[User is composing a reply in the empty Comment body field.]',
		idealAsrTail: "",
	},
	{
		app: "Figma",
		exe: "figma.exe",
		surfaceType: "canvas",
		expectedTier: 5,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Untitled - Figma"><toolbar name="Main menu"><button name="Main menu"/><button name="Move tool"/><button name="Frame"/><button name="Pen"/><button name="Text"/><button name="Share"/><button name="Present"/></toolbar><pane name="Left sidebar"><tabs name="Panels"><tab name="File"/><tab name="Assets"/></tabs><tree name="Layers"><node name="Page 1"><node name="Frame 1"><node name="Hero heading"/><node name="CTA button"/></node></node></tree></pane><pane name="Canvas"><group name="Figma Canvas"><image name="WebGL canvas"/><edit focus="1" name="Text layer editor"></edit></group></pane><pane name="Right sidebar"><tabs name="Inspect"><tab name="Design"/><tab name="Prototype"/></tabs><group name="Typography"><combo name="Font family"/><edit name="Size">24</edit><combo name="Weight"/></group><group name="Fill"><button name="Add fill"/><edit name="Hex">FFFFFF</edit></group><group name="Comments"><edit name="Add a comment"></edit></group></pane><status name="Zoom 100%"/></window>',
		exampleTextBefore: "",
		idealLlmContext:
			"(empty — Figma's canvas and in-canvas text editor expose no readable UIA text; the LLM should receive only the user's dictated draft. If a comment field or properties field is the focus and yields text, just that field's content, no panels/toolbar/layers.)",
		idealAsrTail: "",
	},
	{
		app: "Instagram",
		exe: "chrome.exe",
		surfaceType: "social",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Instagram - Google Chrome"><pane name="Chrome"><toolbar name="App"><edit name="Address and search bar">instagram.com/direct/inbox</edit><button name="Back"/><button name="Reload"/></toolbar><tabs><tab name="Instagram"/></tabs></pane><doc name="Instagram"><pane name="Navigation"><link name="Home"/><link name="Search"/><link name="Explore"/><link name="Reels"/><link name="Messages"/><link name="Notifications"/><link name="Create"/><link name="Profile"/></pane><list name="Conversations"><item name="alex_m · 2h">Sounds good, see you then</item><item name="jordan.k · 1d">sent a reel</item><item name="mom · 3d">call me</item></list><group name="Thread header"><image name="alex_m avatar"/><text>alex_m</text><button name="Audio call"/><button name="Video call"/><button name="Conversation information"/></group><list name="Messages"><item><text name="alex_m">hey are we still on for saturday?</text></item><item><text name="alex_m">lmk what time works</text></item><item><text name="You">yeah! thinking around 2</text></item><item><text name="alex_m">perfect, my place or the cafe?</text></item></list><group name="Composer"><button name="Add photo"/><edit name="Message" focus="1"></edit><button name="Emoji"/><button name="Voice clip"/><button name="Like"/></group></doc></window>',
		exampleTextBefore: "",
		idealLlmContext:
			"Conversation with alex_m:\nalex_m: hey are we still on for saturday?\nalex_m: lmk what time works\nYou: yeah! thinking around 2\nalex_m: perfect, my place or the cafe?\n\n[Draft message box is empty]",
		idealAsrTail: "",
	},
	{
		app: "Notion",
		exe: "notion.exe",
		surfaceType: "doc",
		expectedTier: 3,
		focusedRole: "edit",
		exampleAxHtml:
			'<window name="Q3 Planning – Notion"><pane name="sidebar"><tree name="Workspace"><node name="Private"><node name="Q3 Planning"/><node name="Meeting Notes"/><node name="Roadmap"/></node><node name="Shared"><node name="Team Wiki"/></node></tree><list name="Quick Find"><item name="Search"/><item name="Settings & members"/><item name="Trash"/></list></pane><pane name="content"><toolbar name="topbar"><button name="Share"/><button name="Comments"/><button name="Updates"/><button name="Favorite"/><menuitem name="..."/></toolbar><tabs name="breadcrumb"><tab name="Private"/><tab name="Q3 Planning"/></tabs><doc name="page"><header name="title"><text>Q3 Planning</text></header><group name="block"><text>We need to ship the new onboarding flow before the quarter ends.</text></group><group name="block"><text>Open questions about staffing remain.</text></group><edit name="Empty paragraph" focus="1"></edit></doc><toolbar name="block-handle"><button name="Add a block"/><button name="Drag to move"/></toolbar><status name="last-edited"><text>Edited just now</text></status></pane></window>',
		exampleTextBefore: "",
		idealLlmContext:
			'The page title is "Q3 Planning". Preceding blocks: "We need to ship the new onboarding flow before the quarter ends." / "Open questions about staffing remain." The user is dictating into a new empty paragraph block directly after these.',
		idealAsrTail: "Open questions about staffing remain.",
	},
] as const;
