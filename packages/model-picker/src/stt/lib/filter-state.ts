import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";

export interface SttFilterState {
	cachedOnly: boolean;
	fitsHardwareOnly: boolean;
	/** Language codes the model must support (empty = no language filter). */
	languages: string[];
	realtimeOnly: boolean;
}

export const EMPTY_FILTER_STATE: SttFilterState = {
	cachedOnly: false,
	realtimeOnly: false,
	fitsHardwareOnly: false,
	languages: [],
};

/** Boolean toggles in display order — keeps count/active logic table-driven. */
const TOGGLE_KEYS = ["cachedOnly", "realtimeOnly", "fitsHardwareOnly"] as const;

export function activeFilterCount(filters: SttFilterState): number {
	const toggles = TOGGLE_KEYS.filter((key) => filters[key]).length;
	return toggles + filters.languages.length;
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
	return [...set].sort();
}

function modelMatchesSearch(m: ModelInfo, query: string): boolean {
	if (!query) {
		return true;
	}
	const haystack =
		`${m.displayName} ${m.id} ${m.family} ${m.sizeLabel}`.toLowerCase();
	return haystack.includes(query);
}

function hasGpu(sys: SystemInfoEntry | null): boolean {
	return sys !== null && sys.gpus.length > 0;
}

function hasUnknownFootprint(entry: ModelStateEntry | undefined): boolean {
	return !entry || entry.estimated_bytes <= 0;
}

function comfortableOnAvailableHardware(
	entry: ModelStateEntry,
	sys: SystemInfoEntry | null,
): boolean {
	return hasGpu(sys) ? entry.comfortable_on_gpu : entry.comfortable_on_cpu;
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

function firstLangUpper(languages: readonly string[]): string {
	return languages[0]?.toUpperCase() ?? "";
}

/** Coverage rule keyed by language count; `null` value = "use the +N fallback". */
const COVERAGE_BY_COUNT: Record<number, (langs: readonly string[]) => string> =
	{
		0: () => "Multilingual",
		1: (langs) => firstLangUpper(langs),
		2: (langs) => langs.map((l) => l.toUpperCase()).join("/"),
		3: (langs) => langs.map((l) => l.toUpperCase()).join("/"),
	};

/** Format a model's language coverage for the pill: "Multilingual" / "EN" / "EN+99". */
export function formatLanguageCoverage(m: ModelInfo): string {
	const langs = m.languages;
	const rule = COVERAGE_BY_COUNT[langs.length];
	return rule?.(langs) ?? `${firstLangUpper(langs)} +${langs.length - 1}`;
}
