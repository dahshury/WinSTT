#!/usr/bin/env bun

/**
 * WS contract drift detector.
 *
 * Compares every ``"type": "<name>"`` literal emitted by the Python server
 * (via ``state.audio_queue.put(...)`` — i.e. anything flowing through the
 * WS data channel that hits ``validateServerEvent`` on the renderer) against
 * the Zod discriminated union declared in
 * ``electron/ws/contract.ts``. If the server emits an event type the
 * renderer's ``serverEventSchema`` doesn't validate, this script exits with
 * a non-zero status.
 *
 * Rationale: ``Pattern D`` auto-derives the renderer's runtime
 * ``SUPPORTED_EVENT_TYPES`` array from the Zod union (so the array can't
 * drift from the schema *within* TypeScript). But the server is Python —
 * the type-system bridge stops at the WS boundary. Without a check like
 * this, adding a new server emit silently breaks runtime validation in
 * every consumer (visible as the recurring
 * ``[ws/contract] rejected server event (type=...)`` warning).
 *
 * Run via ``bun check:ws-contract`` (added to ``package.json`` alongside
 * ``check:fsd``). Wire it into CI; locally it's a sub-second sanity check.
 *
 * Out of scope (intentionally):
 *   - Per-event PAYLOAD validation. Verifying that the server's JSON
 *     fields match the renderer's Zod object shape would require running
 *     real recordings or a fixture suite — covered today by the
 *     ``contract.test.ts`` round-trip tests, not by this static check.
 *   - Control-channel command/response shapes. Those go through a
 *     separate code path (``control_handler.py``) with its own contract.
 *   - TTS / file-transcribe events known to bypass ``validateServerEvent``
 *     by consuming on a dedicated handler before the validator sees them
 *     — list them in ``KNOWN_NON_VALIDATED`` below.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SERVER_SRC_DIRS = [resolve(import.meta.dir, "..", "..", "server", "src", "stt_server")];

const CALLBACK_BRIDGE_FILE = resolve(
	import.meta.dir,
	"..",
	"..",
	"server",
	"src",
	"stt_server",
	"callbacks.py"
);

const CALLBACK_MAP_FILE = resolve(
	import.meta.dir,
	"..",
	"..",
	"server",
	"src",
	"recorder",
	"bootstrap.py"
);

const CONTRACT_FILE = resolve(import.meta.dir, "..", "electron", "ws", "contract.ts");

/**
 * Events emitted by the server but intentionally NOT validated by the WS
 * contract validator. Reasons:
 *   - ``server_ready`` is the boot handshake — handled before
 *     ``validateServerEvent`` is wired up.
 *   - Control-channel responses (commands the renderer initiates) flow
 *     through a different schema.
 *   - Control-channel command echoes (``init_tts``, ``shutdown_tts``,
 *     ``tts_synthesize``, ``tts_cancel``, ``tts_install_pause``,
 *     ``tts_install_resume``, ``tts_install_cancel``) are sent via
 *     ``ws.send`` on the control channel, not enqueued on the data
 *     channel — they never reach ``validateServerEvent``.
 *   - ``tts_chunk`` is the JSON header of a binary PCM frame on the
 *     data channel (parsed by the chunk handler before validation).
 *
 * If you intentionally route a new event past the data-channel validator,
 * add it here with a one-line justification. Don't bypass it silently.
 */
const KNOWN_NON_VALIDATED: ReadonlySet<string> = new Set([
	"server_ready", // boot handshake
	"init_tts", // control-channel reply
	"shutdown_tts", // control-channel reply
	"tts_synthesize", // control-channel reply (ack)
	"tts_cancel", // control-channel reply
	"tts_chunk", // binary-frame JSON header (not a JSON event)
	"tts_install_pause", // control-channel reply
	"tts_install_resume", // control-channel reply
	"tts_install_cancel", // control-channel reply
]);

const TYPE_LITERAL_RE = /"type":\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g;
const Z_LITERAL_RE = /z\.literal\("([a-zA-Z_][a-zA-Z0-9_]*)"\)/g;

function walk(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (name.endsWith(".py")) {
			out.push(full);
		}
	}
}

function collectServerEmits(dirs: readonly string[]): Set<string> {
	const found = new Set<string>();
	for (const dir of dirs) {
		const files: string[] = [];
		walk(dir, files);
		for (const file of files) {
			const src = readFileSync(file, "utf8");
			for (const match of src.matchAll(TYPE_LITERAL_RE)) {
				const name = match[1];
				if (name) {
					found.add(name);
				}
			}
		}
	}
	return found;
}

/**
 * Server emits sourced via the auto-derived ``_SIMPLE_EVENTS`` mechanism
 * in ``stt_server/callbacks.py`` (``_make_simple_event_callback`` builds
 * ``{"type": event_type}`` at runtime from ``CALLBACK_EVENT_MAP`` keys —
 * minus the explicitly-listed ``_NON_SIMPLE_CALLBACKS`` set). The script
 * can't statically grep these as literal strings; reconstruct the set by
 * parsing both files.
 */
const ON_CALLBACK_KEY_RE = /"(on_[a-z_][a-z0-9_]*)":/g;
const NON_SIMPLE_BLOCK_RE = /_NON_SIMPLE_CALLBACKS:[^{]*\{([\s\S]*?)\}/;

function collectAutoDerivedSimpleEmits(): Set<string> {
	const bridgeSrc = readFileSync(CALLBACK_BRIDGE_FILE, "utf8");
	const blockMatch = bridgeSrc.match(NON_SIMPLE_BLOCK_RE);
	const nonSimple = new Set<string>();
	if (blockMatch?.[1]) {
		for (const m of blockMatch[1].matchAll(/"(on_[a-z_][a-z0-9_]*)"/g)) {
			const key = m[1];
			if (key) {
				nonSimple.add(key);
			}
		}
	}
	const mapSrc = readFileSync(CALLBACK_MAP_FILE, "utf8");
	const out = new Set<string>();
	for (const m of mapSrc.matchAll(ON_CALLBACK_KEY_RE)) {
		const key = m[1];
		if (!key || nonSimple.has(key)) {
			continue;
		}
		out.add(key.slice("on_".length));
	}
	return out;
}

function collectRendererSchemas(file: string): Set<string> {
	const src = readFileSync(file, "utf8");
	const found = new Set<string>();
	for (const match of src.matchAll(Z_LITERAL_RE)) {
		const name = match[1];
		if (name) {
			found.add(name);
		}
	}
	return found;
}

function report(missing: readonly string[], stale: readonly string[]): void {
	if (missing.length === 0 && stale.length === 0) {
		console.log("✓ WS contract in sync — every server emit has a matching renderer schema.");
		return;
	}
	if (missing.length > 0) {
		console.error(`✗ ${missing.length} server emit(s) NOT validated by the renderer's Zod union:`);
		for (const m of missing) {
			console.error(`    - ${m}`);
		}
		console.error(
			"  Fix: add a Zod schema to electron/ws/contract.ts and append it to serverEventSchema."
		);
		console.error(
			"  Or: if the event is consumed by a dedicated handler before validateServerEvent,"
		);
		console.error("       add it to KNOWN_NON_VALIDATED in scripts/check-ws-contract.ts.");
	}
	if (stale.length > 0) {
		console.warn(
			`⚠ ${stale.length} renderer schema(s) with no matching server emit (likely dead):`
		);
		for (const s of stale) {
			console.warn(`    - ${s}`);
		}
	}
}

function main(): void {
	const literalEmits = collectServerEmits(SERVER_SRC_DIRS);
	const simpleEmits = collectAutoDerivedSimpleEmits();
	const serverEmits = new Set<string>([...literalEmits, ...simpleEmits]);
	const rendererSchemas = collectRendererSchemas(CONTRACT_FILE);

	const missing = [...serverEmits]
		.filter((e) => !rendererSchemas.has(e) && !KNOWN_NON_VALIDATED.has(e))
		.sort();

	const stale = [...rendererSchemas].filter((s) => !serverEmits.has(s)).sort();

	report(missing, stale);

	if (missing.length > 0) {
		process.exit(1);
	}
}

main();
