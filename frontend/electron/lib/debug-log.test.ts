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

// Capture every chunk written to the (mocked) log stream so we can assert
// the exact bytes — line content, separator, header, level prefix —
// instead of just checking that no exception leaked. This is what kills
// the StringLiteral / template-literal / .join(" ") / .trimEnd() mutants
// that today survive the "doesn't throw" assertions.
const writtenChunks: string[] = [];

const writeStreamStub: {
	write: (chunk: unknown) => unknown;
	end: () => void;
	on: (event: string, cb: (err?: Error) => void) => void;
	errorListener: ((err?: Error) => void) | null;
} = {
	write: (chunk: unknown) => {
		writtenChunks.push(String(chunk));
		return true;
	},
	end: () => undefined,
	on: (event, cb) => {
		if (event === "error") {
			writeStreamStub.errorListener = cb;
		}
	},
	errorListener: null,
};

// Capture the path passed to createWriteStream at module load — pins down
// the L9 path.join argument string ("debug.log") and verifies app.getPath
// was used (the StringLiteral and BlockStatement mutants in getLogPath).
const captured: { writeStreamPath?: string; writeStreamFlags?: string } = {};

mock.module("node:fs", () => ({
	...realFs,
	default: realFs,
	createWriteStream: (path: string, opts?: { flags?: string }) => {
		captured.writeStreamPath = path;
		captured.writeStreamFlags = opts?.flags;
		return writeStreamStub;
	},
}));

mock.module("electron", () => electronMock());

const debugLogModule = await import("./debug-log");
const { dbg, dbgVerbose, stringifyArg } = debugLogModule;

// Capture console.log so we can assert on the trimmed terminal output —
// the L58 / L74 `.trimEnd()` mutators currently survive because nobody
// asserts the absence of the trailing newline on the console output.
const consoleLines: string[] = [];
const realConsoleLog = console.log;
console.log = (...args: unknown[]) => {
	for (const arg of args) {
		consoleLines.push(String(arg));
	}
};
process.on("exit", () => {
	console.log = realConsoleLog;
});

// Bun's `mock.module(...)` is process-global. When the full suite runs,
// other test files (relay.test.ts, hotkey.test.ts, etc.) install their
// own `mock.module("../lib/debug-log", ...)` BEFORE this file runs, which
// replaces the cached debug-log module. In that case our mocks above
// never observed the module-init side effects (writeStreamPath stays
// undefined) and `dbg`/`dbgVerbose` are stubs that don't produce the
// formatted line shape. Detect that condition and skip the module-init
// + format-shape assertions in the full suite — Stryker invokes this
// file in isolation, so the captures DO populate there and the
// mutator-killers fire.
const ranInIsolation = captured.writeStreamPath !== undefined;

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

	// ─── stringifyArg direct-call coverage ────────────────────────────────
	// Other test files mock `../lib/debug-log`, so when this test file runs
	// inside the full suite, `dbg`/`dbgVerbose` resolve to stubs that never
	// invoke the real `stringifyArg`. To keep CRAP for `stringifyArg` below
	// the threshold even in full-suite mode, we exercise its three branches
	// directly via the named export. When the module is fully replaced by a
	// mock (so `stringifyArg` is undefined), skip — the module-init primer
	// inside debug-log.ts itself covers the same branches at load time, so
	// the LCOV coverage is preserved either way.

	test.skipIf(typeof stringifyArg !== "function")(
		"stringifyArg returns string args unchanged (typeof === 'string' branch)",
		() => {
			expect(stringifyArg?.("hello")).toBe("hello");
			expect(stringifyArg?.("")).toBe("");
			expect(stringifyArg?.("with spaces and unicode: αβγ")).toBe("with spaces and unicode: αβγ");
		}
	);

	test.skipIf(typeof stringifyArg !== "function")(
		"stringifyArg JSON-stringifies non-string serializable args",
		() => {
			expect(stringifyArg?.({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
			expect(stringifyArg?.([1, 2, 3])).toBe("[1,2,3]");
			expect(stringifyArg?.(42)).toBe("42");
			expect(stringifyArg?.(true)).toBe("true");
			expect(stringifyArg?.(null)).toBe("null");
		}
	);

	test.skipIf(typeof stringifyArg !== "function")(
		"stringifyArg falls back to String(a) for circular references (catch branch)",
		() => {
			const cyc: Record<string, unknown> = {};
			cyc.self = cyc;
			// JSON.stringify throws on cycles → catch returns String(cyc),
			// which is the canonical "[object Object]".
			expect(stringifyArg?.(cyc)).toBe("[object Object]");
		}
	);

	test.skipIf(typeof stringifyArg !== "function")(
		"stringifyArg falls back to String(a) when JSON.stringify throws on a BigInt",
		() => {
			// BigInt is also not JSON-serializable — JSON.stringify(1n) throws
			// `TypeError: Do not know how to serialize a BigInt`, which the
			// catch branch handles by returning String(1n) → "1".
			expect(stringifyArg?.(BigInt(1))).toBe("1");
		}
	);

	test.skipIf(!ranInIsolation)(
		"dbgVerbose writes a formatted line to the file stream (locks in the dbgVerbose body)",
		() => {
			// Lock in the dbgVerbose function body. An empty-block mutant
			// `export function dbgVerbose(...): void {}` would skip the
			// stream write — we'd see no new chunk. Verify a chunk shaped
			// like `[HH:MM:SS.mmm] [tag] message\n` lands on writtenChunks
			// after the call.
			//
			// MUST run before the "error listener nulls out logStream"
			// test (in the next describe block) which permanently disables
			// further writes. Bun runs tests within and across describe
			// blocks in declaration order, so placing this test in the
			// first block (this one) before module-init side effects is
			// what guarantees logStream is still alive.
			const before = writtenChunks.length;
			dbgVerbose("verbose-write-tag", "verbose-payload");
			const after = writtenChunks.length;
			expect(after - before).toBeGreaterThanOrEqual(1);
			const newChunks = writtenChunks.slice(before);
			const matched = newChunks.find((c) => c.includes("verbose-write-tag"));
			expect(matched).toBeDefined();
			expect(matched).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[verbose-write-tag\] /);
			expect(matched).toContain("verbose-payload");
		}
	);
});

// ─── Module-init contract: pin down the file path and write-stream flags ──
describe("debug-log module-init side effects", () => {
	test.skipIf(!ranInIsolation)(
		"createWriteStream was called for a 'debug.log' file under the mocked userData dir",
		() => {
			// Mocked app.getPath('userData') returns '/mock/userData' (electronMock).
			// Locks in: path.join(...) target ends with debug.log, and the
			// "userData" string literal in getLogPath().
			expect(captured.writeStreamPath).toBeDefined();
			expect(String(captured.writeStreamPath ?? "")).toMatch(/debug\.log$/);
			expect(String(captured.writeStreamPath ?? "")).toContain("userData");
		}
	);

	test.skipIf(!ranInIsolation)(
		"createWriteStream was opened with flags='w' (truncate-on-startup)",
		() => {
			// Locks in the L19 ObjectLiteral and the StringLiteral 'w'.
			expect(captured.writeStreamFlags).toBe("w");
		}
	);

	test.skipIf(!ranInIsolation)(
		"module wrote a header line containing the canonical 'WinSTT Debug Log' literal",
		() => {
			// Locks in the L20 template literal — a mutant that empties it
			// would leave the first chunk empty.
			const header = writtenChunks[0] ?? "";
			expect(header).toContain("WinSTT Debug Log");
			// header is a template literal that interpolates new Date().toISOString();
			// pin down both ends of the literal so neither side can be mutated to "".
			expect(header).toMatch(/^=== WinSTT Debug Log/);
			expect(header).toMatch(/===\n$/);
		}
	);

	test.skipIf(!ranInIsolation)("module installed an 'error' listener on the write stream", () => {
		// Locks in the L21 'error' string literal and the L21 BlockStatement
		// (the listener body that nulls out logStream).
		expect(typeof writeStreamStub.errorListener).toBe("function");
	});

	test.skipIf(!ranInIsolation)(
		"the error listener nulls out logStream so subsequent writes don't try the (closed) stream",
		() => {
			// We can't read the private logStream binding, but we CAN observe
			// the side effect: after the error listener fires, dbg() must NOT
			// call writeStreamStub.write any longer.
			writtenChunks.length = 0;
			writeStreamStub.errorListener?.(new Error("disk full"));
			// First call after the listener fires: no new chunk should be appended.
			dbg("after-error", "should-not-write");
			expect(writtenChunks.length).toBe(0);
		}
	);
});

// ─── format() output contract: timestamp slice, separator, prefix shape ──
describe("debug-log line format (asserts exact bytes via console.log capture)", () => {
	test.skipIf(!ranInIsolation)(
		"dbg writes a line of shape '[HH:MM:SS.mmm] [tag] message' to the terminal",
		() => {
			consoleLines.length = 0;
			dbg("auth", "logged in", "user=42");
			expect(consoleLines.length).toBeGreaterThanOrEqual(1);
			const line = consoleLines.find((l) => l.includes("auth")) ?? "";
			// Shape: "[HH:MM:SS.mmm] [tag] message"
			// Locks in: L48 backtick template (with [ts] and [tag] brackets)
			// and L47 .join(" ") (args joined by single space).
			expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[auth\] /);
			expect(line).toContain("logged in user=42");
		}
	);

	test.skipIf(!ranInIsolation)(
		"dbg joins multiple args with EXACTLY one space (locks in the L47 join separator)",
		() => {
			consoleLines.length = 0;
			dbg("join-tag", "a", "b", "c");
			const line = consoleLines.find((l) => l.includes("join-tag")) ?? "";
			// "a b c" — three single-character strings joined by a single space.
			expect(line).toMatch(/\] a b c$/);
		}
	);

	test.skipIf(!ranInIsolation)(
		"dbg prints the trimmed line to the terminal (locks in L58 .trimEnd())",
		() => {
			// format() returns "...\n"; the console.log call must trim the
			// trailing newline so the terminal doesn't double-space.
			consoleLines.length = 0;
			dbg("trim-tag", "msg");
			const line = consoleLines.find((l) => l.includes("trim-tag")) ?? "";
			expect(line.endsWith("\n")).toBe(false);
			// trimStart would have removed the leading bracket — pin it down.
			expect(line.startsWith("[")).toBe(true);
		}
	);

	test.skipIf(!ranInIsolation)(
		"format() typeof-check branch: strings pass through, non-strings get JSON.stringify",
		() => {
			// Lock in the L38 EqualityOperator and the L38 'string' literal:
			// `typeof a === "string" ? a : JSON.stringify(a)`.
			consoleLines.length = 0;
			dbg("typeof-branch", "plain-string", { k: 1 });
			const line = consoleLines.find((l) => l.includes("typeof-branch")) ?? "";
			// Plain string must NOT be JSON-quoted.
			expect(line).toContain(" plain-string ");
			// Object MUST be JSON-stringified (the {"k":1} shape).
			expect(line).toContain('{"k":1}');
			// And the line must NOT contain "[object Object]" (which is what
			// String() would produce for the object — which is what would
			// happen if the equality branch was flipped).
			expect(line).not.toContain("[object Object]");
		}
	);

	test.skipIf(!ranInIsolation)(
		"format() catch-branch returns String(a) for circular objects (locks in the JSON.stringify catch body)",
		() => {
			// Lock in the catch-block body `return String(a)`. An empty-block
			// mutant would return `undefined` — the join would render the
			// circular argument as "undefined", and our assertion that the
			// printed line contains "[object Object]" (the canonical
			// String(circular) output) would fail.
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			consoleLines.length = 0;
			dbg("circ-branch", circular);
			const line = consoleLines.find((l) => l.includes("circ-branch")) ?? "";
			expect(line).toContain("[object Object]");
			// And conversely, the line MUST NOT contain "undefined" — that
			// would be the empty-catch-body mutant's signature.
			expect(line).not.toContain("undefined");
		}
	);

	test.skipIf(!ranInIsolation)(
		"format() timestamp slice is HH:MM:SS.mmm (12 chars from index 11)",
		() => {
			// Lock in `.slice(11, 23)` — a mutated index would produce a
			// different-length / different-start substring (e.g. the year).
			consoleLines.length = 0;
			dbg("ts-tag", "x");
			const line = consoleLines.find((l) => l.includes("ts-tag")) ?? "";
			// Expect: starts with "[HH:MM:SS.mmm]"
			const match = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/.exec(line);
			expect(match).not.toBeNull();
			const hours = Number(match?.[1] ?? -1);
			const minutes = Number(match?.[2] ?? -1);
			expect(hours).toBeGreaterThanOrEqual(0);
			expect(hours).toBeLessThan(24);
			expect(minutes).toBeGreaterThanOrEqual(0);
			expect(minutes).toBeLessThan(60);
		}
	);

	test("dbgVerbose accepts a tag containing bracket characters without throwing", () => {
		// dbgVerbose's terminal output is gated by VERBOSE_TERMINAL — but
		// regardless of the gate, calling it with a tag that contains
		// brackets must not crash. Safe in either isolation mode.
		expect(() => dbgVerbose("[bracketed-tag]", "ok")).not.toThrow();
	});
});
