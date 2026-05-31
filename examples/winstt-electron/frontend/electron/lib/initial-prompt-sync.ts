import type { SttClient } from "../ws/stt-client";
import { dbg } from "./debug-log";
import { buildInitialPromptPair, type RawDictEntry } from "./initial-prompt";
import { getStoreRaw, store } from "./store";

/**
 * Per-utterance dynamic context tail. Set by the context-capture
 * pipeline (in relay.ts) when `general.contextAwareness` is on and the
 * UIA snapshot resolves; cleared when the dictation session ends. Kept
 * module-level so it survives across rebuilds — the alternative would
 * be threading a callback through every consumer of pushInitialPrompts.
 *
 * Module-private to enforce the "only the context-capture pipeline
 * touches this" invariant. Callers go through
 * {@link setVolatileContextTail} / {@link clearVolatileContextTail}.
 */
let volatileContextTail = "";

/** Pull all three inputs out of the store + build the composed pair. */
function readCurrentInitialPrompt(): { main: string; realtime: string } {
	const dictionary = store.get("dictionary") as RawDictEntry[] | undefined;
	const mainPrefixRaw = getStoreRaw("model.initialPrompt");
	const realtimePrefixRaw = getStoreRaw("model.initialPromptRealtime");
	return buildInitialPromptPair({
		contextTail: volatileContextTail,
		dictionary,
		mainPrefix: typeof mainPrefixRaw === "string" ? mainPrefixRaw : "",
		realtimePrefix: typeof realtimePrefixRaw === "string" ? realtimePrefixRaw : "",
	});
}

/**
 * Push a per-utterance prior-text fragment into the next composed
 * prompt and re-sync it to the server. No-op on empty input (callers
 * use {@link clearVolatileContextTail} to clear).
 *
 * Idempotent: pushing the same tail twice produces one set_parameter
 * round-trip (because `pushInitialPrompts` always pushes regardless;
 * the server treats identical updates as cheap).
 */
export function setVolatileContextTail(client: SttClient, tail: string): void {
	if (tail.length === 0) {
		return;
	}
	if (volatileContextTail === tail) {
		return;
	}
	volatileContextTail = tail;
	pushInitialPrompts(client);
}

/**
 * Drop the volatile context tail and re-sync the base prompt to the
 * server. Called when a dictation session ends (fullSentence consumed,
 * cancel, listen-mode passthrough) so the next non-context-aware
 * utterance doesn't accidentally inherit stale prior-text.
 */
export function clearVolatileContextTail(client: SttClient): void {
	if (volatileContextTail === "") {
		return;
	}
	volatileContextTail = "";
	pushInitialPrompts(client);
}

/** Test-only — drop the volatile state so suites don't leak across tests. */
export function __resetVolatileContextForTesting__(): void {
	volatileContextTail = "";
}

// Re-exported so existing callers (stt-process.ts) keep importing from
// the same module they did when `readCurrentInitialPrompt` lived in
// `initial-prompt.ts`.
export { readCurrentInitialPrompt };

/**
 * Push the current composed initial-prompt pair to the running STT
 * server via the WebSocket control channel. Idempotent — called both
 * on initial connection and on every dictionary / static-prompt edit.
 *
 * No-op when the client is not connected: the server picks up the same
 * values via CLI args on the next spawn (see `applyInitialPromptFlags`
 * in stt-process.ts), so a dictionary edit made while the server is
 * down still lands on its next start.
 */
function pushInitialPrompts(client: SttClient): void {
	if (!client.isConnected) {
		return;
	}
	const composed = readCurrentInitialPrompt();
	// Empty-string is the canonical "clear the prompt" payload. The
	// server's facade setter treats empty/None identically, so we always
	// push something — that way a dictionary deletion clears the bias
	// instead of leaving the old vocab in the live transcriber.
	client.setParameter("initial_prompt", composed.main);
	client.setParameter("initial_prompt_realtime", composed.realtime);
	dbg(
		"initial-prompt",
		`pushed main=${composed.main.length} chars, realtime=${composed.realtime.length} chars`
	);
}

/**
 * Wire up live propagation of the composed initial-prompt to the
 * running server. Pushes:
 *
 *   - Once at install time (in case the server is already up by then).
 *   - On every ``server-ready`` event (so a freshly-spawned server
 *     gets the current prompt even if the user hasn't touched the
 *     dictionary since boot — CLI args + this push are belt-and-
 *     braces against any race).
 *   - On change to `dictionary` (the auto-add UI's accepted nouns
 *     reach the ASR live this way).
 *   - On change to `model.initialPrompt` / `model.initialPromptRealtime`
 *     (the user-typed static prefix in settings).
 *
 * Returns a cleanup function that detaches every watcher; used by the
 * relay's setupRelay teardown path so a disposed relay doesn't keep
 * the store listeners alive.
 */
export function installInitialPromptSync(client: SttClient): () => void {
	const push = () => pushInitialPrompts(client);
	push();
	const offDict = store.onDidChange("dictionary", push);
	const offMain = store.onDidChange("model.initialPrompt" as never, push);
	const offRealtime = store.onDidChange("model.initialPromptRealtime" as never, push);
	client.on("server-ready", push);
	return () => {
		offDict();
		offMain();
		offRealtime();
		client.off("server-ready", push);
	};
}
