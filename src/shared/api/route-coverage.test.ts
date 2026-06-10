import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// ── Route-coverage guard ────────────────────────────────────────────────────────
//
// The renderer crosses the IPC boundary two ways:
//   1. Typed transport — `COMMAND_INVOKERS` (ipc-transport.ts) and the adapter's
//      plugin/window routes (native-bridge-adapter.ts) call generated
//      `commands.METHOD(...)` bindings from `@/bindings`. tsc type-checks the
//      ARGUMENTS, but NOT that `METHOD` still exists after a Rust rename — a
//      deleted/renamed command keeps compiling against a `commands` shape that
//      drifts from the backend, then 404s at runtime (the class behind the
//      "download 0% / RAM unknown" silent failures).
//   2. Event/plugin/window routes — the adapter ROUTE table.
//
// This test closes gap 1 by asserting every `commands.METHOD` the renderer's IPC
// layer calls is a real generated command method in `bindings.ts`, and gap 2 by
// asserting every IPC channel with a bridge direction is routed by either the
// adapter ROUTE or the typed COMMAND_INVOKERS. It goes red the instant the
// renderer↔backend command contract drifts.
//
// We read the files as TEXT and extract identifiers at runtime rather than
// `import { commands } from "@/bindings"` because the generated `commands` object
// exposes camelCase JS method names; the assertion we need is "the method name
// the IPC layer references is one the generator emitted" — exactly what the text
// extraction gives us with no import-shape coupling.

const HERE = import.meta.dir; // …/src/shared/api

function read(relPath: string): string {
	return readFileSync(join(HERE, relPath), "utf8");
}

/** Collect capture-group-1 of every match of `re` in `source` into a Set. */
function collectCaptures(source: string, re: RegExp): Set<string> {
	const out = new Set<string>();
	for (const match of source.matchAll(re)) {
		const captured = match[1];
		if (captured !== undefined) {
			out.add(captured);
		}
	}
	return out;
}

/** IPC keys that the adapter routes: every `[IPC.KEY]:` in ROUTE. */
function extractRouteKeys(adapterSource: string): Set<string> {
	const start = adapterSource.indexOf("const ROUTE:");
	// The ROUTE table closes right before the event-reshape section; use that
	// comment as the stable end marker (the table no longer has a trailing
	// `normalizeArgs` helper — commands route through COMMAND_INVOKERS now).
	const end = adapterSource.indexOf("// ── Event payload reshape", start);
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("Could not isolate native bridge ROUTE table");
	}
	return collectCaptures(
		adapterSource.slice(start, end),
		/\[IPC\.([A-Z0-9_]+)\]\s*:/g,
	);
}

/**
 * IPC keys that the TYPED transport routes: every `[IPC.KEY]:` in the
 * `COMMAND_INVOKERS` map (ipc-transport.ts). A channel covered here is routed
 * end-to-end through a generated `commands.*` binding and does NOT need a
 * redundant `command` entry in the adapter ROUTE table — the invoker wins.
 */
function extractInvokerKeys(transportSource: string): Set<string> {
	const start = transportSource.indexOf("const COMMAND_INVOKERS");
	if (start === -1) {
		throw new Error("Could not isolate COMMAND_INVOKERS map");
	}
	const end = transportSource.indexOf("const CRITICAL_SEND_CHANNELS", start);
	const slice =
		end > start
			? transportSource.slice(start, end)
			: transportSource.slice(start);
	return collectCaptures(slice, /\[IPC\.([A-Z0-9_]+)\]\s*:/g);
}

/** IPC keys that declare an active bridge direction in IPC_DIRECTIONS. */
function extractRequiredIpcKeys(ipcSource: string): string[] {
	const out = new Set<string>();
	for (const match of ipcSource.matchAll(
		/\[IPC\.([A-Z0-9_]+)\]\s*:\s*\[([^\]]*)\]/g,
	)) {
		const key = match[1];
		const directions = match[2] ?? "";
		if (key !== undefined && /"(?:send|invoke|on|secure)"/.test(directions)) {
			out.add(key);
		}
	}
	return [...out].sort();
}

/**
 * Generated command METHOD names the IPC layer calls: every `commands.METHOD(`
 * referenced in a transport/adapter source. These are the camelCase JS method
 * names the renderer drives, which must each exist on the generated `commands`.
 */
function extractCommandMethodCalls(source: string): Set<string> {
	// Generated command methods are camelCase (lowercase first letter); the regex
	// requires that so a doc-comment placeholder like `commands.METHOD(...)` (all
	// caps) is not mistaken for a real call.
	return collectCaptures(source, /\bcommands\.([a-z][A-Za-z0-9]*)\s*\(/g);
}

/** Generated command METHOD names tauri-specta emitted: every `async method(`. */
function extractBindingsMethods(bindingsSource: string): Set<string> {
	const start = bindingsSource.indexOf("export const commands");
	if (start === -1) {
		throw new Error("Could not isolate the generated `commands` object");
	}
	// The `commands` object is followed by `export const events` in the generated
	// file; stop there so we don't pick up unrelated `async` helpers below it.
	const end = bindingsSource.indexOf("export const events", start);
	const slice =
		end > start
			? bindingsSource.slice(start, end)
			: bindingsSource.slice(start);
	return collectCaptures(slice, /^async\s+([A-Za-z][A-Za-z0-9]*)\s*\(/gm);
}

const adapterSource = read("native-bridge-adapter.ts");
const transportSource = read("ipc-transport.ts");
const ipcSource = read("ipc-channels.ts");
const bindingsSource = read("../../bindings.ts");

const routeKeys = extractRouteKeys(adapterSource);
const invokerKeys = extractInvokerKeys(transportSource);
// A channel is "routed" if EITHER the adapter ROUTE or the typed transport
// (COMMAND_INVOKERS) handles it — both are valid renderer→main transports.
const routedKeys = new Set<string>([...routeKeys, ...invokerKeys]);
const requiredIpcKeys = extractRequiredIpcKeys(ipcSource);

// Every generated command method the renderer's IPC layer invokes (transport map
// + adapter plugin/window routes).
const calledMethods = new Set<string>([
	...extractCommandMethodCalls(transportSource),
	...extractCommandMethodCalls(adapterSource),
]);
const bindingsMethods = extractBindingsMethods(bindingsSource);

describe("IPC route coverage (typed transport ↔ generated bindings)", () => {
	test("the extractors find a non-trivial set (guards against a broken regex / moved file)", () => {
		expect(routeKeys.size).toBeGreaterThan(50);
		expect(invokerKeys.size).toBeGreaterThan(50);
		expect(routedKeys.size).toBeGreaterThan(100);
		expect(bindingsMethods.size).toBeGreaterThan(100);
		// The transport calls dozens of commands; the adapter a handful. A tiny set
		// here means the `commands.METHOD(` regex broke or a file moved.
		expect(calledMethods.size).toBeGreaterThan(50);
	});

	test("typed command channels are not duplicated in the adapter ROUTE table", () => {
		const duplicated = [...routeKeys]
			.filter((key) => invokerKeys.has(key))
			.sort();

		expect(duplicated).toEqual([]);
	});

	test("every `commands.METHOD` the IPC layer calls exists in generated bindings.ts", () => {
		const missing = [...calledMethods]
			.filter((method) => !bindingsMethods.has(method))
			.sort();
		// A non-empty list means a renamed/deleted Rust command (or a typo in a
		// transport/adapter wrapper): the call would no longer reach the backend.
		// The message names the offenders so the fix is obvious.
		expect(missing).toEqual([]);
	});

	test("every IPC channel with a bridge direction has a route (adapter OR typed)", () => {
		const missing = requiredIpcKeys.filter((key) => !routedKeys.has(key));
		// A missing event route means listeners never fire. A renderer→main
		// command channel is "routed" by either an adapter ROUTE entry or a typed
		// COMMAND_INVOKERS entry — the migration moves channels from the former to
		// the latter, so both count.
		expect(missing).toEqual([]);
	});
});
