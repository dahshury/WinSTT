import { describe, expect, test } from "bun:test";
import {
	denoiseForLlm,
	isCanvasSurface,
	parseAxHtml,
	pruneAxHtmlForLlm,
	stripListScrollback,
} from "./ax-prune";

describe("stripListScrollback", () => {
	// Mirrors the REAL harmful Gmail capture: the focused reply box's text range
	// spans the whole inbox, so caret context = [inbox rows] → [open email] →
	// [draft]. Each inbox row ends in a bare date; the email + draft follow the
	// last one. (Live capture even leaked a one-time code — SYNTHETIC here.)
	const gmailCaret = [
		"Security alert",
		"You allowed Claude for Google Drive access to some of your data",
		"Apr 24",
		"Microsoft account",
		"Your single-use code is: 111111 Only enter this code on an official site",
		"Apr 23",
		"AWS Budgets: Account 123456789012 exceeded your alert threshold",
		"Apr 16",
		"Everything else",
		"GenAI Launchpad question",
		"Inbox",
		"×",
		"Example Person person@example.test",
		"May 17, 2026, 6:29 PM (13 days ago)",
		"to me",
		"Show details",
		"Hi Mostafa",
		"Any chance you could update your genai-launchpad-fork?",
		"Take care,",
		"Johny",
		"Pop out reply",
		"I can't do this johny, sorry",
	].join("\n");

	test("cuts the inbox scrollback, keeps the open email + draft", () => {
		const out = stripListScrollback(gmailCaret);
		// Kept: subject, the email body, the user's draft.
		expect(out).toContain("GenAI Launchpad question");
		expect(out).toContain("Hi Mostafa");
		expect(out).toContain("Any chance you could update your genai-launchpad-fork?");
		expect(out).toContain("I can't do this johny, sorry");
		// The full-datetime thread header is NOT a bare-date row, so it survives.
		expect(out).toContain("May 17, 2026, 6:29 PM");
	});

	test("removes the harmful inbox rows AND the leaked one-time code", () => {
		const out = stripListScrollback(gmailCaret);
		expect(out).not.toContain("111111");
		expect(out).not.toContain("Security alert");
		expect(out).not.toContain("AWS Budgets");
		expect(out).not.toContain("Apr 24");
		expect(out).not.toContain("Apr 16");
	});

	test("drops the surrounding Gmail chrome singletons", () => {
		const out = stripListScrollback(gmailCaret);
		expect(out).not.toContain("Everything else");
		expect(out).not.toContain("Pop out reply");
		expect(out).not.toContain("Show details");
		expect(out).not.toMatch(/^Inbox$/m);
	});

	test("is a strict no-op on normal editor/chat text (no bare-date rows)", () => {
		const code = "export function f() {\n  return 1;\n}";
		expect(stripListScrollback(code)).toBe(code);
		const chat = "alice: hey\nbob: what's up\nme: replying now";
		expect(stripListScrollback(chat)).toBe(chat);
	});

	test("empty / undefined-ish input is returned unchanged", () => {
		expect(stripListScrollback("")).toBe("");
	});
});

describe("denoiseForLlm", () => {
	test("strips object-replacement / control / dingbats, keeps line structure", () => {
		expect(denoiseForLlm("￼\nLine one ✶✻\n￼\n￼\nLine two\n￼")).toBe("Line one\nLine two");
	});

	test("keeps real scripts (Arabic/CJK) — category filter, not non-ASCII", () => {
		expect(denoiseForLlm("مرحبا\n你好")).toBe("مرحبا\n你好");
	});

	test("empty / undefined → empty", () => {
		expect(denoiseForLlm(undefined)).toBe("");
		expect(denoiseForLlm("   \n  ")).toBe("");
	});
});

describe("parseAxHtml", () => {
	test("parses nested roles, names, focus, and inner text", () => {
		const root = parseAxHtml(
			'<window name="W"><doc name="D"><edit name="E" focus="1">hi</edit></doc></window>'
		);
		const win = root.children[0];
		expect(win?.role).toBe("window");
		expect(win?.name).toBe("W");
		const edit = win?.children[0]?.children[0];
		expect(edit?.role).toBe("edit");
		expect(edit?.focused).toBe(true);
		expect(edit?.text).toBe("hi");
	});

	test("tolerates self-closing tags and entity escapes", () => {
		const root = parseAxHtml('<group><text>a &lt;b&gt; &amp; c</text><button name="x"/></group>');
		const group = root.children[0];
		expect(group?.children).toHaveLength(2);
		expect(group?.children[0]?.text).toBe("a <b> & c");
	});
});

describe("pruneAxHtmlForLlm", () => {
	test("empty input → empty", () => {
		expect(pruneAxHtmlForLlm("")).toBe("");
		expect(pruneAxHtmlForLlm(undefined)).toBe("");
	});

	test("drops chrome subtrees (toolbar/tabs/tree/status/button) by role", () => {
		const ax = `<window>
			<toolbar name="App Bar"><button name="Settings"/></toolbar>
			<tree name="Folders"><node name="Inbox"/></tree>
			<pane name="thread">
				<list name="Messages"><item name="alice: hello there friend"/></list>
				<edit name="Reply" focus="1"></edit>
			</pane>
			<status name="Connected"/>
		</window>`;
		const out = pruneAxHtmlForLlm(ax);
		expect(out).toContain("alice: hello there friend");
		expect(out).not.toContain("Settings");
		expect(out).not.toContain("Folders");
		expect(out).not.toContain("Connected");
	});

	test("climbs PAST a trivial focus wrapper to the landmark with the real body", () => {
		// Gmail shape: focus is in an empty Reply group; the email is a SIBLING.
		const ax = `<pane name="Mail">
			<doc name="Thread">
				<group name="Message"><text>Can we push the sync to Thursday 2pm?</text></group>
				<group name="Reply"><text>To: Sarah</text><edit name="Body" focus="1"></edit></group>
			</doc>
		</pane>`;
		const out = pruneAxHtmlForLlm(ax);
		expect(out).toContain("Can we push the sync to Thursday 2pm?");
	});

	test("keeps a content list even when its name contains a nav word", () => {
		// "Messages in conversation with Maya" matches BOTH nav (conversation) and
		// content (messages / conversation with) — content hint must win.
		const ax = `<pane name="thread">
			<list name="Messages in conversation with Maya"><item name="Maya: are we still on for Friday?"/></list>
			<edit name="Message" focus="1"></edit>
		</pane>`;
		expect(pruneAxHtmlForLlm(ax)).toContain("are we still on for Friday?");
	});

	test("drops a genuine nav/inbox list that is outside the focused landmark", () => {
		const ax = `<pane name="Mail">
			<list name="Conversation list"><item name="Spam: you won a prize click here now"/></list>
			<doc name="Thread">
				<group name="Message"><text>The actual email body to act on goes here.</text></group>
				<edit name="Body" focus="1"></edit>
			</doc>
		</pane>`;
		const out = pruneAxHtmlForLlm(ax);
		expect(out).toContain("actual email body");
		expect(out).not.toContain("you won a prize");
	});

	test("ignores the browser omnibox stealing focus and finds the real landmark", () => {
		const ax = `<pane name="Chrome">
			<edit name="Address and search bar" focus="1">mail.google.com</edit>
			<doc name="Inbox">The newsletter content the user is reading and acting upon here.</doc>
		</pane>`;
		const out = pruneAxHtmlForLlm(ax);
		expect(out).toContain("newsletter content");
		expect(out).not.toContain("mail.google.com");
	});

	test("returns '' when the scoped landmark is too thin (cold tree)", () => {
		expect(pruneAxHtmlForLlm('<pane><doc><edit name="x" focus="1"></edit></doc></pane>')).toBe("");
	});
});

describe("isCanvasSurface", () => {
	test("matches canvas exes and urls", () => {
		expect(isCanvasSurface("figma.exe", "")).toBe(true);
		expect(isCanvasSurface("canva.exe", "")).toBe(true);
		expect(isCanvasSurface("chrome.exe", "https://www.canva.com/design/abc")).toBe(true);
		expect(isCanvasSurface("chrome.exe", "https://docs.google.com/spreadsheets/d/x")).toBe(true);
	});

	test("does not match normal apps", () => {
		expect(isCanvasSurface("chrome.exe", "https://mail.google.com")).toBe(false);
		expect(isCanvasSurface("slack.exe", "")).toBe(false);
		expect(isCanvasSurface(undefined, undefined)).toBe(false);
	});
});
