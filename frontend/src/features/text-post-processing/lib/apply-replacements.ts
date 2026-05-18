import type { components } from "@spec/schema";
import { buildPhoneticTerm, replaceWithDictionary, replaceWithSnippets } from "./fuzzy-match";

type DictionaryEntry = components["schemas"]["DictionaryEntry"];
type SnippetEntry = components["schemas"]["SnippetEntry"];

export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
	if (entries.length === 0) {
		return text;
	}
	const terms = entries.map((e) => buildPhoneticTerm(e.term));
	return replaceWithDictionary(text, terms);
}

export function applySnippets(text: string, entries: readonly SnippetEntry[]): string {
	if (entries.length === 0) {
		return text;
	}
	return replaceWithSnippets(text, entries);
}

export function applyAllReplacements(
	text: string,
	dictionary: readonly DictionaryEntry[],
	snippets: readonly SnippetEntry[]
): string {
	const afterDict = applyDictionary(text, dictionary);
	return applySnippets(afterDict, snippets);
}
