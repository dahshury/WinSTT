import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

const electronBase = electronMock();
mock.module("electron", () => electronBase);

// Toggle for the mocked `existsSync` so tests can simulate "binary missing".
const fsStub: { exists: boolean } = { exists: true };

import * as realFs from "node:fs";

mock.module("node:fs", () => ({
	...realFs,
	existsSync: () => fsStub.exists,
}));

interface ExecFileArgs {
	args: string[];
	cmd: string;
}
const execFileLog: ExecFileArgs[] = [];

interface ExecFileStub {
	emitError?: string;
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
		queueMicrotask(() => {
			if (execStub.emitError) {
				cb(new Error(execStub.emitError), undefined);
				return;
			}
			cb(null, execStub.stdout);
		});
	},
}));

const {
	readWindowContext,
	readWindowSelection,
	formatContextForPrompt,
	EMPTY_CONTEXT,
	__resetContextReaderForTesting__,
} = await import("./context-reader");

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeAll(() => {
	(electronBase.app as unknown as { isPackaged: boolean }).isPackaged = false;
	setPlatform("win32");
});

afterAll(() => {
	setPlatform(originalPlatform);
});

function reset(): void {
	execFileLog.length = 0;
	execStub.stdout = "";
	execStub.emitError = undefined;
	fsStub.exists = true;
	(electronBase.app as unknown as { isPackaged: boolean }).isPackaged = false;
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
		(electronBase.app as unknown as { isPackaged: boolean }).isPackaged = true;
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
		expect(result).toBe("Window: Slack");
	});

	test("collapses runs of blank lines in focused text", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "",
			focusedText: "alpha\n\n\n\nbeta",
		});
		expect(result).toContain("alpha\nbeta");
	});

	test("emits all three sections when all set", () => {
		const result = formatContextForPrompt({
			windowTitle: "Mail",
			elementName: "Subject",
			focusedText: "Project Nighthawk",
		});
		expect(result).toContain("Window: Mail");
		expect(result).toContain("Focused field: Subject");
		expect(result).toContain("Project Nighthawk");
	});
});
