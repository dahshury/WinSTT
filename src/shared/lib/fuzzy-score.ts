import {
	allowedEditDistance,
	damerauLevenshteinDistance,
	normalizeSearchText,
	prepareHaystack,
	prepareQuery,
	tokenHasLiteralMatch,
} from "./fuzzy-search";

export interface HighlightRange {
	end: number;
	start: number;
}

export interface FuzzyMatchScore {
	cost: number;
	tier: 0 | 1 | 2;
}

function tokenDistance(
	queryToken: string,
	haystackToken: string,
): number | null {
	if (tokenHasLiteralMatch(queryToken, haystackToken)) {
		return 0;
	}
	const maxDistance = allowedEditDistance(queryToken, haystackToken);
	if (maxDistance === 0) {
		return null;
	}
	const distance = damerauLevenshteinDistance(
		queryToken,
		haystackToken,
		maxDistance,
	);
	return distance <= maxDistance ? distance : null;
}

export function scoreFuzzyMatch(
	haystack: string,
	query: string,
): FuzzyMatchScore | null {
	const preparedQuery = prepareQuery(query);
	if (preparedQuery.normalized.length === 0) {
		return null;
	}
	const preparedHaystack = prepareHaystack(haystack);
	if (preparedHaystack.normalized.includes(preparedQuery.normalized)) {
		return { cost: 0, tier: 0 };
	}
	if (preparedQuery.tokens.length === 0) {
		return null;
	}
	let cost = 0;
	let usedFuzzyMatch = false;
	for (const queryToken of preparedQuery.tokens) {
		let best: number | null = null;
		for (const haystackToken of preparedHaystack.tokens) {
			const distance = tokenDistance(queryToken, haystackToken);
			if (distance !== null && (best === null || distance < best)) {
				best = distance;
			}
		}
		if (best === null) {
			return null;
		}
		cost += best;
		usedFuzzyMatch ||= best > 0;
	}
	return { cost, tier: usedFuzzyMatch ? 2 : 1 };
}

interface OriginalToken extends HighlightRange {
	normalized: string;
}

function originalTokens(text: string): OriginalToken[] {
	const tokens: OriginalToken[] = [];
	for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
		if (match.index === undefined) {
			continue;
		}
		tokens.push({
			start: match.index,
			end: match.index + match[0].length,
			normalized: normalizeSearchText(match[0]),
		});
	}
	return tokens;
}

function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
	const sorted = ranges.toSorted((a, b) => a.start - b.start || a.end - b.end);
	const merged: HighlightRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

export function computeHighlightRanges(
	text: string,
	query: string,
): HighlightRange[] {
	const queryTokens = originalTokens(query).map((token) => token.normalized);
	if (queryTokens.length === 0) {
		return [];
	}
	const lowerText = text.toLocaleLowerCase();
	const haystackTokens = originalTokens(text);
	const ranges: HighlightRange[] = [];
	for (const queryToken of queryTokens) {
		const literal = queryToken.toLocaleLowerCase();
		let index = lowerText.indexOf(literal);
		if (index >= 0) {
			while (index >= 0) {
				ranges.push({ start: index, end: index + literal.length });
				index = lowerText.indexOf(literal, index + Math.max(literal.length, 1));
			}
			continue;
		}
		let best: { distance: number; token: OriginalToken } | null = null;
		for (const token of haystackTokens) {
			const distance = tokenDistance(queryToken, token.normalized);
			if (distance !== null && (best === null || distance < best.distance)) {
				best = { distance, token };
			}
		}
		if (best) {
			ranges.push({ start: best.token.start, end: best.token.end });
		}
	}
	return mergeRanges(ranges);
}
