import type { components } from "@spec/schema";

type DictionaryEntry = components["schemas"]["DictionaryEntry"];
type SnippetEntry = components["schemas"]["SnippetEntry"];

export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
	let result = text;
	for (const entry of entries) {
		const flags = entry.caseSensitive ? "g" : "gi";
		const pattern = entry.wholeWord ? `\\b${escapeRegex(entry.find)}\\b` : escapeRegex(entry.find);
		result = result.replace(new RegExp(pattern, flags), entry.replace);
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

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
