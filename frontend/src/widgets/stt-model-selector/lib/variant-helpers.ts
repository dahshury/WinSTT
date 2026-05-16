import type { ModelInfo } from "@/entities/model-catalog";
import { isRealtimeViable, parseSizeLabel } from "./realtime-viability";

/** English-only variants (`*.en` or a sole `en` language) can't do multilingual. */
export function isEnglishOnly(model: ModelInfo): boolean {
	if (model.id.endsWith(".en")) {
		return true;
	}
	return model.languages.length === 1 && model.languages[0] === "en";
}

export function isMultilingual(model: ModelInfo): boolean {
	return model.languages.length === 0;
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

function sizeRange(models: readonly ModelInfo[]): string {
	const sizes = models
		.map((m) => ({ label: m.sizeLabel, params: parseSizeLabel(m.sizeLabel) }))
		.filter((s): s is { label: string; params: number } => s.params !== null);
	if (sizes.length === 0) {
		return "";
	}
	let min = sizes[0];
	let max = sizes[0];
	for (const s of sizes) {
		if (min && s.params < min.params) {
			min = s;
		}
		if (max && s.params > max.params) {
			max = s;
		}
	}
	if (!(min && max) || min.label === max.label) {
		return min?.label ?? "";
	}
	return `${min.label} – ${max.label}`;
}

function explicitLanguages(models: readonly ModelInfo[]): string[] {
	const set = new Set<string>();
	for (const m of models) {
		if (!(isMultilingual(m) || isEnglishOnly(m))) {
			for (const code of m.languages) {
				set.add(code.toUpperCase());
			}
		}
	}
	return [...set].sort();
}

function buildLanguageNote(
	hasMultilingual: boolean,
	hasEnglishOnly: boolean,
	otherLangs: string[]
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
		languageNote: buildLanguageNote(hasMultilingual, hasEnglishOnly, explicitLanguages(models)),
	};
}
