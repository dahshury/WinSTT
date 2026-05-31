import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

const electronBase = electronMock();
mock.module("electron", () => electronBase);

// The mock `app` lacks the writable `isPackaged` flag the SUT reads; this helper
// holds the single boundary cast so each test can flip it without repeating the
// cast. The runtime object is returned unchanged.
const asPackagedApp = (app: typeof electronBase.app) => app as unknown as { isPackaged: boolean };

// Toggle for the mocked `existsSync`. `exists` is the legacy single switch the
// pre-existing tests flip (both helpers share it). `ocrExists`, when set to a
// boolean, OVERRIDES the result specifically for `winstt-ocr.exe` so a test can
// have the context helper present while the OCR helper is absent (or vice-versa)
// — needed because `readWindowContextTree`'s OCR fallback only runs after a
// successful contentless `--tree` read.
const fsStub: { exists: boolean; ocrExists: boolean | null } = { exists: true, ocrExists: null };

import * as realFs from "node:fs";

mock.module("node:fs", () => ({
	...realFs,
	existsSync: (candidate: unknown) => {
		if (
			fsStub.ocrExists !== null &&
			typeof candidate === "string" &&
			candidate.includes("winstt-ocr.exe")
		) {
			return fsStub.ocrExists;
		}
		return fsStub.exists;
	},
}));

interface ExecFileArgs {
	args: string[];
	cmd: string;
}
const execFileLog: ExecFileArgs[] = [];

interface ExecFileStub {
	emitError?: string | undefined;
	ocrEmitError?: string | undefined;
	// When set, stdout/emitError to use specifically when the OCR helper runs;
	// the `--tree` spawn keeps using the default `stdout`/`emitError`.
	ocrStdout?: string | undefined;
	stdout: string | undefined;
}
const execStub: ExecFileStub = { stdout: "" };

mock.module("node:child_process", () => ({
	execFile: (
		cmd: string,
		args: string[],
		_opts: unknown,
		cb: (err: Error | null, stdout: string | undefined) => void
	) => {
		execFileLog.push({ cmd, args });
		const isOcr = cmd.includes("winstt-ocr.exe");
		queueMicrotask(() => {
			const emitError = isOcr ? execStub.ocrEmitError : execStub.emitError;
			if (emitError) {
				cb(new Error(emitError), undefined);
				return;
			}
			cb(null, isOcr ? execStub.ocrStdout : execStub.stdout);
		});
	},
}));

const {
	readWindowContext,
	readWindowContextSplit,
	readWindowSelection,
	readWindowContextTree,
	readWindowOcrText,
	formatContextForPrompt,
	EMPTY_CONTEXT,
	__resetContextReaderForTesting__,
} = await import("./context-reader");

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeAll(() => {
	asPackagedApp(electronBase.app).isPackaged = false;
	setPlatform("win32");
});

afterAll(() => {
	setPlatform(originalPlatform);
});

function reset(): void {
	execFileLog.length = 0;
	execStub.stdout = "";
	execStub.emitError = undefined;
	execStub.ocrStdout = undefined;
	execStub.ocrEmitError = undefined;
	fsStub.exists = true;
	fsStub.ocrExists = null;
	asPackagedApp(electronBase.app).isPackaged = false;
	setPlatform("win32");
	__resetContextReaderForTesting__();
}

describe("readWindowContext", () => {
	test("returns parsed snapshot on a well-formed JSON line", async () => {
		reset();
		execStub.stdout =
			'{"windowTitle":"VS Code","elementName":"Editor","focusedText":"hello world"}\n';
		const snap = await readWindowContext();
		expect(snap.windowTitle).toBe("VS Code");
		expect(snap.elementName).toBe("Editor");
		expect(snap.focusedText).toBe("hello world");
	});

	test("falls back to empty snapshot when stdout is empty", async () => {
		reset();
		execStub.stdout = "";
		const snap = await readWindowContext();
		expect(snap).toEqual(EMPTY_CONTEXT);
	});

	test("falls back to empty snapshot when stdout is undefined", async () => {
		reset();
		execStub.stdout = undefined;
		const snap = await readWindowContext();
		expect(snap).toEqual(EMPTY_CONTEXT);
	});

	test("falls back to empty snapshot when JSON is malformed", async () => {
		reset();
		execStub.stdout = "{not valid json";
		const snap = await readWindowContext();
		expect(snap).toEqual(EMPTY_CONTEXT);
	});

	test("falls back to empty snapshot when JSON parses to non-object (array)", async () => {
		reset();
		execStub.stdout = "[1,2,3]";
		const snap = await readWindowContext();
		expect(snap).toEqual(EMPTY_CONTEXT);
	});

	test("falls back to empty snapshot when JSON parses to null", async () => {
		reset();
		execStub.stdout = "null";
		const snap = await readWindowContext();
		expect(snap).toEqual(EMPTY_CONTEXT);
	});

	test("falls back to empty snapshot when execFile errors (timeout etc.)", async () => {
		reset();
		execStub.emitError = "ETIMEDOUT";
		const snap = await readWindowContext();
		expect(snap).toEqual(EMPTY_CONTEXT);
	});

	test("ignores extra/missing fields without throwing", async () => {
		reset();
		execStub.stdout = '{"windowTitle":"X","other":42}';
		const snap = await readWindowContext();
		expect(snap.windowTitle).toBe("X");
		expect(snap.elementName).toBe("");
		expect(snap.focusedText).toBe("");
	});

	test("returns empty snapshot when the platform is not win32", async () => {
		reset();
		setPlatform("linux");
		__resetContextReaderForTesting__();
		const snap = await readWindowContext();
		expect(snap).toEqual(EMPTY_CONTEXT);
		// No spawn attempted because the binary resolves to null.
		expect(execFileLog).toHaveLength(0);
	});

	test("returns empty snapshot when the binary file is missing", async () => {
		reset();
		fsStub.exists = false;
		__resetContextReaderForTesting__();
		const snap = await readWindowContext();
		expect(snap).toEqual(EMPTY_CONTEXT);
		expect(execFileLog).toHaveLength(0);
	});

	test("uses the packaged resources path when app.isPackaged is true", async () => {
		reset();
		asPackagedApp(electronBase.app).isPackaged = true;
		(process as unknown as { resourcesPath: string }).resourcesPath = "C:\\fake\\res";
		__resetContextReaderForTesting__();
		execStub.stdout = '{"windowTitle":"Pkg","elementName":"","focusedText":""}';
		const snap = await readWindowContext();
		expect(snap.windowTitle).toBe("Pkg");
		expect(execFileLog).toHaveLength(1);
		expect(execFileLog[0]?.cmd).toContain("fake");
		expect(execFileLog[0]?.cmd).toContain("winstt-context.exe");
	});

	test("caches the resolved binary across calls", async () => {
		reset();
		execStub.stdout = '{"windowTitle":"A","elementName":"","focusedText":""}';
		await readWindowContext();
		execStub.stdout = '{"windowTitle":"B","elementName":"","focusedText":""}';
		await readWindowContext();
		expect(execFileLog).toHaveLength(2);
		// Same binary used for both calls (cache hit on the 2nd).
		expect(execFileLog[0]?.cmd).toBe(execFileLog[1]?.cmd);
	});
});

describe("readWindowContextSplit", () => {
	test("passes --split flag to the helper", async () => {
		reset();
		execStub.stdout =
			'{"windowTitle":"VS Code","elementName":"Editor","focusedText":"","textBefore":"I was about to say","textAfter":" and then it ended"}';
		const snap = await readWindowContextSplit();
		expect(execFileLog).toHaveLength(1);
		expect(execFileLog[0]?.args).toEqual(["--split"]);
		expect(snap.textBefore).toBe("I was about to say");
		expect(snap.textAfter).toBe(" and then it ended");
		expect(snap.focusedText).toBe("");
	});

	test("attaches caret fields only when the helper emits them", async () => {
		reset();
		// Legacy whole-text fallback (no caret) — snapshot must stay the
		// exact 3-field shape so `toEqual(EMPTY_CONTEXT)`-style callers and
		// downstream consumers are unaffected.
		execStub.stdout = '{"windowTitle":"X","elementName":"","focusedText":"plain"}';
		const snap = await readWindowContextSplit();
		expect(snap).toEqual({ windowTitle: "X", elementName: "", focusedText: "plain" });
		expect("textBefore" in snap).toBe(false);
		expect("textAfter" in snap).toBe(false);
	});

	test("attaches only the non-empty caret side (textBefore present, textAfter blank)", async () => {
		reset();
		execStub.stdout =
			'{"windowTitle":"","elementName":"","focusedText":"","textBefore":"caret at end of this","textAfter":""}';
		const snap = await readWindowContextSplit();
		expect(snap.textBefore).toBe("caret at end of this");
		// The blank side must NOT be materialized as a present key — each
		// caret side attaches independently only when non-empty.
		expect("textAfter" in snap).toBe(false);
	});

	test("attaches only the non-empty caret side (textAfter present, textBefore blank)", async () => {
		reset();
		execStub.stdout =
			'{"windowTitle":"","elementName":"","focusedText":"","textBefore":"","textAfter":"continues into this"}';
		const snap = await readWindowContextSplit();
		expect(snap.textAfter).toBe("continues into this");
		// textBefore="" must stay absent rather than be coupled in as "".
		expect("textBefore" in snap).toBe(false);
	});

	test("returns empty snapshot when the binary is missing", async () => {
		reset();
		fsStub.exists = false;
		__resetContextReaderForTesting__();
		const snap = await readWindowContextSplit();
		expect(snap).toEqual(EMPTY_CONTEXT);
		expect(execFileLog).toHaveLength(0);
	});
});

describe("readWindowSelection", () => {
	test("passes --selection flag to the helper", async () => {
		reset();
		execStub.stdout = '{"windowTitle":"","elementName":"","focusedText":"picked"}';
		const snap = await readWindowSelection();
		expect(snap.focusedText).toBe("picked");
		expect(execFileLog).toHaveLength(1);
		expect(execFileLog[0]?.args).toEqual(["--selection"]);
	});

	test("returns empty snapshot when the binary is missing", async () => {
		reset();
		fsStub.exists = false;
		__resetContextReaderForTesting__();
		const snap = await readWindowSelection();
		expect(snap).toEqual(EMPTY_CONTEXT);
		expect(execFileLog).toHaveLength(0);
	});
});

// An axHtml serialization whose inner `>text<` runs total fewer than
// OCR_CONTENT_THRESHOLD (40) trimmed chars => "contentless" (chrome only).
const CONTENTLESS_AX = "<window><button>OK</button><edit></edit></window>";
// axHtml carrying a long body — its inner text crosses the 40-char threshold
// so `axHtmlTextLength` short-circuits and the snapshot is "content".
const CONTENTFUL_AX = `<window><text>${"x".repeat(60)}</text></window>`;

function treeStdout(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		windowTitle: "Mail",
		elementName: "Body",
		focusedText: "",
		appExe: "chrome.exe",
		url: "https://example.com/inbox",
		axHtml: CONTENTLESS_AX,
		...extra,
	});
}

describe("readWindowOcrText", () => {
	test("returns recognized text and trims trailing whitespace on success", async () => {
		reset();
		// First touch of getOcrBinary (this module) with the helper present
		// caches the path for the rest of the file.
		fsStub.ocrExists = true;
		execStub.ocrStdout = "  recognized screen text  \n";
		const text = await readWindowOcrText();
		expect(text).toBe("recognized screen text");
		expect(execFileLog).toHaveLength(1);
		expect(execFileLog[0]?.cmd).toContain("winstt-ocr.exe");
		// OCR helper takes no CLI args.
		expect(execFileLog[0]?.args).toEqual([]);
	});

	test("returns empty string when the OCR helper errors", async () => {
		reset();
		fsStub.ocrExists = true;
		execStub.ocrEmitError = "ETIMEDOUT";
		const text = await readWindowOcrText();
		expect(text).toBe("");
		// Spawn was still attempted (binary cached as present).
		expect(execFileLog).toHaveLength(1);
		expect(execFileLog[0]?.cmd).toContain("winstt-ocr.exe");
	});

	test("returns empty string and never spawns when winstt-ocr.exe is missing", async () => {
		reset();
		// OCR helper absent (the build had no MSVC/SDK). The reset hook clears
		// the memoised OCR-binary path, so this re-exercises the
		// "winstt-ocr.exe not found — OCR fallback disabled" resolution branch.
		fsStub.ocrExists = false;
		const text = await readWindowOcrText();
		expect(text).toBe("");
		// getOcrBinary resolved to null => no spawn attempted at all.
		expect(execFileLog).toHaveLength(0);
	});
});

describe("readWindowContextTree", () => {
	test("passes --tree and returns the snapshot untouched when ocrFallback is off", async () => {
		reset();
		execStub.stdout = treeStdout();
		const snap = await readWindowContextTree();
		expect(execFileLog).toHaveLength(1);
		expect(execFileLog[0]?.args).toEqual(["--tree"]);
		expect(snap.windowTitle).toBe("Mail");
		expect(snap.axHtml).toBe(CONTENTLESS_AX);
		expect("ocrText" in snap).toBe(false);
	});

	test("skips OCR when the snapshot already has readable focusedText", async () => {
		reset();
		fsStub.ocrExists = true;
		execStub.stdout = treeStdout({ focusedText: "the actual email body text" });
		const snap = await readWindowContextTree({ ocrFallback: true });
		// Only the --tree spawn ran; no OCR spawn because content was present.
		expect(execFileLog).toHaveLength(1);
		expect(execFileLog[0]?.args).toEqual(["--tree"]);
		expect("ocrText" in snap).toBe(false);
	});

	test("skips OCR when the snapshot has caret textBefore", async () => {
		reset();
		fsStub.ocrExists = true;
		execStub.stdout = treeStdout({ textBefore: "previous line of prose" });
		const snap = await readWindowContextTree({ ocrFallback: true });
		expect(execFileLog).toHaveLength(1);
		expect("ocrText" in snap).toBe(false);
	});

	test("skips OCR when the snapshot has caret textAfter", async () => {
		reset();
		fsStub.ocrExists = true;
		// Only textAfter carries content; the caret fields attach
		// independently, so textBefore stays absent — `hasReadableText`
		// still sees the non-empty textAfter and the snapshot is not
		// contentless, so OCR must not run.
		execStub.stdout = treeStdout({ textBefore: "", textAfter: "trailing content here" });
		const snap = await readWindowContextTree({ ocrFallback: true });
		expect(execFileLog).toHaveLength(1);
		expect("ocrText" in snap).toBe(false);
	});

	test("skips OCR when axHtml carries enough element text to be content", async () => {
		reset();
		fsStub.ocrExists = true;
		execStub.stdout = treeStdout({ axHtml: CONTENTFUL_AX });
		const snap = await readWindowContextTree({ ocrFallback: true });
		// axHtmlTextLength crosses the threshold => not contentless => no OCR.
		expect(execFileLog).toHaveLength(1);
		expect(snap.axHtml).toBe(CONTENTFUL_AX);
		expect("ocrText" in snap).toBe(false);
	});

	test("skips OCR for a contentless snapshot when the app is on the deny-list", async () => {
		reset();
		fsStub.ocrExists = true;
		execStub.stdout = treeStdout();
		const snap = await readWindowContextTree({
			ocrFallback: true,
			denyList: ["chrome.exe"],
		});
		// Denied app must NOT be screenshotted: only the --tree spawn ran.
		expect(execFileLog).toHaveLength(1);
		expect(execFileLog[0]?.args).toEqual(["--tree"]);
		expect("ocrText" in snap).toBe(false);
	});

	test("falls back to OCR and attaches ocrText when UIA is contentless and app allowed", async () => {
		reset();
		fsStub.ocrExists = true;
		execStub.stdout = treeStdout();
		execStub.ocrStdout = "  OCR captured this on-screen text  ";
		const snap = await readWindowContextTree({ ocrFallback: true });
		// Two spawns: --tree then OCR.
		expect(execFileLog).toHaveLength(2);
		expect(execFileLog[0]?.args).toEqual(["--tree"]);
		expect(execFileLog[1]?.cmd).toContain("winstt-ocr.exe");
		expect(snap.ocrText).toBe("OCR captured this on-screen text");
		// Original fields preserved.
		expect(snap.windowTitle).toBe("Mail");
		expect(snap.axHtml).toBe(CONTENTLESS_AX);
	});

	test("returns the snapshot unchanged when the OCR fallback yields empty text", async () => {
		reset();
		fsStub.ocrExists = true;
		execStub.stdout = treeStdout();
		execStub.ocrStdout = "   "; // whitespace -> trims to "" -> no attach
		const snap = await readWindowContextTree({ ocrFallback: true });
		expect(execFileLog).toHaveLength(2);
		expect("ocrText" in snap).toBe(false);
	});

	test("falls back with an empty deny-list (default) when contentless and OCR present", async () => {
		reset();
		fsStub.ocrExists = true;
		execStub.stdout = treeStdout();
		execStub.ocrStdout = "fallback text";
		// No denyList passed at all — exercises the `?? []` default branch.
		const snap = await readWindowContextTree({ ocrFallback: true });
		expect(snap.ocrText).toBe("fallback text");
	});
});

describe("formatContextForPrompt", () => {
	test("returns empty string when all fields blank", () => {
		expect(formatContextForPrompt(EMPTY_CONTEXT)).toBe("");
	});

	test("includes window title when only that is set", () => {
		const result = formatContextForPrompt({
			windowTitle: "Slack",
			elementName: "",
			focusedText: "",
		});
		expect(result).toBe(JSON.stringify({ window: "Slack" }, null, 2));
	});

	test("collapses runs of blank lines in focused text", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "",
			focusedText: "alpha\n\n\n\nbeta",
		});
		expect(JSON.parse(result)).toEqual({ fieldText: "alpha\nbeta" });
	});

	test("emits all three sections when all set", () => {
		const result = formatContextForPrompt({
			windowTitle: "Mail",
			elementName: "Subject",
			focusedText: "Project Nighthawk",
		});
		expect(result).toContain('"window": "Mail"');
		expect(result).toContain('"field": "Subject"');
		expect(result).toContain("Project Nighthawk");
	});
});
