import type { ModelInfo } from "@/entities/model-catalog";
import { GPU_COMPATIBLE_QUANTIZATIONS } from "@/entities/system-resources";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { countActiveFlags } from "@/shared/ui/model-picker/core/lib/filter-state";
import { buildModelSearchCorpus } from "@/entities/model-catalog";

export interface SttFilterState {
	cachedOnly: boolean;
	fitsHardwareOnly: boolean;
	/** Language codes the model must support (empty = no language filter). */
	languages: string[];
	realtimeOnly: boolean;
	/** Spec-based "Suggested" filter (default ON): hide models with NO quant
	 *  that fits this machine's memory budgets. The predicate itself is
	 *  injected by the host via {@link FilterModelsContext.suggested} — when
	 *  the host hasn't wired one (onboarding, budgets not loaded yet) the flag
	 *  is inert. */
	suggestedOnly: boolean;
}

export const EMPTY_FILTER_STATE: SttFilterState = {
	cachedOnly: false,
	realtimeOnly: false,
	fitsHardwareOnly: false,
	languages: [],
	suggestedOnly: true,
};

/** A persisted filter blob may predate the `suggestedOnly` flag. */
export type PersistedSttFilterState = Omit<SttFilterState, "suggestedOnly"> &
	Partial<Pick<SttFilterState, "suggestedOnly">>;

/** Migration rule: persisted blobs written before the Suggested filter lack
 *  the key — a MISSING `suggestedOnly` defaults to `true` (ON for existing
 *  users), it is never treated as invalid state. */
export function normalizeSttFilterState(
	filters: PersistedSttFilterState,
): SttFilterState {
	return {
		suggestedOnly: true,
		...filters,
		languages: [...filters.languages],
	};
}

/**
 * Boolean toggles in display order — keeps count/active logic table-driven.
 * `suggestedOnly` is deliberately EXCLUDED: it is ON by default and surfaced
 * by its own always-visible chip, so counting it would permanently badge the
 * filter trigger with "1 active" and keep "Clear all" lit in the default state.
 */
const TOGGLE_KEYS = ["cachedOnly", "realtimeOnly", "fitsHardwareOnly"] as const;

export function activeFilterCount(filters: SttFilterState): number {
	return countActiveFlags(filters, TOGGLE_KEYS) + filters.languages.length;
}

export function hasActiveFilters(filters: SttFilterState): boolean {
	return activeFilterCount(filters) > 0;
}

/**
 * A model can transcribe a language when it's multilingual (no explicit
 * language list) or its language list includes the requested code.
 */
export function modelSupportsLanguage(m: ModelInfo, language: string): boolean {
	return m.languages.length === 0 || m.languages.includes(language);
}

/**
 * Distinct explicit language codes across the catalog, sorted. Skips
 * multilingual models (``supportsLanguageDetection``) because they cover
 * ~25-99 codes each — folding those into the chip set would blow the
 * filter menu up to ~100 chips, almost all from Whisper. The filter rule
 * (:func:`modelSupportsLanguage`) still matches multilingual models when
 * the user picks any chip the chip can name — a Russian filter still
 * surfaces Whisper alongside the explicit Russian specialists.
 */
export function collectFilterableLanguages(
	models: readonly ModelInfo[],
): string[] {
	const set = new Set<string>();
	for (const m of models) {
		if (m.supportsLanguageDetection) {
			continue;
		}
		for (const code of m.languages) {
			set.add(code);
		}
	}
	return [...set].toSorted();
}

function modelMatchesSearch(m: ModelInfo, query: string): boolean {
	return matchesFuzzySearch(buildModelSearchCorpus(m), query);
}

function hasGpu(sys: SystemInfoEntry | null): boolean {
	return sys !== null && sys.gpus.length > 0;
}

function hasUnknownFootprint(entry: ModelStateEntry | undefined): boolean {
	return !entry || entry.estimated_bytes <= 0;
}

/**
 * The device the model's EFFECTIVE quant actually runs on. Prefer the
 * server's per-quant routing verdict (`device_by_quantization`, from the
 * per-engine device pin matrix — CPU-pinned engines like Cohere report
 * "cpu" even on GPU hosts). Older servers omit it; fall back to the
 * heuristic: GPU only when the quant is GPU-EP-compatible AND a GPU exists.
 */
function routedDevice(
	entry: ModelStateEntry,
	sys: SystemInfoEntry | null,
): "gpu" | "cpu" {
	const quant = entry.effective_quantization ?? "";
	const routed = entry.device_by_quantization?.[quant];
	if (routed === "gpu" || routed === "cpu") {
		return routed;
	}
	return GPU_COMPATIBLE_QUANTIZATIONS.has(quant) && hasGpu(sys) ? "gpu" : "cpu";
}

function comfortableOnAvailableHardware(
	entry: ModelStateEntry,
	sys: SystemInfoEntry | null,
): boolean {
	// Judge fit against the pool the model actually consumes: a CPU-routed
	// model (CPU-pinned engine or a non-fp quant) uses RAM, never VRAM — so
	// mere GPU presence must not switch it to the VRAM verdict.
	return routedDevice(entry, sys) === "gpu"
		? entry.comfortable_on_gpu
		: entry.comfortable_on_cpu;
}

function modelFitsHardware(
	entry: ModelStateEntry | undefined,
	sys: SystemInfoEntry | null,
): boolean {
	if (!entry || hasUnknownFootprint(entry)) {
		return true;
	}
	return comfortableOnAvailableHardware(entry, sys);
}

export interface FilterModelsContext {
	filters: SttFilterState;
	searchQuery: string;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
	/** Host-injected Suggested predicate ("does any quant of this model fit
	 *  the memory budgets, and can it transcribe the selected source
	 *  language"). `null`/absent = the host has no verdict (system info not
	 *  loaded, host not wired) — the `suggestedOnly` flag is then inert and
	 *  hides nothing. */
	suggested?: ((model: ModelInfo) => boolean) | null | undefined;
}

function passesCachedFilter(
	filters: SttFilterState,
	entry: ModelStateEntry | undefined,
): boolean {
	return !filters.cachedOnly || entry?.cache.state === "cached";
}

function passesRealtimeFilter(ctx: FilterModelsContext, m: ModelInfo): boolean {
	if (!ctx.filters.realtimeOnly) {
		return true;
	}
	return m.nativeStreaming;
}

function passesHardwareFilter(
	filters: SttFilterState,
	entry: ModelStateEntry | undefined,
	sys: SystemInfoEntry | null,
): boolean {
	return !filters.fitsHardwareOnly || modelFitsHardware(entry, sys);
}

function passesSuggestedFilter(
	ctx: FilterModelsContext,
	m: ModelInfo,
): boolean {
	if (!(ctx.filters.suggestedOnly && ctx.suggested)) {
		return true;
	}
	return ctx.suggested(m);
}

function passesLanguageFilter(filters: SttFilterState, m: ModelInfo): boolean {
	return (
		filters.languages.length === 0 ||
		filters.languages.some((lang) => modelSupportsLanguage(m, lang))
	);
}

function matchesAllFilters(
	m: ModelInfo,
	query: string,
	ctx: FilterModelsContext,
): boolean {
	const entry = ctx.statesById[m.id];
	const checks = [
		modelMatchesSearch(m, query),
		passesCachedFilter(ctx.filters, entry),
		passesRealtimeFilter(ctx, m),
		passesHardwareFilter(ctx.filters, entry, ctx.systemInfo),
		passesSuggestedFilter(ctx, m),
		passesLanguageFilter(ctx.filters, m),
	];
	return checks.every(Boolean);
}

export function filterSttModels(
	models: readonly ModelInfo[],
	ctx: FilterModelsContext,
): ModelInfo[] {
	const query = ctx.searchQuery.trim().toLowerCase();
	return models.filter((m) => matchesAllFilters(m, query, ctx));
}

/** Format a model's language coverage for compact selector pills. */
export function formatLanguageCoverage(m: ModelInfo): string {
	if (m.languages.length !== 1) {
		return "Multilingual";
	}
	return m.languages.at(0)?.toUpperCase() ?? "Multilingual";
}
