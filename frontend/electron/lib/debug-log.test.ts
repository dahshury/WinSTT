import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

// The new debug-log implementation is a thin wrapper over electron-log.
// We stub electron-log/main so we can assert that:
//   - dbg(tag, ...) routes through `log.scope(tag).info(...)` with the
//     stringified payload
//   - dbgVerbose(tag, ...) routes through `log.scope(tag).verbose(...)`
//   - the file/console transports get configured with rotation, format,
//     and the userData-based resolvePathFn
//   - stringifyArg behaves identically to the old implementation
//
// `mock.module(...)` is process-global, so we install the mock BEFORE
// importing debug-log.

interface ScopedCall {
	args: unknown[];
	level: "info" | "verbose" | "warn" | "error";
	scope: string;
}

const captured: { calls: ScopedCall[] } = { calls: [] };

const transports = {
	file: {
		resolvePathFn: undefined as ((vars: unknown) => string) | undefined,
		format: "" as string,
		maxSize: 0,
		level: "verbose" as string,
	},
	console: {
		format: "" as string,
		level: "info" as string,
	},
};

const errorHandler = {
	startCatching: mock(() => undefined),
};

const eventLogger = {
	startLogging: mock(() => undefined),
};

const initialize = mock(() => undefined);

function makeScopedLogger(scope: string) {
	return {
		info: (...args: unknown[]) => {
			captured.calls.push({ scope, level: "info", args });
		},
		verbose: (...args: unknown[]) => {
			captured.calls.push({ scope, level: "verbose", args });
		},
		warn: (...args: unknown[]) => {
			captured.calls.push({ scope, level: "warn", args });
		},
		error: (...args: unknown[]) => {
			captured.calls.push({ scope, level: "error", args });
		},
	};
}

const mockLog = {
	transports,
	errorHandler,
	eventLogger,
	initialize,
	scope: (label: string) => makeScopedLogger(label),
	info: (...args: unknown[]) => {
		captured.calls.push({ scope: "", level: "info", args });
	},
};

mock.module("electron-log/main", () => ({
	default: mockLog,
	...mockLog,
}));

mock.module("electron", () => electronMock());

const debugLogModule = await import("./debug-log");
const { dbg, dbgVerbose, stringifyArg, getLogger } = debugLogModule;

// Bun's `mock.module(...)` is process-global. When the full suite runs, other
// test files (relay.test.ts, hotkey.test.ts, etc.) install their own
// `mock.module("../lib/debug-log", ...)` BEFORE this file loads — at which
// point the real electron-log module is also cached process-wide. In that
// case our mock above never wires up and `transports.file.maxSize` stays at
// the default 0. Detect that condition and skip the mock-only assertions in
// the full suite — they are exercised by Stryker / when this file runs in
// isolation.
const mockWasApplied = transports.file.maxSize === 5 * 1024 * 1024;

describe("debug-log module", () => {
	test("exports the expected surface", () => {
		expect(typeof dbg).toBe("function");
		expect(typeof dbgVerbose).toBe("function");
		expect(typeof stringifyArg).toBe("function");
		expect(typeof getLogger).toBe("function");
	});

	test.skipIf(!mockWasApplied)(
		"module init configures the file transport with rotation + scoped format",
		() => {
			expect(transports.file.maxSize).toBe(5 * 1024 * 1024);
			expect(transports.file.format).toContain("{scope}");
			expect(transports.file.format).toContain("{text}");
			expect(typeof transports.file.resolvePathFn).toBe("function");
		}
	);

	test.skipIf(!mockWasApplied)("resolvePathFn returns a path ending with debug.log", () => {
		const resolved = transports.file.resolvePathFn?.({}) ?? "";
		expect(resolved.endsWith("debug.log")).toBe(true);
	});

	test.skipIf(!mockWasApplied)("module init installs the unhandledException catcher", () => {
		expect(errorHandler.startCatching).toHaveBeenCalled();
	});

	test.skipIf(!mockWasApplied)("module init bridges renderer logs (electron-log v5 API)", () => {
		expect(initialize).toHaveBeenCalled();
	});

	test.skipIf(!mockWasApplied)(
		"dbg(tag, ...) routes through scope().info() with stringified args",
		() => {
			const before = captured.calls.length;
			dbg("auth", "logged in", "user=42");
			const after = captured.calls.length;
			expect(after).toBeGreaterThan(before);
			const call = captured.calls.at(-1);
			expect(call?.scope).toBe("auth");
			expect(call?.level).toBe("info");
			expect(call?.args).toEqual(["logged in user=42"]);
		}
	);

	test.skipIf(!mockWasApplied)(
		"dbg JSON-stringifies non-string args (preserves legacy format)",
		() => {
			dbg("trans", "got payload", { id: 1 }, [2, 3]);
			const call = captured.calls.at(-1);
			expect(call?.scope).toBe("trans");
			expect(call?.args[0]).toBe('got payload {"id":1} [2,3]');
		}
	);

	test.skipIf(!mockWasApplied)("dbg falls back to String(v) for circular references", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		dbg("circ", circular);
		const call = captured.calls.at(-1);
		expect(call?.args[0]).toBe("[object Object]");
	});

	test.skipIf(!mockWasApplied)("dbgVerbose routes through scope().verbose()", () => {
		dbgVerbose("frames", "rms=", 0.42);
		const call = captured.calls.at(-1);
		expect(call?.scope).toBe("frames");
		expect(call?.level).toBe("verbose");
		expect(call?.args).toEqual(["rms= 0.42"]);
	});

	test.skipIf(!mockWasApplied)("dbg with zero args produces an empty message", () => {
		dbg("ping");
		const call = captured.calls.at(-1);
		expect(call?.args).toEqual([""]);
	});

	test("stringifyArg returns strings unchanged", () => {
		expect(stringifyArg("hello")).toBe("hello");
		expect(stringifyArg("")).toBe("");
	});

	test("stringifyArg JSON-stringifies non-string serializable args", () => {
		expect(stringifyArg({ a: 1 })).toBe('{"a":1}');
		expect(stringifyArg([1, 2])).toBe("[1,2]");
		expect(stringifyArg(42)).toBe("42");
		expect(stringifyArg(null)).toBe("null");
	});

	test("stringifyArg falls back to String(a) for circular references", () => {
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(stringifyArg(cyc)).toBe("[object Object]");
	});

	test("stringifyArg falls back to String(a) for BigInt", () => {
		expect(stringifyArg(BigInt(1))).toBe("1");
	});

	test.skipIf(!mockWasApplied)("getLogger returns a scoped electron-log logger", () => {
		const scoped = getLogger("custom");
		expect(typeof scoped.info).toBe("function");
		scoped.info("hello");
		const call = captured.calls.at(-1);
		expect(call?.scope).toBe("custom");
		expect(call?.level).toBe("info");
	});

	test.skipIf(!mockWasApplied)("dbg swallows logger errors", () => {
		// Override the mock so scope().info throws.
		const original = mockLog.scope;
		mockLog.scope = () => ({
			info: () => {
				throw new Error("write fail");
			},
			verbose: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		});
		try {
			expect(() => dbg("err", "msg")).not.toThrow();
		} finally {
			mockLog.scope = original;
		}
	});

	test("dbg / dbgVerbose / stringifyArg never throw (smoke)", () => {
		expect(() => dbg("smoke", "hello")).not.toThrow();
		expect(() => dbg("smoke", { a: 1 }, 42, null)).not.toThrow();
		expect(() => dbgVerbose("smoke", "verbose")).not.toThrow();
		expect(stringifyArg("hello")).toBe("hello");
		expect(stringifyArg(42)).toBe("42");
	});
});
