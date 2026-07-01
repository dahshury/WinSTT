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
