import { describe, expect, test } from "bun:test";
import { denoiseForLlm, isCanvasSurface, parseAxHtml, pruneAxHtmlForLlm } from "./ax-prune";

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
