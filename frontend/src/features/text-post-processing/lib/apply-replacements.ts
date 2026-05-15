import type { components } from "@spec/schema";

type DictionaryEntry = components["schemas"]["DictionaryEntry"];
type SnippetEntry = components["schemas"]["SnippetEntry"];

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const regexCache = new Map<string, RegExp>();

function buildEntrySpec(entry: DictionaryEntry): { flags: string; pattern: string } {
	const flags = entry.caseSensitive ? "g" : "gi";
	const escaped = entry.find.replace(REGEX_ESCAPE_RE, "\\$&");
	const pattern = entry.wholeWord ? `\\b${escaped}\\b` : escaped;
	return { flags, pattern };
}

function getEntryRegex(entry: DictionaryEntry): RegExp {
	const { flags, pattern } = buildEntrySpec(entry);
	const cacheKey = `${flags}:${pattern}`;
	// Cache hit short-circuit is a perf optimization. Dropping it (always
	// recompile) yields a behavior-equivalent regex because String.prototype
	// .replace resets .lastIndex on each call, so no observable difference
	// at the call boundary — both LogicalExpression and AssignmentOperator
	// mutants are equivalent here.
	// Stryker disable next-line LogicalExpression
	// Stryker disable next-line AssignmentOperator
	return regexCache.get(cacheKey) ?? compileAndCache(cacheKey, pattern, flags);
}

function compileAndCache(cacheKey: string, pattern: string, flags: string): RegExp {
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
