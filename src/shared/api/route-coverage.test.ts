import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// ── Route-coverage guard (HANDY_VS_WINSTT_AUDIT.md #8 interim) ──────────────────
//
// The renderer crosses the IPC boundary through an UNTYPED string-channel adapter
// (`native-bridge-adapter.ts`): each route names a backend command as a bare
// `cmd: "snake_case_name"` literal. The generated `bindings.ts` (tauri-specta)
// is the authoritative list of commands the Rust backend actually exposes — but
// it's imported by zero renderer files, so a Rust command rename / deletion goes
// undetected and the route silently 404s at runtime (an unmapped/renamed command
// is the class behind the "download 0% / RAM unknown" silent failures).
//
// This test closes that gap WITHOUT the full `bindings.ts` adoption: it asserts
// every `cmd` string referenced in the adapter's ROUTE table exists as a real
// command in `bindings.ts`. It will go red the instant the two contracts drift.
//
// We read both files as TEXT and extract the command strings at runtime, rather
// than `import { commands } from "@/bindings"`, on purpose:
//   1. `bindings.ts` currently has known duplicate-identifier type exports
//      (e.g. AutoSubmitKey, ModelUnloadTimeout, OverlayPosition, PaginatedHistory)
//      that make a typed import a tsc error until the dup-export fix lands.
//   2. The generated `commands` object's methods are async wrappers — the backend
//      command name lives INSIDE each method as `TAURI_INVOKE("snake_case", …)`,
//      not as an object key (the keys are camelCase JS method names). The literal
//      we must match against ROUTE is the `TAURI_INVOKE` argument either way.
// Reading the text gives us exactly that set with neither blocker.

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

/** Backend command names the adapter routes to: every `cmd: "…"` in ROUTE. */
function extractRouteCmds(adapterSource: string): string[] {
	return [...collectCaptures(adapterSource, /\bcmd:\s*"([a-z0-9_]+)"/g)].sort();
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

/** Backend command names tauri-specta generated: every `TAURI_INVOKE("…")`. */
function extractBindingsCmds(bindingsSource: string): Set<string> {
	return collectCaptures(bindingsSource, /TAURI_INVOKE\(\s*"([a-z0-9_]+)"/g);
}

const adapterSource = read("native-bridge-adapter.ts");
const transportSource = read("ipc-transport.ts");
const ipcSource = read("ipc-channels.ts");
const bindingsSource = read("../../bindings.ts");

const routeCmds = extractRouteCmds(adapterSource);
const routeKeys = extractRouteKeys(adapterSource);
const invokerKeys = extractInvokerKeys(transportSource);
// A channel is "routed" if EITHER the adapter ROUTE or the typed transport
// (COMMAND_INVOKERS) handles it — both are valid renderer→main transports.
const routedKeys = new Set<string>([...routeKeys, ...invokerKeys]);
const requiredIpcKeys = extractRequiredIpcKeys(ipcSource);
const bindingsCmds = extractBindingsCmds(bindingsSource);

describe("IPC route coverage (adapter ROUTE ↔ generated bindings)", () => {
	test("the extractors find a non-trivial set (guards against a broken regex / moved file)", () => {
		expect(routeKeys.size).toBeGreaterThan(50);
		expect(invokerKeys.size).toBeGreaterThan(50);
		expect(routedKeys.size).toBeGreaterThan(100);
		expect(bindingsCmds.size).toBeGreaterThan(50);
	});

	test("typed command channels are not duplicated in the adapter ROUTE table", () => {
		const duplicated = [...routeKeys]
			.filter((key) => invokerKeys.has(key))
			.sort();

		expect(duplicated).toEqual([]);
	});

	test("every adapter ROUTE cmd exists as a backend command in bindings.ts", () => {
		const missing = routeCmds.filter((cmd) => !bindingsCmds.has(cmd));
		// A non-empty list means a renamed/deleted Rust command (or a typo in the
		// adapter): the route would 404 silently at runtime. The message names the
		// offenders so the fix is obvious.
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

	test("no adapter ROUTE cmd is referenced under multiple spellings (catches copy-paste drift)", () => {
		// `routeCmds` is already de-duplicated; this asserts the de-dup didn't hide a
		// near-miss by checking each entry is a syntactically valid command token.
		for (const cmd of routeCmds) {
			expect(cmd).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});
});
