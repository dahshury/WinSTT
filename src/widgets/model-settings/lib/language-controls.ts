import type { ModelInfo } from "@/entities/model-catalog";
import { DEFAULT_SETTINGS } from "@/entities/setting";
import { LANGUAGES } from "@/shared/config/defaults";
import type { SelectOption } from "@/shared/ui/select";
import type { LanguageControlMode, ModelSettings } from "./types";

export type { LanguageControlMode };

// Auto-detect is a separate toggle; the combobox only lists concrete languages.
// uppercased as a short visual badge (e.g. "en" → "EN", "yue" → "YUE").
function languageBadge(code: string): string {
	return code.toUpperCase();
}
const ALL_LANG_OPTS: SelectOption[] = LANGUAGES.flatMap((l) =>
	l.code === ""
		? []
		: [
				{
					id: l.code,
					label: l.name,
					badge: languageBadge(l.code),
				},
			],
);

export function buildLanguageOptions(
	supportedLanguages: readonly string[] | undefined,
): SelectOption[] {
	if (!supportedLanguages || supportedLanguages.length === 0) {
		return ALL_LANG_OPTS;
	}
	const supported = new Set(supportedLanguages);
	return ALL_LANG_OPTS.filter((option) => supported.has(option.id));
}

export function normalizeLanguageCandidates(
	rawCandidates: readonly string[] | undefined,
	options: readonly SelectOption[],
	fallback: string,
): string[] {
	const normalized = normalizeLanguageCandidatesCore(rawCandidates, options);
	if (normalized.length > 0) {
		return normalized;
	}
	const available = new Set(options.map((option) => option.id));
	if (available.has(fallback)) {
		return [fallback];
	}
	return options[0]?.id ? [options[0].id] : [];
}

function normalizeLanguageCandidatesCore(
	rawCandidates: readonly string[] | undefined,
	options: readonly SelectOption[],
): string[] {
	const available = new Set(options.map((option) => option.id));
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const raw of rawCandidates ?? []) {
		const candidate = raw.trim();
		if (
			candidate.length === 0 ||
			candidate === "auto" ||
			!available.has(candidate)
		) {
			continue;
		}
		if (!seen.has(candidate)) {
			seen.add(candidate);
			normalized.push(candidate);
		}
	}
	return normalized;
}

export function normalizeLanguageCandidatesAllowEmpty(
	rawCandidates: readonly string[] | undefined,
	options: readonly SelectOption[],
): string[] {
	return normalizeLanguageCandidatesCore(rawCandidates, options);
}

export function deriveLanguageCandidates(
	settings: ModelSettings | undefined,
	options: readonly SelectOption[],
): string[] {
	const configured = settings?.languageCandidates ?? [];
	if (configured.length > 0) {
		return normalizeLanguageCandidates(
			configured,
			options,
			DEFAULT_SETTINGS.model.language,
		);
	}
	return normalizeLanguageCandidates(
		settings?.language ? [settings.language] : [],
		options,
		DEFAULT_SETTINGS.model.language,
	);
}

function firstConcreteLanguage(
	rawCandidates: readonly string[] | undefined,
	options: readonly SelectOption[],
): string {
	return (
		normalizeLanguageCandidates(
			rawCandidates,
			options,
			DEFAULT_SETTINGS.model.language,
		)[0] ??
		options[0]?.id ??
		DEFAULT_SETTINGS.model.language
	);
}

export function fixedLanguageValue(
	settings: ModelSettings | undefined,
	candidates: readonly string[],
	options: readonly SelectOption[],
): string {
	return firstConcreteLanguage(
		[settings?.language ?? "", ...candidates],
		options,
	);
}

export function languageAutoDetectEnabled(
	settings: ModelSettings | undefined,
): boolean {
	const language = (
		settings?.language ?? DEFAULT_SETTINGS.model.language
	).trim();
	return (
		settings?.autoDetectLanguage === true ||
		language.length === 0 ||
		language === "auto"
	);
}

/**
 * The set of output languages the model can natively translate INTO. Native
 * decoder translation differs sharply by family:
 *   - Multilingual Whisper: the `<|translate|>` task is English-only, so the
 *     only valid target is `"en"`.
 *   - NeMo Canary: translates any→any among its catalog languages, so every
 *     one of `model.languages` is a valid target.
 * `supportsTranslateToEnglish` gates callers to those two families; this helper
 * assumes the model already passed that check.
 */
function translateTargetCodes(model: ModelInfo): string[] {
	if (model.id.startsWith("nemo-canary-")) {
		return [...model.languages];
	}
	return ["en"];
}

/**
 * Build the target-language options for the Transcriptions-tab translate picker.
 * A source language is excluded from the targets ONLY when it is definitively
 * known — exactly one selected spoken language — because translating a language
 * into itself is a no-op. With several possible spoken languages (or full
 * auto-detect, where `sourceLanguages` is empty) the engine's own constrained
 * detection resolves the source per utterance (backend `model_language_options`
 * leaves the language unpinned; Whisper runs its 3-token lang-id), so every
 * target stays valid: e.g. spoken = English+German with target English still
 * makes sense — German gets translated, English passes through unchanged.
 */
export function translateTargetOptions(
	model: ModelInfo | undefined,
	sourceLanguages: readonly string[],
): SelectOption[] {
	if (!model) {
		return [];
	}
	const targets = new Set(translateTargetCodes(model));
	const excluded = new Set<string>();
	if (sourceLanguages.length === 1) {
		const normalized = sourceLanguages[0]?.trim().toLowerCase() ?? "";
		if (normalized.length > 0) {
			excluded.add(normalized);
		}
	}
	return ALL_LANG_OPTS.filter(
		(option) => targets.has(option.id) && !excluded.has(option.id),
	);
}

function canConstrainAutoDetection(model: ModelInfo): boolean {
	return model.family === "whisper" && model.supportsLanguageDetection;
}

function canAutoDetectWithoutCandidateConstraints(model: ModelInfo): boolean {
	return (
		(model.family === "sense_voice" || model.family === "cohere") &&
		model.supportsLanguageDetection
	);
}

function canUseSingleSourceLanguage(model: ModelInfo): boolean {
	return model.id.startsWith("nemo-canary-");
}

export function resolveLanguageControlMode(
	model: ModelInfo | undefined,
	selectedIsCloud: boolean,
): LanguageControlMode {
	if (selectedIsCloud || model === undefined || model.languages.length <= 1) {
		return "hidden";
	}
	if (canConstrainAutoDetection(model)) {
		return "candidate-auto";
	}
	if (canAutoDetectWithoutCandidateConstraints(model)) {
		return "auto";
	}
	if (canUseSingleSourceLanguage(model)) {
		return "single";
	}
	return "hidden";
}
