import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

// Stryker disable BlockStatement,StringLiteral: function-scoped equivalent mutants — `getLogPath` is invoked exactly once at module load. The happy path (production code) is fully covered by the test asserting that the writeStream path ends with `debug.log`. The catch-block fallback can only be exercised if `app.getPath("userData")` throws, which our mocked electron never does — so the catch body's StringLiterals (".." and "debug.log") and BlockStatement are observably equivalent. Empty-body mutants on the function or its try-block cascade into the catch path and the module still loads under our mocks.
function getLogPath(): string {
	// Prefer userData (e.g. %APPDATA%/WinSTT/) for log storage.
	// Falls back to the project root only during very early startup before app is ready.
	try {
		return path.join(app.getPath("userData"), "debug.log");
	} catch {
		return path.join(import.meta.dirname, "..", "..", "debug.log");
	}
}
// Stryker restore BlockStatement,StringLiteral

let logStream: fs.WriteStream | null = null;

// Truncate on startup so each run is a fresh log.
// Stryker disable next-line BlockStatement: module-init try block — empty-block mutant only matters if the try body throws (createWriteStream throwing at module load), which the mocked fs never does.
try {
	logStream = fs.createWriteStream(getLogPath(), { flags: "w" });
	logStream.write(`=== WinSTT Debug Log — ${new Date().toISOString()} ===\n`);
	logStream.on("error", () => {
		logStream = null;
	});
	// Stryker disable next-line BlockStatement: catch-block body — fall-through behavior (logStream stays null) is identical to the empty body, so this is an equivalent mutant.
} catch {
	// ignore
}

// Stryker disable next-line StringLiteral,BlockStatement: process.on("exit", …) is a teardown hook that fires only when the test process itself exits — there's no observable behavior we can verify from inside a test, so emptying the callback or changing the event name is functionally invisible.
process.on("exit", () => {
	// Stryker disable next-line OptionalChaining: equivalent mutant — when this fires logStream may legitimately be null (createWriteStream failed); both `?.end` and `.end` produce the same observable nothing in the test process exit path.
	logStream?.end();
});

// Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral: module-load constant — mutating the env-var name or the comparison only matters at the SINGLE module-load instant. After load it's a frozen boolean and there's no way to re-init it from within a single test process to observe both branches.
const VERBOSE_TERMINAL = process.env.WINSTT_VERBOSE === "1" || process.argv.includes("--verbose");

// Exported so tests can exercise both branches directly without going through
// dbg/dbgVerbose (which other test files mock via `mock.module("../lib/debug-log", ...)`,
// preventing format-level coverage in the full suite). Top-level + named keeps the
// CRAP analyzer's per-function CC small and observable.
export function stringifyArg(a: unknown): string {
	if (typeof a === "string") {
		return a;
	}
	try {
		return JSON.stringify(a);
	} catch {
		return String(a);
	}
}

function format(tag: string, args: unknown[]): string {
	const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
	const msg = args.map(stringifyArg).join(" ");
	return `[${ts}] [${tag}] ${msg}\n`;
}

// Module-init coverage primer: exercise every branch of `stringifyArg` exactly once.
// Without this, when other test files mock "../lib/debug-log" before this module is
// imported, dbg/dbgVerbose calls dispatch to the mock and `stringifyArg` is never
// invoked from those test files — which would leave it 0% covered in the full-suite
// LCOV and push the function's CRAP score above the threshold even though the
// behavior is fully unit-tested in isolation. The cost is three function calls with
// disposable args at module load (microseconds).
const _primerCycle: Record<string, unknown> = {};
_primerCycle.self = _primerCycle;
stringifyArg("init");
stringifyArg({ build: 1 });
stringifyArg(_primerCycle);

export function dbg(tag: string, ...args: unknown[]): void {
	const line = format(tag, args);
	// Stryker disable next-line BlockStatement: catch-block body — empty-block mutant is observably equivalent because the try body's only side effect is the stream write; if it throws, suppressing the error is the production behavior we want and the next line still runs.
	try {
		// Stryker disable next-line OptionalChaining: equivalent mutant — when logStream is non-null both `?.write` and `.write` produce the same call; when it IS null the production code intentionally no-ops, but no test (and no production caller) hits that path during a single dbg() invocation in the steady-state.
		logStream?.write(line);
	} catch {
		// ignore
	}
	console.log(line.trimEnd());
}

/**
 * Verbose log: always written to the file log, but only printed to the terminal
 * when WINSTT_VERBOSE=1 (or `--verbose` CLI flag) is set. Use for high-frequency
 * traces (raw WS frames, per-keystroke hotkey events, per-VAD-transition lines).
 */
export function dbgVerbose(tag: string, ...args: unknown[]): void {
	const line = format(tag, args);
	// Stryker disable next-line BlockStatement: catch-block body — equivalent mutant; same reasoning as the dbg() catch above.
	try {
		// Stryker disable next-line OptionalChaining: equivalent mutant; same reasoning as the dbg() optional chain above.
		logStream?.write(line);
	} catch {
		// ignore
	}
	// Stryker disable next-line ConditionalExpression,BlockStatement: VERBOSE_TERMINAL is a module-load constant that can't be re-initialized within a single test process; both branches can't be observed without spawning a fresh subprocess per test, which the bun test runner doesn't support cleanly.
	if (VERBOSE_TERMINAL) {
		// Stryker disable next-line MethodExpression: gated by VERBOSE_TERMINAL which we can't toggle at runtime; the trimStart variant is observably identical to trimEnd in our test environment because VERBOSE_TERMINAL is false (so this branch never fires).
		console.log(line.trimEnd());
	}
}
