import { describe, expect, test } from "bun:test";
import {
	EMPTY_CONTEXT,
	extractAsrPromptTail,
	formatContextForPrompt,
	isDeniedByList,
	redactSensitiveFields,
	type WindowContextSnapshot,
} from "./context-snapshot";

function makeSnapshot(overrides: Partial<WindowContextSnapshot> = {}): WindowContextSnapshot {
	return { ...EMPTY_CONTEXT, ...overrides };
}

/** Parse the JSON context fragment back into an object for key-level assertions.
 *  formatContextForPrompt now emits a flat JSON object (see its doc comment);
 *  tests assert on the typed keys rather than on labeled flat-text lines. */
function parseContext(raw: string): Record<string, unknown> {
	return JSON.parse(raw) as Record<string, unknown>;
}

describe("EMPTY_CONTEXT", () => {
	test("exposes empty strings for every snapshot field", () => {
		expect(EMPTY_CONTEXT).toEqual({
			windowTitle: "",
			elementName: "",
			focusedText: "",
		});
	});
});

describe("formatContextForPrompt — selected text + clipboard (field-standard supplementary context)", () => {
	test("emits the selection key when a selection is present", () => {
		const ctx = parseContext(
			formatContextForPrompt(makeSnapshot({ selectedText: "the paragraph to rewrite" }))
		);
		expect(ctx.selection).toBe("the paragraph to rewrite");
	});

	test("emits the clipboard key when clipboard context is present", () => {
		const ctx = parseContext(
			formatContextForPrompt(makeSnapshot({ clipboardText: "https://example.com/ref" }))
		);
		expect(ctx.clipboard).toBe("https://example.com/ref");
	});

	test("neither key appears when both are absent (no noise)", () => {
		const ctx = parseContext(formatContextForPrompt(makeSnapshot({ focusedText: "hello" })));
		expect(ctx.selection).toBeUndefined();
		expect(ctx.clipboard).toBeUndefined();
	});

	test("selection leads and clipboard trails the caret content (key order preserved)", () => {
		const out = formatContextForPrompt(
			makeSnapshot({
				selectedText: "SELECTED_BLOCK",
				textBefore: "caret leading text that is clearly long enough to be rich content",
				clipboardText: "CLIPBOARD_BLOCK",
			})
		);
		// JSON.stringify preserves insertion order, so position in the raw string
		// reflects emission order: selection → beforeCaret → clipboard.
		const selIdx = out.indexOf("SELECTED_BLOCK");
		const caretIdx = out.indexOf("caret leading text");
		const clipIdx = out.indexOf("CLIPBOARD_BLOCK");
		expect(selIdx).toBeGreaterThanOrEqual(0);
		expect(caretIdx).toBeGreaterThan(selIdx);
		expect(clipIdx).toBeGreaterThan(caretIdx);
	});

	test("de-noises the selection (object-replacement / control chars stripped)", () => {
		const ctx = parseContext(
			formatContextForPrompt(makeSnapshot({ selectedText: "￼\nclean line\n￼" }))
		);
		expect(ctx.selection).toContain("clean line");
		expect(String(ctx.selection)).not.toContain("￼");
	});

	test("a denied snapshot (redacted) carries no selection/clipboard", () => {
		// redactSensitiveFields keeps only the legacy triple, so selection +
		// clipboard captured for a denied app never reach the LLM.
		const redacted = redactSensitiveFields(
			makeSnapshot({
				windowTitle: "1Password",
				selectedText: "master password vault entry",
				clipboardText: "secret token",
			})
		);
		const out = formatContextForPrompt(redacted);
		expect(out).not.toContain("master password");
		expect(out).not.toContain("secret token");
		const ctx = parseContext(out);
		expect(ctx.selection).toBeUndefined();
		expect(ctx.clipboard).toBeUndefined();
	});
});

describe("formatContextForPrompt", () => {
	test("returns empty string when every field is blank", () => {
		expect(formatContextForPrompt(EMPTY_CONTEXT)).toBe("");
	});

	test("returns empty string when fields contain only whitespace", () => {
		const snapshot: WindowContextSnapshot = {
			windowTitle: "   ",
			elementName: "\t\n",
			focusedText: "   \n\n   ",
		};
		expect(formatContextForPrompt(snapshot)).toBe("");
	});

	test("emits only the window key when it is the only populated field", () => {
		const ctx = parseContext(
			formatContextForPrompt({ windowTitle: "Slack", elementName: "", focusedText: "" })
		);
		expect(ctx).toEqual({ window: "Slack" });
	});

	test("emits only the field key when the focused element is the only populated field", () => {
		const ctx = parseContext(
			formatContextForPrompt({ windowTitle: "", elementName: "Subject", focusedText: "" })
		);
		expect(ctx).toEqual({ field: "Subject" });
	});

	test("emits only fieldText when the focused content is the only populated field", () => {
		const ctx = parseContext(
			formatContextForPrompt({ windowTitle: "", elementName: "", focusedText: "hello" })
		);
		expect(ctx).toEqual({ fieldText: "hello" });
	});

	test("trims leading/trailing whitespace from each field", () => {
		const ctx = parseContext(
			formatContextForPrompt({
				windowTitle: "  Mail  ",
				elementName: "\tSubject\n",
				focusedText: "  Project Nighthawk  ",
			})
		);
		expect(ctx).toEqual({ window: "Mail", field: "Subject", fieldText: "Project Nighthawk" });
	});

	test("collapses runs of two or more blank lines in focused text to a single newline", () => {
		const ctx = parseContext(
			formatContextForPrompt({ windowTitle: "", elementName: "", focusedText: "alpha\n\n\n\nbeta" })
		);
		expect(ctx).toEqual({ fieldText: "alpha\nbeta" });
	});

	test("preserves single newlines inside the focused text untouched", () => {
		const ctx = parseContext(
			formatContextForPrompt({ windowTitle: "", elementName: "", focusedText: "alpha\nbeta" })
		);
		expect(ctx).toEqual({ fieldText: "alpha\nbeta" });
	});

	test("emits all keys, in canonical order, when all fields are populated", () => {
		const out = formatContextForPrompt({
			windowTitle: "Mail",
			elementName: "Subject",
			focusedText: "Project Nighthawk",
		});
		expect(parseContext(out)).toEqual({
			window: "Mail",
			field: "Subject",
			fieldText: "Project Nighthawk",
		});
		// window precedes field precedes fieldText in the serialized output.
		expect(out.indexOf('"window"')).toBeLessThan(out.indexOf('"field"'));
		expect(out.indexOf('"field"')).toBeLessThan(out.indexOf('"fieldText"'));
	});

	test("skips blank windowTitle while still emitting field + fieldText", () => {
		const ctx = parseContext(
			formatContextForPrompt({ windowTitle: "", elementName: "Subject", focusedText: "body" })
		);
		expect(ctx).toEqual({ field: "Subject", fieldText: "body" });
	});

	test("skips blank elementName while still emitting window + fieldText", () => {
		const ctx = parseContext(
			formatContextForPrompt({ windowTitle: "Mail", elementName: "", focusedText: "body" })
		);
		expect(ctx).toEqual({ window: "Mail", fieldText: "body" });
	});

	test("skips blank focusedText while still emitting window + field", () => {
		const ctx = parseContext(
			formatContextForPrompt({ windowTitle: "Mail", elementName: "Subject", focusedText: "" })
		);
		expect(ctx).toEqual({ window: "Mail", field: "Subject" });
	});

	test("does not mutate the input snapshot", () => {
		const snapshot: WindowContextSnapshot = {
			windowTitle: "  Mail  ",
			elementName: "  Subject  ",
			focusedText: "alpha\n\n\nbeta",
		};
		const before = { ...snapshot };
		formatContextForPrompt(snapshot);
		expect(snapshot).toEqual(before);
	});
});

describe("formatContextForPrompt — caret-split mode", () => {
	test("emits beforeCaret/afterCaret keys and suppresses fieldText", () => {
		const ctx = parseContext(
			formatContextForPrompt({
				windowTitle: "VS Code",
				elementName: "Editor",
				focusedText: "should be ignored in caret mode",
				textBefore: "The meeting is",
				textAfter: " at noon.",
			})
		);
		expect(ctx.window).toBe("VS Code");
		expect(ctx.field).toBe("Editor");
		expect(String(ctx.beforeCaret)).toContain("The meeting is");
		expect(String(ctx.afterCaret)).toContain("at noon.");
		// focusedText must NOT leak in (it would duplicate the split text).
		expect(ctx.fieldText).toBeUndefined();
		expect(JSON.stringify(ctx)).not.toContain("should be ignored");
	});

	test("emits only beforeCaret when after is empty", () => {
		const ctx = parseContext(
			formatContextForPrompt({
				windowTitle: "",
				elementName: "",
				focusedText: "",
				textBefore: "continue this thought",
				textAfter: "",
			})
		);
		expect(String(ctx.beforeCaret)).toContain("continue this thought");
		expect(ctx.afterCaret).toBeUndefined();
	});

	test("falls back to fieldText when both caret fields are blank", () => {
		const ctx = parseContext(
			formatContextForPrompt({
				windowTitle: "Mail",
				elementName: "Subject",
				focusedText: "body",
				textBefore: "   ",
				textAfter: "",
			})
		);
		expect(ctx).toEqual({ window: "Mail", field: "Subject", fieldText: "body" });
	});

	test("collapses blank-line runs inside caret text", () => {
		const ctx = parseContext(
			formatContextForPrompt({
				windowTitle: "",
				elementName: "",
				focusedText: "",
				textBefore: "alpha\n\n\n\nbeta",
				textAfter: "",
			})
		);
		expect(ctx.beforeCaret).toBe("alpha\nbeta");
	});

	test("does not mutate a caret-mode input snapshot", () => {
		const snapshot: WindowContextSnapshot = {
			windowTitle: "X",
			elementName: "Y",
			focusedText: "",
			textBefore: "a\n\n\nb",
			textAfter: "c",
		};
		const before = { ...snapshot };
		formatContextForPrompt(snapshot);
		expect(snapshot).toEqual(before);
	});
});

describe("isDeniedByList", () => {
	test("returns false for an empty deny list", () => {
		expect(isDeniedByList(makeSnapshot({ appExe: "chrome.exe" }), [])).toBe(false);
	});

	test("matches an exe entry against the snapshot's appExe (case-insensitive)", () => {
		expect(isDeniedByList(makeSnapshot({ appExe: "1Password.exe" }), ["1password.exe"])).toBe(true);
	});

	test("matches a bare-host pattern against the snapshot's URL host", () => {
		expect(
			isDeniedByList(makeSnapshot({ url: "https://bank.example.com/account" }), ["example.com"])
		).toBe(true);
	});

	test("matches a wildcard *.host pattern after stripping the leading *.", () => {
		expect(
			isDeniedByList(makeSnapshot({ url: "https://mail.example.com" }), ["*.example.com"])
		).toBe(true);
	});

	test("does not match a host with no URL captured", () => {
		expect(isDeniedByList(makeSnapshot({ appExe: "chrome.exe" }), ["example.com"])).toBe(false);
	});

	test("ignores empty / whitespace-only deny patterns", () => {
		expect(isDeniedByList(makeSnapshot({ appExe: "chrome.exe" }), ["   ", "", "chrome.exe"])).toBe(
			true
		);
	});

	test("returns false when neither exe nor host matches any pattern", () => {
		expect(
			isDeniedByList(makeSnapshot({ appExe: "chrome.exe", url: "https://github.com" }), [
				"1password.exe",
				"bank.com",
			])
		).toBe(false);
	});
});

describe("formatContextForPrompt — IDE detection", () => {
	test("sets ide:true when appExe is a recognised editor", () => {
		const ctx = parseContext(
			formatContextForPrompt(makeSnapshot({ appExe: "code.exe", windowTitle: "VS Code" }))
		);
		expect(ctx.ide).toBe(true);
	});

	test("recognises JetBrains-family binaries via prefix match", () => {
		for (const exe of ["idea64.exe", "pycharm64.exe", "webstorm64.exe", "rider64.exe"]) {
			const ctx = parseContext(
				formatContextForPrompt(makeSnapshot({ appExe: exe, windowTitle: "JB" }))
			);
			expect(ctx.ide).toBe(true);
		}
	});

	test("omits ide for unrelated apps", () => {
		const ctx = parseContext(
			formatContextForPrompt(makeSnapshot({ appExe: "chrome.exe", windowTitle: "Chrome" }))
		);
		expect(ctx.ide).toBeUndefined();
	});

	test("omits ide when appExe is missing", () => {
		const ctx = parseContext(formatContextForPrompt(makeSnapshot({ windowTitle: "Untitled" })));
		expect(ctx.ide).toBeUndefined();
	});
});

describe("extractAsrPromptTail", () => {
	test("returns empty string when textBefore is missing", () => {
		expect(extractAsrPromptTail(EMPTY_CONTEXT)).toBe("");
	});

	test("suppresses terminal/console scrollback (it poisons Whisper)", () => {
		expect(
			extractAsrPromptTail(
				makeSnapshot({
					elementName: "Terminal 45, claude Use Alt+F1 for terminal accessibility help",
					textBefore: "Ran 1 shell command Done. Combobulating…",
				})
			)
		).toBe("");
		expect(
			extractAsrPromptTail(makeSnapshot({ elementName: "Console", textBefore: "PS C:\\>" }))
		).toBe("");
	});

	test("returns empty string when textBefore is whitespace-only", () => {
		expect(extractAsrPromptTail(makeSnapshot({ textBefore: "  \n\t " }))).toBe("");
	});

	test("returns trimmed textBefore when populated", () => {
		expect(
			extractAsrPromptTail(makeSnapshot({ textBefore: "  Hi Bob, thanks for the heads up. " }))
		).toBe("Hi Bob, thanks for the heads up.");
	});

	test("ignores axHtml / url / appExe / window title (Whisper needs prior text, not metadata)", () => {
		const out = extractAsrPromptTail(
			makeSnapshot({
				windowTitle: "Outlook — Reply",
				url: "outlook.office.com",
				appExe: "outlook.exe",
				axHtml: "<window><edit>...</edit></window>",
			})
		);
		expect(out).toBe("");
	});

	test("denied snapshots extract to '' (redactSensitiveFields drops textBefore)", () => {
		const redacted = redactSensitiveFields(
			makeSnapshot({
				windowTitle: "Bank — Login",
				appExe: "chrome.exe",
				textBefore: "PIN: 1234",
			})
		);
		expect(extractAsrPromptTail(redacted)).toBe("");
	});
});

describe("formatContextForPrompt — focused-field-first (drop tree when rich)", () => {
	// Gmail-style capture: rich caret body + a giant page-chrome axHtml tree.
	// ￼ is the object-replacement char Gmail splatters around icons/avatars.
	const gmail = (): WindowContextSnapshot =>
		makeSnapshot({
			appExe: "chrome.exe",
			url: "mail.google.com",
			windowTitle: "Inbox (2,669) - user@example.test - Gmail - Google Chrome",
			elementName: "Message Body",
			focusedText: "",
			textBefore:
				"￼\nHi Mostafa\nAny chance you could update your genai-launchpad-fork?\n￼\nTake care,\nJohny\n￼\nI can't do this johny, sorry",
			textAfter: "",
			axHtml:
				"<window><doc>INBOX LIST Steam GoDaddy AWS Talabat — 60 browser tabs —</doc></window>",
		});

	test("drops the axHtml tree (no screen key) when the focused field carries a real body", () => {
		const out = formatContextForPrompt(gmail());
		expect(parseContext(out).screen).toBeUndefined();
		expect(out).not.toContain("INBOX LIST");
		expect(out).not.toContain("60 browser tabs");
	});

	test("keeps the de-noised email body + draft for the LLM", () => {
		const ctx = parseContext(formatContextForPrompt(gmail()));
		expect(String(ctx.beforeCaret)).toContain("Hi Mostafa");
		expect(String(ctx.beforeCaret)).toContain("I can't do this johny, sorry");
		// Object-replacement noise stripped; line structure preserved.
		expect(String(ctx.beforeCaret)).not.toContain("￼");
	});

	test("still includes the app / window / field metadata keys", () => {
		const ctx = parseContext(formatContextForPrompt(gmail()));
		expect(ctx.app).toBe("chrome.exe");
		expect(ctx.field).toBe("Message Body");
	});

	test("KEEPS the axHtml tree (screen key) when the focused field is thin (empty reply / canvas)", () => {
		const ctx = parseContext(
			formatContextForPrompt(
				makeSnapshot({
					appExe: "chrome.exe",
					windowTitle: "Inbox - Gmail",
					elementName: "Message Body",
					textBefore: "",
					textAfter: "",
					axHtml: "<window><doc>The email to reply to lives only in the tree here.</doc></window>",
				})
			)
		);
		// Tier 3 prunes the tree to the content landmark (or falls back to raw
		// axHtml) — either way the email body reaches the LLM under `screen`.
		expect(String(ctx.screen)).toContain("lives only in the tree");
	});
});

describe("denoiseForLlm (via focusedText non-caret path)", () => {
	test("strips object-replacement / dingbats but preserves line structure", () => {
		const ctx = parseContext(
			formatContextForPrompt(
				makeSnapshot({
					elementName: "Body",
					focusedText: "￼\nLine one ✶✻\n￼\n￼\nLine two\n￼",
				})
			)
		);
		expect(ctx.fieldText).toBe("Line one\nLine two");
		expect(String(ctx.fieldText)).not.toContain("￼");
		expect(String(ctx.fieldText)).not.toContain("✶");
	});
});
