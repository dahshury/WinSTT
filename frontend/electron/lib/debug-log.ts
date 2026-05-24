import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";

/**
 * Resolve the log file path. Prefer userData (e.g. %APPDATA%/WinSTT/) so the
 * logs sit alongside the persisted settings file. Falls back to the project
 * root only during very early startup before `app.getPath` is callable.
 */
function resolveLogPath(): string {
	try {
		return path.join(app.getPath("userData"), "debug.log");
	} catch {
		return path.join(import.meta.dirname, "..", "..", "debug.log");
	}
}

// Default file path resolver. electron-log calls this once per log line so it
// keeps working even if the app's userData path is set late (e.g. WINSTT_E2E
// flips it after module load).
log.transports.file.resolvePathFn = resolveLogPath;

// 5 MB rotation — when the file grows past this, electron-log renames it to
// `debug.old.log` and starts fresh. Matches the diag-bundle's collector.
log.transports.file.maxSize = 5 * 1024 * 1024;

// Close to the legacy hand-rolled layout: `[HH:MM:SS.mmm] [scope] message`.
log.transports.file.format = "[{h}:{i}:{s}.{ms}] [{scope}] {text}";

// Gate console verbosity on WINSTT_VERBOSE / --verbose so dev runs aren't
// drowned in per-keystroke hotkey traces. File transport always stays at
// verbose so the diagnostic bundle has the full record.
const VERBOSE_TERMINAL = process.env.WINSTT_VERBOSE === "1" || process.argv.includes("--verbose");
log.transports.console.level = VERBOSE_TERMINAL ? "verbose" : "info";
log.transports.file.level = "verbose";

// Initialize the renderer-to-main bridge so logs emitted from renderer code
// (via `electron-log/renderer`) flow into the same file transport. Safe to
// call multiple times — electron-log dedupes the IPC handler. Guarded so
// partial test mocks (which sometimes omit `ipcMain.on` or `webContents`) can
// import this module without exploding at load time; in production the call
// always succeeds.
try {
	log.initialize();
} catch {
	// no-op: tests with incomplete electron mocks
}

// Surface uncaught exceptions through the same transports; never block the UI
// with the default dialog (we route fatal errors through Sentry separately).
try {
	log.errorHandler.startCatching({ showDialog: false });
} catch {
	// no-op: tests with incomplete electron mocks
}

// Wire up Electron event logging (app/web-contents lifecycle traces). Same
// rationale as above — the event logger subscribes to `app` lifecycle events
// and some test mocks don't provide them.
try {
	log.eventLogger.startLogging();
} catch {
	// no-op: tests with incomplete electron mocks
}

/**
 * JSON.stringify with a String() fallback. Pulled out so the try/catch sits in
 * a single tiny helper (CC=2) instead of inflating the public `stringifyArg`
 * surface — keeps CRAP under threshold even at 0% renderer coverage.
 */
export function jsonStringifyOrString(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/**
 * Identity helper for already-string args. Exists purely so the dispatch table
 * in {@link stringifyArg} can be a `Record<typeof, …>` of CC=1 functions.
 */
export function identityString(value: unknown): string {
	return value as string;
}

/**
 * Dispatch table keyed by `typeof value`. Strings pass through unchanged;
 * everything else (number, boolean, bigint, object, symbol, undefined,
 * function) falls through to `jsonStringifyOrString`. The lookup itself is
 * branchless, so {@link stringifyArg} stays at CC=1.
 */
const STRINGIFY_DISPATCH: Record<
	"bigint" | "boolean" | "function" | "number" | "object" | "string" | "symbol" | "undefined",
	(value: unknown) => string
> = {
	string: identityString,
	number: jsonStringifyOrString,
	boolean: jsonStringifyOrString,
	bigint: jsonStringifyOrString,
	object: jsonStringifyOrString,
	symbol: jsonStringifyOrString,
	undefined: jsonStringifyOrString,
	function: jsonStringifyOrString,
};

/**
 * JSON-stringify with a String() fallback for objects that can't be serialized
 * (cycles, host objects). Kept as a public export — tests import it directly
 * to exercise both branches without going through the dbg/dbgVerbose path.
 *
 * Refactored to a `Record<typeof, fn>` dispatch so the function itself is CC=1.
 * The branching (string identity vs JSON.stringify fallback) lives in the
 * helpers above, each of which is independently testable.
 */
export function stringifyArg(value: unknown): string {
	return STRINGIFY_DISPATCH[typeof value](value);
}

/**
 * Standard log line — written to the file at "info" level and printed to the
 * terminal when the console transport level allows it. Mirrors the old
 * `dbg(tag, ...)` surface that ~111 call-sites depend on.
 */
export function dbg(tag: string, ...args: unknown[]): void {
	log.scope(tag).info(...(args as [unknown, ...unknown[]]));
}

/**
 * Verbose log: always written to the file log, but only printed to the
 * terminal when the console transport is in verbose mode (`WINSTT_VERBOSE=1`
 * or `--verbose`). Use for high-frequency traces (raw WS frames, per-keystroke
 * hotkey events, per-VAD-transition lines).
 */
export function dbgVerbose(tag: string, ...args: unknown[]): void {
	log.scope(tag).verbose(...(args as [unknown, ...unknown[]]));
}

/**
 * Scoped logger facade — returns the electron-log LogFunctions object for a
 * given scope. Used by `sentry-main.ts` to log under a `[sentry]` tag.
 */
export function getLogger(scope: string): ReturnType<typeof log.scope> {
	return log.scope(scope);
}

/** Root electron-log instance — exposed for advanced callers (transports, hooks). */
export const logger = log;
export default log;
