import type { ModelInfo } from "../model/catalog-store";

export interface SourceLanguageSelection {
	autoDetectLanguage?: boolean | null;
	language?: string | null;
	languageCandidates?: readonly string[] | null;
}

export function normalizeSttLanguageCode(language: string): string {
	const trimmed = language.trim().toLowerCase().replaceAll("_", "-");
	if (trimmed.length === 0 || trimmed === "auto") {
		return "";
	}
	return trimmed.split("-")[0] ?? "";
}

function uniqueNormalizedLanguages(languages: readonly string[]): string[] {
	const normalized: string[] = [];
	for (const raw of languages) {
		const language = normalizeSttLanguageCode(raw);
		if (language.length === 0 || normalized.includes(language)) {
			continue;
		}
		normalized.push(language);
	}
	return normalized;
}

export function resolveSelectedSourceLanguages(
	selection: SourceLanguageSelection | undefined,
	mainModel: ModelInfo | null | undefined,
): string[] {
	const candidateLanguages = uniqueNormalizedLanguages(
		selection?.languageCandidates ?? [],
	);
	if (candidateLanguages.length > 0) {
		return candidateLanguages;
	}

	const pinnedLanguage = normalizeSttLanguageCode(selection?.language ?? "");
	if (selection?.autoDetectLanguage !== true && pinnedLanguage.length > 0) {
		return [pinnedLanguage];
	}

	return uniqueNormalizedLanguages(mainModel?.languages ?? []);
}

export function modelSupportsAnySourceLanguage(
	model: ModelInfo,
	sourceLanguages: readonly string[],
): boolean {
	const normalizedSources = uniqueNormalizedLanguages(sourceLanguages);
	if (normalizedSources.length === 0 || model.languages.length === 0) {
		return true;
	}
	const supported = new Set(uniqueNormalizedLanguages(model.languages));
	return normalizedSources.some((language) => supported.has(language));
}

export function modelSupportsSelectedSourceLanguages(
	model: ModelInfo,
	selection: SourceLanguageSelection | undefined,
	mainModel: ModelInfo | null | undefined,
): boolean {
	return modelSupportsAnySourceLanguage(
		model,
		resolveSelectedSourceLanguages(selection, mainModel),
	);
}
