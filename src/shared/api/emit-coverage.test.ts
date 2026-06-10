import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// ── Emit-coverage guard (the test that would have caught the prefix-drift bugs) ──
//
// Backend events cross the IPC boundary as raw STRINGS: Rust emits `app.emit(name,
// …)` and the renderer listens via the adapter ROUTE `event: "name"` value. tsc
// CANNOT see across this boundary — twice in this repo's history the renderer
// listened on one spelling (`stt:vad-sensitivity-adapted`) while the backend
// emitted another, and the event silently never arrived. There was no test.
//
// This test asserts BOTH directions of the contract:
//   A) Every event the renderer ROUTE listens on is actually emitted by the
//      backend (a string literal in `src-tauri/src/**`, OR a value of a const in
//      the canonical `names` module) — or it is an explicitly-allowlisted dead
//      route (documented below).
//   B) Every canonical backend event name (`names::*` in events.rs) has a
//      frontend listener (a ROUTE event value or an adapter `listen("…")` call)
//      — or it is an explicitly-allowlisted Rust-internal event.
//
// New prefix drift (rename one side, forget the other) fails this test instead of
// shipping a silently-dead event. The allowlists FREEZE today's known dead/internal
// edges so the guard stays green now and goes red only on NEW drift.

const HERE = import.meta.dir; // …/src/shared/api
const SRC_TAURI = join(HERE, "..", "..", "..", "src-tauri", "src");

function read(relPath: string): string {
	return readFileSync(join(HERE, relPath), "utf8");
}

/** Recursively collect every `.rs` file under `dir`. */
function rustFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...rustFiles(full));
		} else if (entry.endsWith(".rs")) {
			out.push(full);
		}
	}
	return out;
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

// ── Frontend side ───────────────────────────────────────────────────────────────
const adapterSource = read("native-bridge-adapter.ts");

/** Event strings the renderer ROUTE listens on: every `event: "…"` in ROUTE. */
function routeEventNames(): Set<string> {
	const start = adapterSource.indexOf("const ROUTE:");
	const end = adapterSource.indexOf("// ── Event payload reshape", start);
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("Could not isolate native bridge ROUTE table");
	}
	return collectCaptures(
		adapterSource.slice(start, end),
		/event:\s*"([^"]+)"/g,
	);
}

/** Event strings the adapter listens on directly via `evt.listen("…")`. */
function adapterListenNames(): Set<string> {
	return collectCaptures(adapterSource, /evt\.listen\(\s*"([^"]+)"/g);
}

// ── Backend side ─────────────────────────────────────────────────────────────────
const rustSources = rustFiles(SRC_TAURI).map((f) => readFileSync(f, "utf8"));
const allRust = rustSources.join("\n");

/**
 * Every event-name string the backend can emit: a) `namespace:kebab` (or legacy
 * `snake_case`) quoted literals anywhere in the Rust source (helper bodies hold
 * the literal even when the call site is a wrapper), PLUS b) the VALUES of the
 * consts in the canonical `names` module (events emitted via `names::CONST` carry
 * no literal at the emit site).
 */
function backendEmittableNames(): Set<string> {
	const out = new Set<string>([...namesModuleValues()]);
	// Quoted strings shaped like an event name (contains a `:` or a `-`/`_`
	// kebab/snake separator, lowercase). Broad on purpose: a string that merely
	// LOOKS like an event name is a harmless extra in the haystack; the assertion
	// only checks ROUTE membership, so over-collection can't cause a false PASS of
	// a genuinely-missing emit, only avoid a false FAIL.
	for (const m of allRust.matchAll(/"([a-z][a-z0-9-]*(?::[a-z0-9-]+)+)"/g)) {
		if (m[1] !== undefined) {
			out.add(m[1]);
		}
	}
	return out;
}

/** Values of the `pub const NAME: &str = "value";` entries in the names module. */
function namesModuleValues(): Set<string> {
	const eventsRs = readFileSync(
		join(SRC_TAURI, "winstt", "commands", "events.rs"),
		"utf8",
	);
	const start = eventsRs.indexOf("pub mod names");
	if (start === -1) {
		throw new Error("Could not find the `names` module in events.rs");
	}
	// The module body ends at its closing brace; the next top-level item is the
	// `emit_paste_error` fn doc comment. Slice to there to stay inside the module.
	const end = eventsRs.indexOf("/// Emit the shared", start);
	const slice =
		end > start ? eventsRs.slice(start, end) : eventsRs.slice(start);
	return collectCaptures(
		slice,
		/pub const [A-Z0-9_]+:\s*&str\s*=\s*"([^"]+)"/g,
	);
}

// ── Allowlists ───────────────────────────────────────────────────────────────────
//
// A) ROUTE events the renderer listens on that the backend never emits — known
//    dead/vestigial routes (NOT new drift). Each is a candidate for removal but is
//    pre-existing; freezing them here keeps the guard green while still catching a
//    NEW unmatched ROUTE event.
const ROUTE_EVENTS_WITHOUT_BACKEND_EMITTER = new Set<string>([
	// File transcription uses the `file:queue-*` channels; these `file:transcription-*`
	// ROUTE entries are vestigial (no backend emitter).
	"file:transcription-progress",
	"file:transcription-complete",
	"file:transcription-error",
	// Clamshell lid open/close is handled internally (mic-swap); never pushed.
	"lid:closed",
	"lid:opened",
	// Model catalogs are pulled via invoke commands, not pushed as events.
	"llm:catalog",
	"stt:model-catalog",
	// Only diarization-toggle started/completed are emitted; -failed never fires.
	"stt:diarization-toggle-failed",
]);

// B) Canonical backend event names with no frontend listener — Rust-internal
//    events (consumed by another Rust listener) or splash-window-direct pushes.
const BACKEND_EVENTS_WITHOUT_FRONTEND_LISTENER = new Set<string>([
	// model:state-changed is consumed by a Rust listener (lib.rs) to refresh the
	// tray menu; the renderer doesn't subscribe.
	"model:state-changed",
	// realtime:stabilized is emitted for parity but the renderer currently consumes
	// only realtime:update (the live-preview pane).
	"realtime:stabilized",
	// Paste/recording errors and overlay show/hide are emitted for parity; the
	// renderer paints overlay state from its stores and has no dedicated listener.
	"output:paste-error",
	"recording:error",
	"overlay:show",
	"overlay:hide",
	// Startup progress drives the splash window via direct JS eval (splash.rs); the
	// emitted event is a parity broadcast with no React listener.
	"startup:progress",
	"startup:complete",
]);

// ── Tests ─────────────────────────────────────────────────────────────────────────
const route = routeEventNames();
const emittable = backendEmittableNames();
const names = namesModuleValues();
const listened = new Set<string>([...route, ...adapterListenNames()]);

describe("IPC emit coverage (renderer ROUTE ↔ backend emits)", () => {
	test("the extractors find a non-trivial set (guards against a broken regex / moved file)", () => {
		expect(route.size).toBeGreaterThan(50);
		expect(emittable.size).toBeGreaterThan(50);
		expect(names.size).toBeGreaterThan(5);
		expect(rustSources.length).toBeGreaterThan(100);
	});

	test("every ROUTE event the renderer listens on is emitted by the backend (or allowlisted)", () => {
		const missing = [...route]
			.filter(
				(ev) =>
					!emittable.has(ev) && !ROUTE_EVENTS_WITHOUT_BACKEND_EMITTER.has(ev),
			)
			.sort();
		// A non-empty list = the renderer listens on a string the backend never
		// emits → the event silently never arrives (the historical prefix-drift bug).
		// Either fix the spelling on one side, or (if intentionally dead) add it to
		// ROUTE_EVENTS_WITHOUT_BACKEND_EMITTER with a reason.
		expect(missing).toEqual([]);
	});

	test("every canonical backend event name has a frontend listener (or is allowlisted)", () => {
		const orphaned = [...names]
			.filter(
				(ev) =>
					!listened.has(ev) &&
					!BACKEND_EVENTS_WITHOUT_FRONTEND_LISTENER.has(ev),
			)
			.sort();
		// A non-empty list = the backend emits a canonical event no renderer route
		// listens on → dead emit. Wire a ROUTE/listen, or (if Rust-internal) add it
		// to BACKEND_EVENTS_WITHOUT_FRONTEND_LISTENER with a reason.
		expect(orphaned).toEqual([]);
	});

	test("allowlists are not stale (every entry still applies)", () => {
		// A ROUTE allowlist entry is stale if the backend now DOES emit it (drift
		// resolved → remove the entry).
		const staleRoute = [...ROUTE_EVENTS_WITHOUT_BACKEND_EMITTER].filter((ev) =>
			emittable.has(ev),
		);
		expect(staleRoute).toEqual([]);
		// A backend allowlist entry is stale if it's no longer a canonical name, or
		// a frontend listener was added.
		const staleBackend = [...BACKEND_EVENTS_WITHOUT_FRONTEND_LISTENER].filter(
			(ev) => !names.has(ev) || listened.has(ev),
		);
		expect(staleBackend).toEqual([]);
	});
});
