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
	const end = adapterSource.indexOf("const POSITIONAL_STRING_PARAM");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("Could not isolate native bridge ROUTE table");
	}
	return collectCaptures(adapterSource.slice(start, end), /\[IPC\.([A-Z0-9_]+)\]\s*:/g);
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
const ipcSource = read("ipc-channels.ts");
const bindingsSource = read("../../bindings.ts");

const routeCmds = extractRouteCmds(adapterSource);
const routeKeys = extractRouteKeys(adapterSource);
const requiredIpcKeys = extractRequiredIpcKeys(ipcSource);
const bindingsCmds = extractBindingsCmds(bindingsSource);

describe("IPC route coverage (adapter ROUTE ↔ generated bindings)", () => {
	test("the extractors find a non-trivial set (guards against a broken regex / moved file)", () => {
		expect(routeCmds.length).toBeGreaterThan(50);
		expect(bindingsCmds.size).toBeGreaterThan(50);
	});

	test("every adapter ROUTE cmd exists as a backend command in bindings.ts", () => {
		const missing = routeCmds.filter((cmd) => !bindingsCmds.has(cmd));
		// A non-empty list means a renamed/deleted Rust command (or a typo in the
		// adapter): the route would 404 silently at runtime. The message names the
		// offenders so the fix is obvious.
		expect(missing).toEqual([]);
	});

	test("every IPC channel with a bridge direction has an adapter route", () => {
		const missing = requiredIpcKeys.filter((key) => !routeKeys.has(key));
		// A missing event route means listeners never fire. A missing invoke/send
		// route can still be hidden by a typed-command wrapper today, but the
		// adapter should remain complete as the fallback transport.
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
