/**
 * Faithful fake for `electron/lib/debug-log` used by tests.
 *
 * Same rationale as the other mocks in this folder: a partial shim leaks into
 * every later test that imports any debug-log export the partial doesn't
 * define. Tests that need to observe `dbg()` calls should spread this fake
 * and either override `dbg` or read from `globalThis.__testLogLines` (the
 * shared electron-log capture installed in `test/preload.ts`).
 */

const noopLog = {
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	verbose: () => undefined,
	debug: () => undefined,
	silly: () => undefined,
	log: () => undefined,
};

// Behaviour-faithful copies of the real string helpers. Inlined here so the
// mock doesn't have to import the real module (which would resolve through
// the mock again under bun:test's lookup).
function jsonStringifyOrString(value: unknown): string {
	try {
		return JSON.stringify(value) as string;
	} catch {
		return String(value);
	}
}
function identityString(value: unknown): string {
	return value as string;
}
function stringifyArg(value: unknown): string {
	return typeof value === "string" ? identityString(value) : jsonStringifyOrString(value);
}

export function debugLogMock(): Record<string, unknown> {
	return {
		dbg: () => undefined,
		dbgVerbose: () => undefined,
		getLogger: () => noopLog,
		jsonStringifyOrString,
		identityString,
		stringifyArg,
		default: noopLog,
	};
}
