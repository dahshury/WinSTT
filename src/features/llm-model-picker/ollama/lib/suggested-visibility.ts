/**
 * Suggested-filter visibility + ranking helpers for the Ollama picker.
 *
 * A model card is *suggestible* iff ANY quant of its canonical shelf ladder
 * fits the memory budgets (plan Part 3.3): a 27B card whose fp16 tag is way
 * over budget must stay visible when its q4_K_M tag fits. The candidate quants
 * are exactly what the quant shelf would show — `tagsForParamSize` +
 * `pruneToShownQuants` — so visibility and badge-gating always agree. When the
 * scraped tag list hasn't been fetched yet, the card's single known size
 * (installed `OllamaModel.size` / recommended `sizeBytes`) stands in; unknown
 * sizes stay lenient (fits), the rule already established in `filter-state.ts`.
 *
 * `fits` is the host-injected budget-aware per-tag test (either-pool: VRAM
 * budget OR RAM budget — see `buildOllamaSuggestions` in
 * `features/suggested-models`); the legacy VRAM-first rule stays with the
 * warning chip's `getFit`.
 */

import type {
	OllamaLibraryTag,
	OllamaModel,
	RecommendedOllamaModel,
} from "@/shared/api/models";
import { makeNameComparator } from "@/shared/ui/model-picker/core/lib/sort-state";
import {
	paramSizeFromName,
	pruneToShownQuants,
	tagsForParamSize,
} from "./quant-shelf-helpers";

export type OllamaSuggestedFits = (sizeBytes: number) => boolean;

export type OllamaTagLookup = (baseSlug: string) => readonly OllamaLibraryTag[];

/** True when any canonical-ladder quant for `paramSize` fits — falling back to
 *  the card's single known size while the tag list hasn't been fetched. */
export function anyShownQuantFits(opts: {
	fallbackSizeBytes: number;
	fits: OllamaSuggestedFits;
	paramSize: string | null | undefined;
	tags: readonly OllamaLibraryTag[];
}): boolean {
	const shown = pruneToShownQuants(
		tagsForParamSize(opts.tags, opts.paramSize),
		() => false,
	);
	if (shown.length === 0) {
		return opts.fits(opts.fallbackSizeBytes);
	}
	return shown.some((tag) => opts.fits(tag.sizeBytes ?? 0));
}

function baseSlugOf(name: string): string {
	const colonIdx = name.indexOf(":");
	return (colonIdx >= 0 ? name.slice(0, colonIdx) : name).toLowerCase();
}

/** Suggested visibility for an installed card. */
export function installedModelSuggested(
	m: OllamaModel,
	getTags: OllamaTagLookup | undefined,
	fits: OllamaSuggestedFits,
): boolean {
	return anyShownQuantFits({
		fallbackSizeBytes: m.size ?? 0,
		fits,
		paramSize: paramSizeFromName(m.name) || m.details?.parameterSize || null,
		tags: getTags?.(baseSlugOf(m.name)) ?? [],
	});
}

/** Suggested visibility for a recommended (curated, not-installed) card. */
export function recommendedModelSuggested(
	m: RecommendedOllamaModel,
	getTags: OllamaTagLookup | undefined,
	fits: OllamaSuggestedFits,
): boolean {
	// GPT-OSS 20B is the curated catalog's deliberate GPU-class exception. Keep
	// the card visible even when no local memory pool can fit it: its native MXFP4
	// badge remains visible but disabled, and the card's warning explains why.
	// This preserves discoverability without turning the badge into a download
	// affordance on undersized hardware.
	if (baseSlugOf(m.name) === "gpt-oss") {
		return true;
	}
	return anyShownQuantFits({
		fallbackSizeBytes: m.sizeBytes,
		fits,
		paramSize: paramSizeFromName(m.name) || m.paramSize,
		tags: getTags?.(baseSlugOf(m.name)) ?? [],
	});
}

/** Stable A→Z tie-break for equal proxy scores — mirrors the sort keys'
 *  universal name tie-breaker. */
const byRecommendedName = makeNameComparator(
	(m: RecommendedOllamaModel) => m.displayName,
);

/**
 * Order recommended cards best bang-for-buck first (the engine's proxy score:
 * log-param accuracy × pool-occupancy speed at the card's tag), name A→Z on
 * ties. Applied while Suggested is ON with no explicit sort (plan Part 4c).
 */
export function sortRecommendedBySuggestedScore(
	models: readonly RecommendedOllamaModel[],
	score: (m: RecommendedOllamaModel) => number,
): RecommendedOllamaModel[] {
	const scores = new Map(models.map((m) => [m.name, score(m)]));
	return models.toSorted(
		(a, b) =>
			(scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0) ||
			byRecommendedName(a, b),
	);
}
