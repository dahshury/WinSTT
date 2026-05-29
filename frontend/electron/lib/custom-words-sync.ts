import type { SttClient } from "../ws/stt-client";
import { dbg } from "./debug-log";
import { getStoreRaw, store } from "./store";

interface RawDictEntry {
	replacement?: string;
	term?: string;
}

/**
 * Derive the server-side custom-words list from the persisted dictionary.
 *
 * Only entries WITHOUT a `replacement` field are considered — those are
 * the "vocab biasing" entries. Entries WITH `replacement` are
 * deterministic find-and-replace pairs handled by the Electron-side
 * post-processor (see `text-processing.ts`) AFTER the LLM modifier
 * pipeline; sending them to the server-side fuzzy matcher would double-
 * correct them.
 *
 * Returns trimmed, deduplicated terms in the order the user added them.
 */
function readCurrentCustomWords(): string[] {
	const dictionary = store.get("dictionary") as RawDictEntry[] | undefined;
	if (!dictionary?.length) {
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	// Kept as a single inline filter-and-dedupe loop on purpose: the three
	// reject conditions (blank term / has a replacement / already seen) are a
	// cohesive single concept ("is this a fresh vocab-bias term?"); extracting
	// them into a predicate helper would add indirection without clarifying.
	for (const entry of dictionary) {
		const term = typeof entry.term === "string" ? entry.term.trim() : "";
		const replacement = typeof entry.replacement === "string" ? entry.replacement.trim() : "";
		if (!term || replacement || seen.has(term)) {
			continue;
		}
		seen.add(term);
		out.push(term);
	}
	return out;
}

function readCurrentThreshold(): number {
	const raw = getStoreRaw("general.wordCorrectionThreshold");
	// Default mirrors the server's TextCorrectionConfig default. A
	// missing-key on a stale settings file should fall back to the same
	// value the matcher would use if the field were never sent — keeps
	// behaviour stable across an upgrade that lands the schema entry but
	// doesn't yet bump the persisted store version.
	return typeof raw === "number" ? raw : 0.18;
}

function readCustomFillerWords(): string[] {
	const raw = store.get("general.customFillerWords") as unknown;
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			continue;
		}
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Push the live custom-word list + threshold to the STT server.
 *
 * Idempotent — called both on initial connection and on every relevant
 * settings edit (dictionary entries added/removed, threshold slider
 * moved). No-op when the client is not connected: the next spawn will
 * pick the same values up via CLI flags, and a reconnect re-fires
 * `server-ready` which re-pushes.
 */
function pushCustomWords(client: SttClient): void {
	if (!client.isConnected) {
		return;
	}
	const words = readCurrentCustomWords();
	const threshold = readCurrentThreshold();
	const customFillerWords = readCustomFillerWords();
	// Always push something — an emptied dictionary should clear the
	// matcher rather than leave a stale word list active. Mirrors the
	// initial-prompt sync's "always-push" semantics.
	client.setParameter("custom_words", words);
	client.setParameter("word_correction_threshold", threshold);
	// NOTE: `filter_fillers` is intentionally NOT pushed here. It now rides the
	// renderer's `syncToServer` (sttSetParameter from the live settings store)
	// because this electron-main path read a STALE electron-store value in the
	// long-running process — it pushed `filter_fillers=true` while disk held
	// `false`, so the "Remove Filler Words" toggle never reached the recorder.
	// See `features/update-settings/lib/sync-actions.ts` → syncTextCorrectionParams.
	client.setParameter("custom_filler_words", customFillerWords);
	dbg(
		"custom-words",
		`pushed ${words.length} words (thr ${threshold.toFixed(2)}), ` +
			`custom-fillers=${customFillerWords.length}`
	);
}

/**
 * Wire up live propagation of the deterministic custom-word corrector
 * configuration to the running server. Pushes:
 *
 *   - Once at install time (in case the server is already up by then).
 *   - On every `server-ready` event (a freshly-spawned server picks the
 *     live list up immediately without waiting for the user to touch
 *     settings).
 *   - On change to `dictionary` (add/remove vocab terms).
 *   - On change to `general.wordCorrectionThreshold` (slider tweaks).
 *
 * Returns a cleanup function that detaches every watcher; used by the
 * relay's teardown path so a disposed relay doesn't keep the store
 * listeners alive.
 */
export function installCustomWordsSync(client: SttClient): () => void {
	const push = () => {
		pushCustomWords(client);
	};
	push();
	const offDict = store.onDidChange("dictionary", push);
	const offThreshold = store.onDidChange("general.wordCorrectionThreshold" as never, push);
	// `general.filterFillers` is watched/pushed by the renderer's syncToServer
	// now (see pushCustomWords note) — not here.
	const offCustomFillers = store.onDidChange("general.customFillerWords" as never, push);
	client.on("server-ready", push);
	return () => {
		offDict();
		offThreshold();
		offCustomFillers();
		client.off("server-ready", push);
	};
}
