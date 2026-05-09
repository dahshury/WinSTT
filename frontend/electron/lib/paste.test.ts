import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

// Track setPasteGuard transitions so we can assert on/off pairing.
const guardLog: boolean[] = [];

mock.module("../ipc/hotkey", () => ({
	setPasteGuard: (active: boolean) => {
		guardLog.push(active);
	},
}));

// Track clipboard writes; use the shared electron stub so other test files
// that import additional electron names still see them (`mock.module` is
// process-global).
let lastClipboard = "";
mock.module("electron", () => {
	const base = electronMock();
	base.clipboard = {
		writeText: (text: string) => {
			lastClipboard = text;
		},
		readText: () => lastClipboard,
		clear: () => {
			lastClipboard = "";
		},
	};
	return base;
});

// execFile must invoke its callback so the second `setPasteGuard(false)` runs.
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const execRef: { value: { command: string; args: string[] } | null } = { value: null };
mock.module("node:child_process", () => ({
	execFile: (command: string, args: string[], _opts: unknown, cb?: ExecCb) => {
		execRef.value = { command, args };
		cb?.(null, "", "");
	},
}));

const { pasteText } = await import("./paste");

describe("pasteText", () => {
	test("module imports without throwing under mocked deps", () => {
		expect(typeof pasteText).toBe("function");
	});

	test("is a no-op when text is empty (no clipboard write, no exec)", () => {
		const beforeGuards = guardLog.length;
		const beforeExec = execRef.value;
		lastClipboard = "";
		pasteText("");
		expect(lastClipboard).toBe("");
		expect(guardLog.length).toBe(beforeGuards);
		expect(execRef.value).toBe(beforeExec);
	});

	test("on win32: writes clipboard, toggles paste guard on/off, invokes powershell", () => {
		// pasteText returns early on non-win32; only run the assertions when applicable.
		if (process.platform !== "win32") {
			return;
		}
		guardLog.length = 0;
		execRef.value = null;
		pasteText("hello world");
		expect(lastClipboard).toBe("hello world");
		// Guard toggled true (sync) then false (in execFile callback).
		expect(guardLog).toEqual([true, false]);
		const captured = execRef.value as { command: string; args: string[] } | null;
		expect(captured).not.toBeNull();
		expect(captured?.command).toBe("powershell.exe");
		// PowerShell flags from source.
		expect(captured?.args).toContain("-NoProfile");
		expect(captured?.args).toContain("-NonInteractive");
	});

	test("does not throw for repeated invocations", () => {
		expect(() => {
			pasteText("a");
			pasteText("b");
			pasteText("c");
		}).not.toThrow();
	});
});
