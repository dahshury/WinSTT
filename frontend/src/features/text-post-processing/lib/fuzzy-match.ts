// Canonical implementation lives in the process-neutral shared layer so the
// Electron main process can consume the same fuzzy-matching logic without
// importing across the renderer FSD tree (separate processes).
export {
	bestDictionaryMatch,
	buildPhoneticTerm,
	DICTIONARY_JW_THRESHOLD,
	DICTIONARY_PHONETIC_JW_THRESHOLD,
	findSnippetMatches,
	jaroWinkler,
	type PhoneticTerm,
	replaceWithDictionary,
	replaceWithSnippets,
	SNIPPET_JW_THRESHOLD,
	type SnippetMatch,
} from "@/shared/lib/fuzzy-match";
