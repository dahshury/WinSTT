import { describe, expect, mock, test } from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { electronMock } from "../../test/mocks/electron";

let clipboardText = "";
let clipboardReadThrows = false;
let clipboardWriteThrows = false;
let clipboardReadReturnsNullish = false;
mock.module("electron", () => {
	const base = electronMock();
	base.clipboard = {
		readText: () => {
			if (clipboardReadThrows) {
				throw new Error("read boom");
			}
			if (clipboardReadReturnsNullish) {
				return asInvalid<string>(undefined);
			}
			return clipboardText;
		},
		writeText: (text: string) => {
			if (clipboardWriteThrows) {
				throw new Error("write boom");
			}
			clipboardText = text;
		},
		clear: () => {
			clipboardText = "";
		},
	};
	(base.app as unknown as { isPackaged: boolean }).isPackaged = false;
	return base;
});

import * as realFs from "node:fs";

mock.module("node:fs", () => ({
	...realFs,
	existsSync: () => true,
}));

let uiaSelection = "uia-text";
mock.module("./context-reader", () => ({
	readWindowSelection: () =>
		Promise.resolve({
			windowTitle: "",
			elementName: "",
			focusedText: uiaSelection,
		}),
}));

interface ExecCall {
	args: string[];
	cmd: string;
}
const execLog: ExecCall[] = [];
// Each invocation of the paste binary in --copy mode simulates the OS
// updating the clipboard with whatever the test scenario expects after
// SendInput Ctrl+C lands.
let postCopyClipboard: string | null = null;

mock.module("node:child_process", () => ({
	execFile: (
		cmd: string,
		args: string[],
		_opts: unknown,
		cb: (err: Error | null, stdout: string) => void
	) => {
		execLog.push({ cmd, args });
		queueMicrotask(() => {
			if (postCopyClipboard !== null) {
				clipboardText = postCopyClipboard;
			}
			cb(null, "");
		});
	},
}));

const {
	captureSelection,
	EMPTY_SELECTION,
	__resetSelectionCaptureForTesting__,
	__test_isFreshClipboard,
	__test_clipboardCaptureFailed,
	__test_resolvePasteBinary,
	__test_readClipboardSafe,
	__test_pasteBinaryCandidate,
} = await import("./selection-capture");

function reset(): void {
	uiaSelection = "uia-text";
	clipboardText = "";
	postCopyClipboard = null;
	execLog.length = 0;
	clipboardReadThrows = false;
	clipboardWriteThrows = false;
	clipboardReadReturnsNullish = false;
	__resetSelectionCaptureForTesting__();
}

describe("captureSelection", () => {
	test("returns UIA text when TextPattern selection is non-empty (no clipboard touch)", async () => {
		reset();
		clipboardText = "user-secrets";
		uiaSelection = "Hello world";
		const snap = await captureSelection();
		expect(snap.text).toBe("Hello world");
		expect(snap.source).toBe("uia");
		// UIA path never spawns the paste binary.
		expect(execLog.length).toBe(0);
		// Clipboard is untouched.
		expect(clipboardText).toBe("user-secrets");
	});

	test("falls back to clipboard trick when UIA returns empty", async () => {
		reset();
		clipboardText = "before";
		uiaSelection = "";
		postCopyClipboard = "selected text";
		const snap = await captureSelection();
		expect(snap.text).toBe("selected text");
		expect(snap.source).toBe("clipboard");
		expect(snap.originalClipboard).toBe("before");
		// One spawn — winstt-paste.exe --copy
		expect(execLog.length).toBe(1);
		expect(execLog[0]?.args).toEqual(["--copy"]);
	});

	test("returns EMPTY_SELECTION and restores clipboard when nothing is selected", async () => {
		reset();
		clipboardText = "original";
		uiaSelection = "";
		// Simulate Ctrl+C producing no change (nothing selected).
		postCopyClipboard = null;
		const snap = await captureSelection();
		expect(snap).toEqual(EMPTY_SELECTION);
		// Clipboard preserved (restore path).
		expect(clipboardText).toBe("original");
	});

	test("treats clipboard staying equal to original as 'empty'", async () => {
		reset();
		clipboardText = "same";
		uiaSelection = "";
		postCopyClipboard = "same";
		const snap = await captureSelection();
		expect(snap.source).toBe("empty");
		expect(clipboardText).toBe("same");
	});

	test("trims whitespace-only UIA selection and falls back to clipboard", async () => {
		reset();
		clipboardText = "before";
		uiaSelection = "   \n\t  ";
		postCopyClipboard = "real selection";
		const snap = await captureSelection();
		expect(snap.text).toBe("real selection");
		expect(snap.source).toBe("clipboard");
		expect(execLog.length).toBe(1);
	});

	test("does not restore clipboard when original was empty and capture failed", async () => {
		reset();
		clipboardText = "";
		uiaSelection = "";
		postCopyClipboard = null;
		const snap = await captureSelection();
		expect(snap).toEqual(EMPTY_SELECTION);
		expect(clipboardText).toBe("");
	});
});

describe("readClipboardSafe", () => {
	test("returns clipboard text on success", () => {
		reset();
		clipboardText = "hello";
		expect(__test_readClipboardSafe()).toBe("hello");
	});

	test("returns empty string when readText yields nullish", () => {
		reset();
		clipboardReadReturnsNullish = true;
		expect(__test_readClipboardSafe()).toBe("");
	});

	test("returns empty string and swallows errors when readText throws", () => {
		reset();
		clipboardReadThrows = true;
		expect(__test_readClipboardSafe()).toBe("");
	});
});

describe("isFreshClipboard", () => {
	test("true when changed and non-empty", () => {
		expect(__test_isFreshClipboard("new", "old")).toBe(true);
	});
	test("false when unchanged", () => {
		expect(__test_isFreshClipboard("same", "same")).toBe(false);
	});
	test("false when changed but empty", () => {
		expect(__test_isFreshClipboard("", "old")).toBe(false);
	});
});

describe("clipboardCaptureFailed", () => {
	test("true when captured is empty", () => {
		expect(__test_clipboardCaptureFailed("", "orig")).toBe(true);
	});
	test("true when captured equals original", () => {
		expect(__test_clipboardCaptureFailed("orig", "orig")).toBe(true);
	});
	test("false when captured is fresh", () => {
		expect(__test_clipboardCaptureFailed("new", "orig")).toBe(false);
	});
});

describe("resolvePasteBinary", () => {
	test("returns a path on win32 when the binary exists", () => {
		reset();
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			expect(__test_resolvePasteBinary()).toContain("winstt-paste.exe");
		} finally {
			Object.defineProperty(process, "platform", { value: original });
		}
	});

	test("returns null off win32", () => {
		reset();
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "linux" });
		try {
			expect(__test_resolvePasteBinary()).toBeNull();
		} finally {
			Object.defineProperty(process, "platform", { value: original });
		}
	});

	test("pasteBinaryCandidate yields the dev path when not packaged", () => {
		reset();
		expect(__test_pasteBinaryCandidate()).toContain("winstt-paste.exe");
	});
});
