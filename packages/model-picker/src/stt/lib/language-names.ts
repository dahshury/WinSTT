import { LANGUAGES } from "@/shared/config/defaults";

const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(
	LANGUAGES.map((l) => [l.code, l.name]),
);

/** Human-readable language name for a catalog code, falling back to the
 *  upper-cased code when we don't have a name on file (e.g. "yue" → "YUE"). */
export function languageLabel(code: string): string {
	return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

/** Alphabetically-sorted, comma-joined language names for a set of codes.
 *  Powers the model card's "Multilingual" tooltip so a many-language model
 *  spells out exactly which languages it supports instead of a vague blurb. */
export function formatLanguages(codes: readonly string[]): string {
	return codes
		.map(languageLabel)
		.sort((a, b) => a.localeCompare(b))
		.join(", ");
}
