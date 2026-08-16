/**
 * Pure helpers extracted from LlmSettingsPanel for testability.
 *
 * These hold the panel's branchy display-logic. Keeping them pure (no JSX, no
 * hooks, no side effects) makes them exhaustively unit-testable.
 */

import { canonicalOllamaTag, isSameOllamaTag } from "@/shared/lib/ollama-tag";

/** Determine whether the submit button in the API-key dialog should be enabled. */
export function isApiKeyValid(key: string): boolean {
	return key.trim().length > 0;
}

/**
 * Determine the text for the primary Ollama dialog button.
 * When Ollama is installed (showRun=true), returns "run" semantics;
 * otherwise returns "download" semantics.
 */
export type OllamaPrimaryAction = "run" | "download";

export function getOllamaPrimaryAction(showRun: boolean): OllamaPrimaryAction {
	return showRun ? "run" : "download";
}

/**
 * Determine the label key for OllamaPrimaryButton based on the current
 * starting state and whether the run vs. download path is shown.
 */
export function getOllamaPrimaryLabelKey(
	showRun: boolean,
	starting: boolean,
): string {
	if (showRun) {
		return starting ? "starting" : "runOllama";
	}
	return "downloadOllama";
}

/**
 * Build the result object returned by OllamaDialog>handleStart when the
 * Ollama startup attempt fails.
 */
export function buildOllamaStartError(
	error: string | undefined,
	fallbackKey: string,
): { errorMessage: string; started: false } {
	return { started: false, errorMessage: error ?? fallbackKey };
}

export function readInputValue(
	element: HTMLInputElement | null | undefined,
): string {
	return element?.value ?? "";
}

/**
 * Whether the Ollama model selection needs to be synced because the provider
 * or the model list changed since the last render.
 */
export function ollamaModelSyncNeeded(
	prev: { provider: string; models: readonly { name: string }[] },
	provider: string,
	models: readonly { name: string }[],
): boolean {
	return prev.provider !== provider || prev.models !== models;
}

/**
 * If the current Ollama model is no longer installed after a scan, call
 * `update` with the first available replacement.  No-op when the current
 * model is still present or no replacement exists.
 *
 * @param shouldSync - injected predicate (e.g. shouldSyncOllamaModel) that
 *   returns the replacement model name or null.
 */
export function applyOllamaModelReplacementIfNeeded(
	provider: string,
	models: readonly { name: string }[],
	current: string,
	shouldSync: (
		provider: string,
		models: readonly { name: string }[],
		current: string,
	) => string | null,
	update: (patch: { model: string }) => void,
): void {
	const replacement = shouldSync(provider, models, current);
	if (replacement) {
		update({ model: replacement });
	}
}

/** The base (family) portion of an Ollama tag — everything before the first
 *  `:` of the canonical `name:tag` form, lowercased. `llama3.2:3b` → `llama3.2`. */
function ollamaTagBase(name: string): string {
	return canonicalOllamaTag(name).toLowerCase().split(":")[0] ?? "";
}

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) {
		i++;
	}
	return i;
}

/**
 * The installed model "nearest" to a target name — used when the model the user
 * last had selected was since deleted, so we swap to the closest survivor rather
 * than an arbitrary one. Ranking: same family/base wins outright (a deleted
 * `llama3.2:3b` prefers the installed `llama3.2:1b` over an unrelated `phi`),
 * then the longest shared name prefix, ties broken by list order (so `models[0]`
 * is the stable fallback). Returns `null` only when nothing is installed.
 */
export function pickNearestOllamaModel(
	models: readonly { name: string }[],
	target: string,
): string | null {
	const first = models[0];
	if (!first) {
		return null;
	}
	const targetCanon = canonicalOllamaTag(target).toLowerCase();
	const targetBase = ollamaTagBase(target);
	let best = first.name;
	let bestScore = -1;
	for (const m of models) {
		const sameBase = ollamaTagBase(m.name) === targetBase ? 1 : 0;
		const prefix = commonPrefixLength(
			canonicalOllamaTag(m.name).toLowerCase(),
			targetCanon,
		);
		// Same-base dominates any prefix overlap between different families.
		const score = sameBase * 100_000 + prefix;
		if (score > bestScore) {
			bestScore = score;
			best = m.name;
		}
	}
	return best;
}

/**
 * Which installed Ollama model the "Local" playground should select, or `null`
 * to leave the current selection alone. Encodes the playground's auto-select
 * policy:
 *   1. A remembered selection that's still installed wins (previously chosen).
 *   2. A remembered selection that was since deleted → the nearest install.
 *   3. No selection yet → default to the first install so the picker is never
 *      empty when at least one model exists.
 * Returns `null` when nothing is installed (nothing to pick) or the current
 * selection is already a valid install (no change needed).
 */
export function resolvePlaygroundLocalModel(
	models: readonly { name: string }[],
	current: string,
): string | null {
	const first = models[0];
	if (!first) {
		return null;
	}
	const trimmed = current.trim();
	if (!trimmed) {
		return first.name;
	}
	if (models.some((m) => isSameOllamaTag(m.name, trimmed))) {
		return null;
	}
	return pickNearestOllamaModel(models, trimmed);
}
