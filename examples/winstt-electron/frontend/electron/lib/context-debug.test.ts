import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";
import type { ContextDebugReaders } from "./context-debug";
import type { WindowContextSnapshot } from "./context-snapshot";

// `context-debug` imports `context-reader`, which imports `electron`. Mock only
// electron (shared + benign across the suite). The native-helper readers are
// supplied via dependency injection below — NO `mock.module("./context-reader")`,
// which would leak and shadow `context-reader.test.ts` when co-run.
mock.module("electron", () => electronMock());

const { captureContextDebugReport, __context_debug_test_helpers__ } = await import(
	"./context-debug"
);
const { buildMetrics, captureMode, firstDenyMatch, hasCaret, snapshotHasContent, trimmedLen } =
	__context_debug_test_helpers__;

const EMPTY: WindowContextSnapshot = { elementName: "", focusedText: "", windowTitle: "" };

function fullTree(): WindowContextSnapshot {
	return {
		appExe: "outlook.exe",
		axHtml: "<window><doc><edit>Dear Dr. Aljarbou,</edit></doc></window>",
		elementName: "Message body",
		focusedText: "Dear Dr. Aljarbou,",
		textAfter: "",
		textBefore: "Dear Dr. Aljarbou,",
		url: "",
		windowTitle: "Inbox - user@example.test",
	};
}

/** Build an injectable reader set from per-mode snapshots (default: empty). */
function readers(
	over: Partial<Record<"def" | "selection" | "split" | "tree", WindowContextSnapshot>> = {}
): ContextDebugReaders {
	return {
		readDefault: () => Promise.resolve(over.def ?? EMPTY),
		readSelection: () => Promise.resolve(over.selection ?? EMPTY),
		readSplit: () => Promise.resolve(over.split ?? EMPTY),
		readTree: () => Promise.resolve(over.tree ?? EMPTY),
	};
}

describe("pure helpers", () => {
	test("trimmedLen handles undefined and whitespace", () => {
		expect(trimmedLen(undefined)).toBe(0);
		expect(trimmedLen("   ")).toBe(0);
		expect(trimmedLen("  hi ")).toBe(2);
	});

	test("snapshotHasContent is false for the empty triple, true with any field", () => {
		expect(snapshotHasContent(EMPTY)).toBe(false);
		expect(snapshotHasContent({ ...EMPTY, windowTitle: "W" })).toBe(true);
		expect(snapshotHasContent({ ...EMPTY, url: "x.com" })).toBe(true);
	});

	test("hasCaret reflects textBefore/textAfter presence", () => {
		expect(hasCaret(EMPTY)).toBe(false);
		expect(hasCaret({ ...EMPTY, textBefore: "x" })).toBe(true);
	});

	test("firstDenyMatch returns the matching pattern (exe), else null", () => {
		const snap = fullTree();
		expect(firstDenyMatch(snap, ["chrome.exe", "outlook.exe"])).toBe("outlook.exe");
		expect(firstDenyMatch(snap, ["chrome.exe"])).toBeNull();
		expect(firstDenyMatch(snap, [])).toBeNull();
	});

	test("buildMetrics counts chars and deny-list size", () => {
		const metrics = buildMetrics(fullTree(), "PROMPT", ["a.exe", "b.exe"]);
		expect(metrics.focusedTextChars).toBe("Dear Dr. Aljarbou,".length);
		expect(metrics.textBeforeChars).toBe("Dear Dr. Aljarbou,".length);
		expect(metrics.promptFragmentChars).toBe(6);
		expect(metrics.denyListSize).toBe(2);
		expect(metrics.axHtmlCap).toBe(150_000);
	});

	test("captureMode times and labels a read", async () => {
		const res = await captureMode("split", () => Promise.resolve({ ...EMPTY, windowTitle: "W" }));
		expect(res.mode).toBe("split");
		expect(res.ok).toBe(true);
		expect(res.durationMs).toBeGreaterThanOrEqual(0);
	});
});

describe("captureContextDebugReport", () => {
	test("live (non-deep) report carries production-faithful fields, no modes", async () => {
		const report = await captureContextDebugReport(
			{ contextAwarenessEnabled: true, deep: false, denyList: [] },
			readers({ tree: fullTree() })
		);

		expect(report.deep).toBe(false);
		expect(report.modes).toBeUndefined();
		expect(report.rawSnapshot.appExe).toBe("outlook.exe");
		expect(report.hasCaret).toBe(true);
		expect(report.denied).toBe(false);
		expect(report.deniedReason).toBeNull();
		expect(report.contentless).toBe(false);
		// Real formatter output — the exact label dictation feeds the LLM.
		expect(report.promptFragment).toContain("App: outlook.exe");
		expect(report.promptFragment).toContain("Dear Dr. Aljarbou,");
		// Clean prior text passes through sanitise unchanged; raw mirrors it.
		expect(report.asrPromptTail).toBe("Dear Dr. Aljarbou,");
		expect(report.asrPromptTailRaw).toBe("Dear Dr. Aljarbou,");
		expect(report.isTerminal).toBe(false);
		expect(report.metrics.axHtmlChars).toBe(fullTree().axHtml?.length ?? 0);
		expect(report.contextAwarenessEnabled).toBe(true);
	});

	test("ASR tail is sanitised (decorative/control noise stripped) vs raw", async () => {
		const report = await captureContextDebugReport(
			{ contextAwarenessEnabled: true, deep: false, denyList: [] },
			readers({ tree: { ...EMPTY, elementName: "Body", textBefore: "Hello ✶✻✽ world ￼" } })
		);
		// Sanitised: dingbats (\p{So}) + ￼ (U+FFFC) removed, whitespace collapsed.
		expect(report.asrPromptTail).toBe("Hello world");
		// Raw: exactly what UIA captured, for comparison.
		expect(report.asrPromptTailRaw).toBe("Hello ✶✻✽ world ￼");
	});

	test("terminal focus is flagged and its scrollback suppressed for both models", async () => {
		const report = await captureContextDebugReport(
			{ contextAwarenessEnabled: true, deep: false, denyList: [] },
			readers({
				tree: {
					...EMPTY,
					axHtml: "<doc>Ran 1 shell command Done. Combobulating…</doc>",
					elementName: "Terminal 45, claude Use Alt+F1 for terminal accessibility help",
					textBefore: "Ran 1 shell command Done. Combobulating…",
				},
			})
		);
		expect(report.isTerminal).toBe(true);
		// ASR: suppressed entirely (no Whisper poison); raw still shown for debugging.
		expect(report.asrPromptTail).toBe("");
		expect(report.asrPromptTailRaw).toBe("Ran 1 shell command Done. Combobulating…");
		// LLM: keeps the surface label, drops the scrollback dump (axHtml + caret).
		expect(report.promptFragment).toContain("Terminal/console focused");
		expect(report.promptFragment).not.toContain("Ran 1 shell command");
	});

	test("deep report includes all four modes", async () => {
		const report = await captureContextDebugReport(
			{ contextAwarenessEnabled: true, deep: true, denyList: [] },
			readers({
				def: { ...EMPTY, focusedText: "draft" },
				selection: EMPTY,
				split: { ...EMPTY, textBefore: "be" },
				tree: fullTree(),
			})
		);
		expect(report.deep).toBe(true);
		const modes = report.modes ?? [];
		expect(modes.map((m) => m.mode).sort()).toEqual(["default", "selection", "split", "tree"]);
		expect(modes.find((m) => m.mode === "tree")?.snapshot.appExe).toBe("outlook.exe");
		expect(modes.find((m) => m.mode === "selection")?.ok).toBe(false);
	});

	test("deny-listed app strips sensitive fields and reports the reason", async () => {
		const report = await captureContextDebugReport(
			{ contextAwarenessEnabled: true, deep: false, denyList: ["outlook.exe"] },
			readers({ tree: fullTree() })
		);
		expect(report.denied).toBe(true);
		expect(report.deniedReason).toBe("outlook.exe");
		// Redaction keeps window/element as harmless metadata, drops body + tree.
		expect(report.filteredSnapshot.focusedText).toBe("");
		expect(report.filteredSnapshot.axHtml).toBeUndefined();
		// And the redaction propagates to the consumed views.
		expect(report.asrPromptTail).toBe("");
		expect(report.promptFragment).not.toContain("Dear Dr. Aljarbou,");
	});

	test("ocrUsed + contentless reflect an OCR-derived snapshot", async () => {
		const report = await captureContextDebugReport(
			{ contextAwarenessEnabled: false, deep: false, denyList: [] },
			readers({ tree: { ...EMPTY, windowTitle: "Game", ocrText: "HUD text" } })
		);
		expect(report.ocrUsed).toBe(true);
		expect(report.contentless).toBe(true);
	});
});
