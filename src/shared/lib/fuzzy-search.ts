const TOKEN_RE = /[a-z0-9]+/g;
const VERSION_TOKEN_RE = /^(?:v|ver|version)(\d+[a-z]?)$/;
const LETTER_NUMBER_RE = /^([a-z]+)(\d+[a-z]?)$/;
const MIN_FUZZY_TOKEN_LENGTH = 4;

function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase();
}

function uniqueTokens(tokens: string[]): string[] {
	return [...new Set(tokens.filter((token) => token.length > 0))];
}

function pushVersionAliases(tokens: string[], token: string): boolean {
	const match = VERSION_TOKEN_RE.exec(token);
	if (!match?.[1]) {
		return false;
	}
	const version = match[1];
	tokens.push(`v${version}`, `version${version}`, "version", version);
	return true;
}

function pushLetterNumberParts(tokens: string[], token: string): void {
	const match = LETTER_NUMBER_RE.exec(token);
	if (!match?.[1] || !match[2]) {
		return;
	}
	tokens.push(match[1], match[2]);
}

function rawTokens(text: string): string[] {
	return normalizeSearchText(text).match(TOKEN_RE) ?? [];
}

function buildHaystackTokens(text: string): string[] {
	const raw = rawTokens(text);
	const tokens: string[] = [];
	for (const token of raw) {
		tokens.push(token);
		pushVersionAliases(tokens, token);
		pushLetterNumberParts(tokens, token);
	}
	for (let index = 0; index < raw.length - 1; index++) {
		const current = raw[index];
		const next = raw[index + 1];
		if (
			(current === "version" || current === "ver" || current === "v") &&
			next
		) {
			tokens.push(`v${next}`, `version${next}`);
		}
	}
	return uniqueTokens(tokens);
}

function buildQueryTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const token of rawTokens(text)) {
		if (pushVersionAliases(tokens, token)) {
			continue;
		}
		tokens.push(token);
		pushLetterNumberParts(tokens, token);
	}
	return uniqueTokens(tokens);
}

function compact(text: string): string {
	return rawTokens(text).join("");
}

function tokenHasLiteralMatch(
	queryToken: string,
	haystackToken: string,
): boolean {
	return (
		haystackToken === queryToken ||
		haystackToken.startsWith(queryToken) ||
		(queryToken.length >= 3 && haystackToken.includes(queryToken))
	);
}

function allowedEditDistance(a: string, b: string): number {
	const length = Math.max(a.length, b.length);
	if (length < MIN_FUZZY_TOKEN_LENGTH) {
		return 0;
	}
	return length > 8 ? 2 : 1;
}

function rowValue(row: Uint32Array, index: number): number {
	const value = row[index];
	if (value === undefined) {
		throw new RangeError(`Invalid fuzzy-search distance cell: ${index}`);
	}
	return value;
}

function damerauLevenshteinDistance(
	a: string,
	b: string,
	maxDistance: number,
): number {
	if (Math.abs(a.length - b.length) > maxDistance) {
		return maxDistance + 1;
	}
	let previousPreviousRow = new Uint32Array(b.length + 1);
	let previousRow = new Uint32Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) {
		previousRow[j] = j;
	}
	for (let i = 1; i <= a.length; i++) {
		const currentRow = new Uint32Array(b.length + 1);
		currentRow[0] = i;
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			let value = Math.min(
				rowValue(previousRow, j) + 1,
				rowValue(currentRow, j - 1) + 1,
				rowValue(previousRow, j - 1) + cost,
			);
			if (
				i > 1 &&
				j > 1 &&
				a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
				a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
			) {
				value = Math.min(value, rowValue(previousPreviousRow, j - 2) + 1);
			}
			currentRow[j] = value;
			rowMin = Math.min(rowMin, value);
		}
		if (rowMin > maxDistance) {
			return maxDistance + 1;
		}
		previousPreviousRow = previousRow;
		previousRow = currentRow;
	}
	return rowValue(previousRow, b.length);
}

function tokenHasFuzzyMatch(
	queryToken: string,
	haystackToken: string,
): boolean {
	const maxDistance = allowedEditDistance(queryToken, haystackToken);
	if (maxDistance === 0) {
		return false;
	}
	return (
		damerauLevenshteinDistance(queryToken, haystackToken, maxDistance) <=
		maxDistance
	);
}

function tokenMatches(
	queryToken: string,
	haystackTokens: readonly string[],
): boolean {
	return haystackTokens.some(
		(haystackToken) =>
			tokenHasLiteralMatch(queryToken, haystackToken) ||
			tokenHasFuzzyMatch(queryToken, haystackToken),
	);
}

/**
 * Local UI fuzzy search predicate. It keeps substring/prefix behavior, then
 * requires every query token to match a haystack token by prefix, containment,
 * or a small Damerau-Levenshtein typo distance. Version aliases let compact
 * input such as "v3" match labels that spell out "version 3".
 */
export function matchesFuzzySearch(
	haystack: string | readonly string[],
	query: string,
): boolean {
	const q = normalizeSearchText(query.trim());
	if (q.length === 0) {
		return true;
	}
	const hay = normalizeSearchText(
		typeof haystack === "string" ? haystack : haystack.join(" "),
	);
	if (hay.includes(q) || compact(hay).includes(compact(q))) {
		return true;
	}
	const queryTokens = buildQueryTokens(q);
	if (queryTokens.length === 0) {
		return false;
	}
	const haystackTokens = buildHaystackTokens(hay);
	return queryTokens.every((token) => tokenMatches(token, haystackTokens));
}
