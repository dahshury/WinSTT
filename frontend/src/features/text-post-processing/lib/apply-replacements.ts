import type { components } from "@spec/schema";

type DictionaryEntry = components["schemas"]["DictionaryEntry"];
type SnippetEntry = components["schemas"]["SnippetEntry"];

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const regexCache = new Map<string, RegExp>();

function getEntryRegex(entry: DictionaryEntry): RegExp {
	const flags = entry.caseSensitive ? "g" : "gi";
	const escaped = entry.find.replace(REGEX_ESCAPE_RE, "\\$&");
	const pattern = entry.wholeWord ? `\\b${escaped}\\b` : escaped;
	const cacheKey = `${flags}:${pattern}`;
	const cached = regexCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	const compiled = new RegExp(pattern, flags);
	regexCache.set(cacheKey, compiled);
	return compiled;
}

export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
	let result = text;
	for (const entry of entries) {
		result = result.replace(getEntryRegex(entry), entry.replace);
	}
	return result;
}

export function applySnippets(text: string, entries: readonly SnippetEntry[]): string {
	let result = text;
	for (const entry of entries) {
		result = result.replaceAll(entry.trigger, entry.expansion);
	}
	return result;
}

export function applyAllReplacements(
	text: string,
	dictionary: readonly DictionaryEntry[],
	snippets: readonly SnippetEntry[]
): string {
	let result = applyDictionary(text, dictionary);
	result = applySnippets(result, snippets);
	return result;
}
