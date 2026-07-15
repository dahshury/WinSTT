import type { ModelInfo } from "@/entities/model-catalog";
import { isRealtimeViable, parseSizeLabel } from "./realtime-viability";

/** English-only variants (`*.en` or a sole `en` language) can't do multilingual. */
export function isEnglishOnly(model: ModelInfo): boolean {
	if (model.id.endsWith(".en")) {
		return true;
	}
	return model.languages.length === 1 && model.languages[0] === "en";
}

/**
 * Whether to surface the compact "Multilingual" badge instead of listing
 * the language codes on the model card. A single-language model keeps the
 * language visible; every other STT coverage shape is shown as Multilingual.
 * Empty lists are the legacy "broad/unknown whitelist" bucket, while populated
 * multi-language lists keep their full roster in the card tooltip.
 */
export function isMultilingual(model: ModelInfo): boolean {
	return !isEnglishOnly(model) && model.languages.length !== 1;
}

/** Per-variant flags consumed by the variant row + summary. */
export interface VariantMeta {
	englishOnly: boolean;
	multilingual: boolean;
	realtime: boolean;
}

export function variantMeta(model: ModelInfo): VariantMeta {
	return {
		englishOnly: isEnglishOnly(model),
		multilingual: isMultilingual(model),
		realtime: isRealtimeViable(model),
	};
}

export interface FamilySummary {
	hasEnglishOnly: boolean;
	hasMultilingual: boolean;
	languageNote: string;
	realtimeCount: number;
	sizeRange: string;
	variantCount: number;
}

interface Sized {
	label: string;
	params: number;
}

function parseSizes(models: readonly ModelInfo[]): Sized[] {
	return models
		.map((m) => ({ label: m.sizeLabel, params: parseSizeLabel(m.sizeLabel) }))
		.filter((s): s is Sized => s.params !== null);
}

/** Smallest by param count; ties keep the first (matches the prior loop). */
function minBy(sizes: readonly Sized[]): Sized {
	return sizes.reduce((a, b) => (b.params < a.params ? b : a));
}

/** Largest by param count; ties keep the first (matches the prior loop). */
function maxBy(sizes: readonly Sized[]): Sized {
	return sizes.reduce((a, b) => (b.params > a.params ? b : a));
}

function sizeRange(models: readonly ModelInfo[]): string {
	const sizes = parseSizes(models);
	if (sizes.length === 0) {
		return "";
	}
	const minLabel = minBy(sizes).label;
	const maxLabel = maxBy(sizes).label;
	if (minLabel === maxLabel) {
		return minLabel;
	}
	return `${minLabel} – ${maxLabel}`;
}

/** A variant contributes explicit language tags only when it is neither multilingual nor English-only. */
function hasExplicitLanguages(model: ModelInfo): boolean {
	return !(isMultilingual(model) || isEnglishOnly(model));
}

function explicitLanguages(models: readonly ModelInfo[]): string[] {
	const codes = new Set<string>();
	for (const m of models) {
		if (!hasExplicitLanguages(m)) {
			continue;
		}
		for (const code of m.languages) {
			codes.add(code.toUpperCase());
		}
	}
	return Array.from(codes).sort();
}

function buildLanguageNote(
	hasMultilingual: boolean,
	hasEnglishOnly: boolean,
	otherLangs: string[],
): string {
	const parts: string[] = [];
	if (hasMultilingual) {
		parts.push("Multilingual");
	}
	if (hasEnglishOnly) {
		parts.push("English-only");
	}
	parts.push(...otherLangs);
	return parts.join(" · ");
}

/** Roll a family's variants up into the collapsed-card header summary. */
export function summarizeFamily(models: readonly ModelInfo[]): FamilySummary {
	const hasMultilingual = models.some(isMultilingual);
	const hasEnglishOnly = models.some(isEnglishOnly);
	return {
		variantCount: models.length,
		sizeRange: sizeRange(models),
		hasMultilingual,
		hasEnglishOnly,
		realtimeCount: models.filter(isRealtimeViable).length,
		languageNote: buildLanguageNote(
			hasMultilingual,
			hasEnglishOnly,
			explicitLanguages(models),
		),
	};
}
