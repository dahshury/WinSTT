import { describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { electronMock } from "../../test/mocks/electron";

// debug-log.ts has module-load side effects:
//   - reads `app.getPath("userData")` from electron
//   - calls `fs.createWriteStream(...)` immediately
//
// `mock.module(...)` is process-global, so we MUST keep the real `node:fs`
// surface intact (other test files in the suite need fs.promises.access,
// fs.promises.writeFile, fs.constants, etc.) and only override the single
// method debug-log calls at module-init time.

const writeStreamStub: {
	write: (chunk: unknown) => unknown;
	end: () => void;
	on: (event: string, cb: (err?: Error) => void) => void;
	errorListener: ((err?: Error) => void) | null;
} = {
	write: () => undefined,
	end: () => undefined,
	on: (event, cb) => {
		if (event === "error") {
			writeStreamStub.errorListener = cb;
		}
	},
	errorListener: null,
};

mock.module("node:fs", () => ({
	...realFs,
	default: realFs,
	createWriteStream: () => writeStreamStub,
}));

mock.module("electron", () => electronMock());

const { dbg, dbgVerbose } = await import("./debug-log");

describe("debug-log module", () => {
	test("imports without throwing under mocked fs/electron", () => {
		expect(typeof dbg).toBe("function");
		expect(typeof dbgVerbose).toBe("function");
	});

	test("dbg(tag, message) does not throw with a string arg", () => {
		expect(() => dbg("test-tag", "hello")).not.toThrow();
	});

	test("dbg(tag, ...args) does not throw with multiple mixed args", () => {
		expect(() => dbg("test-tag", "x", 42, { a: 1 }, [1, 2, 3])).not.toThrow();
	});

	test("dbg gracefully handles a circular object (JSON.stringify throws)", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => dbg("circ", circular)).not.toThrow();
	});

	test("dbgVerbose does not throw and writes to file regardless of WINSTT_VERBOSE", () => {
		expect(() => dbgVerbose("v-tag", "verbose message")).not.toThrow();
	});

	test("dbg accepts zero extra args", () => {
		expect(() => dbg("only-tag")).not.toThrow();
	});

	test("dbg swallows write errors from the underlying stream", () => {
		const original = writeStreamStub.write;
		writeStreamStub.write = () => {
			throw new Error("stream write fail");
		};
		try {
			expect(() => dbg("err-tag", "msg")).not.toThrow();
		} finally {
			writeStreamStub.write = original;
		}
	});

	test("dbgVerbose swallows write errors from the underlying stream", () => {
		const original = writeStreamStub.write;
		writeStreamStub.write = () => {
			throw new Error("stream write fail");
		};
		try {
			expect(() => dbgVerbose("err-tag", "msg")).not.toThrow();
		} finally {
			writeStreamStub.write = original;
		}
	});

	test("dbgVerbose with non-string args formats safely (string coercion + JSON branch)", () => {
		expect(() => dbgVerbose("v-tag", 42, { a: 1 }, true, null)).not.toThrow();
	});

	test("dbgVerbose handles a circular object via the catch branch", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => dbgVerbose("v-circ", circular)).not.toThrow();
	});
});
