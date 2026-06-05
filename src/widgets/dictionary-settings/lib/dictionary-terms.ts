interface DictionaryTermLike {
	term: string;
}

export function normalizeDictionaryTerm(term: string): string {
	return term.trim().toLowerCase();
}

export function dictionaryContainsTerm(
	entries: readonly DictionaryTermLike[],
	term: string,
): boolean {
	const normalized = normalizeDictionaryTerm(term);
	return (
		normalized.length > 0 &&
		entries.some((entry) => normalizeDictionaryTerm(entry.term) === normalized)
	);
}
