import type { ModelCacheInfo, ModelStateEntry } from "@/shared/api/ipc-client";

/**
 * Resolve the cache info for a specific quantization. Falls back to the flat
 * overall `cache` for legacy aliases that report no per-quant breakdown.
 */
export function resolveQuantCache(
	entry: ModelStateEntry | undefined,
	quantization: string,
): ModelCacheInfo | undefined {
	if (!entry) {
		return;
	}
	return entry.cache_by_quantization?.[quantization] ?? entry.cache;
}

/**
 * The precision the server will *actually* load for a given selection.
 *
 * The auto sentinel (`"auto"`) is re-resolved by the server per model — its
 * RAM/VRAM-aware `fit_aware_auto_quant` picks the best-fitting precision for
 * the user's hardware (e.g. fp16 on a DirectML GPU, int8 on CPU). The server
 * surfaces that decision as `entry.effective_quantization`. NOTE: `""` is NO
 * LONGER auto — it now means EXPLICIT fp32 (the full base export), so it passes
 * through unchanged like any other concrete pick.
 * So when the user is on auto (selection is `"auto"`), honor the server's
 * effective precision; concrete picks (incl `""` = fp32, plus int8 / fp16 / …)
 * and entries without the field pass through unchanged.
 *
 * Without this, the download gate checks the default-export's cache state
 * (often on disk) for a model the server will load as `int8` (often NOT on
 * disk) — so clicking it silently kicks off a background download instead of
 * prompting. See the canary-1b-flash repro.
 */
export function resolveEffectiveQuant(
	entry: ModelStateEntry | undefined,
	selectedQuant: string,
): string {
	// Check PRESENCE, not truthiness: `effective_quantization` can legitimately be
	// "" (the recommended pick IS fp32), which must still override the "auto"
	// sentinel. Only an older server that omits the field (undefined) falls through.
	const effective = entry?.effective_quantization;
	if (selectedQuant === "auto" && effective !== undefined) {
		return effective;
	}
	return selectedQuant;
}

/**
 * Is a model downloaded at the precision THIS SELECTION will actually load at?
 *
 * `entry.cache` is not that answer: the backend sets the overall state from the
 * model's `effective_quantization` — the RAM/VRAM-aware AUTO recommendation —
 * which is computed independently of the user's explicit `onnxQuantization`.
 * When the two disagree, the flat `cache` describes a precision the user isn't
 * using: `audio8-asr-0.1b` is recommended (and reported) at fp32 = `not_cached`
 * while the user runs it at `int8`, fully on disk and loaded. Reading the flat
 * state there declares a working selection "not downloaded", which is what let
 * the stale-model fallback silently rewrite it to the factory default.
 *
 * So resolve the selection's precision first (`"auto"` → the server's
 * recommendation, concrete picks pass through) and read THAT precision's state.
 */
export function isSelectionCached(
	entry: ModelStateEntry | undefined,
	selectedQuant: string,
): boolean {
	return (
		resolveQuantCache(entry, resolveEffectiveQuant(entry, selectedQuant))
			?.state === "cached"
	);
}

/**
 * The `onnxQuantization` override to fold into a patch that switches
 * `model.model`, or ``null`` when the carried precision is already valid for
 * the incoming model.
 *
 * `{ model, onnxQuantization }` is a COUPLE the backend validates together
 * (`validate_quantization`, keyed on `model.model`). A patch that moves the
 * model without reconciling the precision can post one the new model doesn't
 * publish — `int8` carried onto `tiny` (`["", "fp16", "q4", "bnb4"]`) — and the
 * backend rejects the WHOLE model section, so the switch never reaches disk and
 * every later save of that section fails the same way. Renderer-origin patches
 * are rejected outright rather than healed (deliberate: the ack must not claim
 * values applied that didn't), so every writer of `{ model }` owns this.
 *
 * Returns `""` (the universal default — every catalog entry ships it and the
 * server re-resolves it per model) to reset an unavailable precision, `null` to
 * leave the carried value alone. The `""`/`"auto"` sentinels are always valid,
 * and an unknown/cloud id (no catalog entry, hence no precision list) can't be
 * proven invalid, so both keep the carried value.
 */
export function reconcileQuantForModel(
	modelId: string,
	currentQuant: string,
	catalogModels: readonly { id: string; availableQuantizations?: string[] }[],
): "" | null {
	if (currentQuant === "" || currentQuant === "auto") {
		return null;
	}
	const entry = catalogModels.find((m) => m.id === modelId);
	if (!(entry && Array.isArray(entry.availableQuantizations))) {
		return null;
	}
	return entry.availableQuantizations.includes(currentQuant) ? null : "";
}
