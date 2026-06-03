import type { OllamaModel } from "@/shared/api/models";

/**
 * Sort dimensions exposed in the Ollama picker's "Sort" section. ``null`` means
 * no sort is active — the selector keeps its default per-publisher grouping and
 * only flattens the installed models into a single globally-sorted column once a
 * key is picked.
 *
 * Each key sorts in its single most-useful direction (no asc/desc toggle):
 * name → A–Z, size → smallest on-disk first, params → fewest parameters first.
 * That "fixed best order" keeps the control to one tap per dimension.
 */
export type OllamaSortKey = "name" | "size" | "params";

/** ``null`` = no sort active (the default grouped view). */
export type OllamaSortValue = OllamaSortKey | null;

/** Sort keys in display order — drives the menu chips + keeps logic table-driven. */
export const OLLAMA_SORT_KEYS = ["name", "size", "params"] as const;

/** Short chip label per key (the popover). */
export const OLLAMA_SORT_CHIP_LABEL: Record<OllamaSortKey, string> = {
	name: "Name",
	size: "Size",
	params: "Parameters",
};

/** Full label per key, including the implied direction (the flat-list header). */
export const OLLAMA_SORT_HEADER_LABEL: Record<OllamaSortKey, string> = {
	name: "Name · A–Z",
	size: "Size · smallest first",
	params: "Parameters · smallest first",
};

const PARAM_UNIT_MULTIPLIER: Record<string, number> = {
	"": 1,
	K: 1e3,
	M: 1e6,
	B: 1e9,
	T: 1e12,
};

const PARAM_LABEL_RE = /^([\d.]+)\s*([KMBT]?)/i;

/**
 * Parse a parameter-count label like ``"7B"`` / ``"1.2B"`` / ``"270m"`` into a
 * numeric param count used purely for ordering (B=1e9, M=1e6, K=1e3).
 * Unrecognised / missing labels return ``+Infinity`` so they sort to the END of
 * a smallest-first list. Local to this slice (the STT picker has its own
 * ``parseParameterSize`` but FSD slice isolation keeps them separate).
 */
function parseOllamaParamCount(label: string | null | undefined): number {
	const match = (label ?? "").trim().match(PARAM_LABEL_RE);
	if (!match || match[1] === undefined) {
		return Number.POSITIVE_INFINITY;
	}
	const value = Number.parseFloat(match[1]);
	if (Number.isNaN(value)) {
		return Number.POSITIVE_INFINITY;
	}
	const unit = (match[2] ?? "").toUpperCase();
	return value * (PARAM_UNIT_MULTIPLIER[unit] ?? 1);
}

/**
 * On-disk size in bytes, normalised so unknown / zero sizes sort LAST. Installed
 * Ollama models carry the size on ``size`` (not ``sizeBytes``); a missing or
 * non-positive value becomes ``+Infinity``.
 */
function onDiskBytes(m: OllamaModel): number {
	const bytes = m.size ?? 0;
	return bytes > 0 ? bytes : Number.POSITIVE_INFINITY;
}

/** Stable A→Z name compare — also the universal tie-breaker for every key. */
function byName(a: OllamaModel, b: OllamaModel): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Ascending compare on two metrics where ``+Infinity`` means "unknown". Guards
 * the ``Infinity - Infinity = NaN`` trap (two unknowns) by treating equal values
 * — including two unknowns — as a name tie-break rather than subtracting.
 */
function ascendingOrName(av: number, bv: number, a: OllamaModel, b: OllamaModel): number {
	if (av === bv) {
		return byName(a, b);
	}
	return av - bv;
}

const COMPARATORS: Record<OllamaSortKey, (a: OllamaModel, b: OllamaModel) => number> = {
	name: byName,
	size: (a, b) => ascendingOrName(onDiskBytes(a), onDiskBytes(b), a, b),
	params: (a, b) =>
		ascendingOrName(
			parseOllamaParamCount(a.details?.parameterSize),
			parseOllamaParamCount(b.details?.parameterSize),
			a,
			b
		),
};

/**
 * Return a NEW array of ``models`` ordered by ``key`` in its fixed best
 * direction. Pure — never mutates the input. The selector uses this to flatten
 * the publisher groups into a single globally-sorted column while a sort is
 * active.
 */
export function sortOllamaModels(
	models: readonly OllamaModel[],
	key: OllamaSortKey
): OllamaModel[] {
	return [...models].sort(COMPARATORS[key]);
}
