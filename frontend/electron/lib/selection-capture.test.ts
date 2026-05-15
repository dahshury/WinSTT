import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

let clipboardText = "";
mock.module("electron", () => {
	const base = electronMock();
	base.clipboard = {
		readText: () => clipboardText,
		writeText: (text: string) => {
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

const { captureSelection, EMPTY_SELECTION, __resetSelectionCaptureForTesting__ } = await import(
	"./selection-capture"
);

function reset(): void {
	uiaSelection = "uia-text";
	clipboardText = "";
	postCopyClipboard = null;
	execLog.length = 0;
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
});
