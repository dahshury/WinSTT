import { matchesFuzzySearch } from "./fuzzy-search";

/**
 * Modality-agnostic ranking projection of a model. Every picker maps its own
 * model shape onto this so the relevance pipeline stays shared — the STT / TTS /
 * Ollama / OpenRouter corpora differ, but the ranking tiers do not.
 *
 * The tiers (lowest = best) mirror the original OpenRouter scoring:
 *   1 maker exact · 2 maker prefix · 3 name prefix · 4 maker substring ·
 *   5 name substring · (no direct hit → fuzzy fallback only).
 */
export interface SearchRankable {
	/** Maker / author / publisher — earns the top exact/prefix tiers. */
	maker: string;
	/** Name-ish fields (display name, id, model name) — prefix/substring tiers. */
	names: readonly string[];
	/**
	 * Full fuzzy corpus (string or field array) for the fuzzy fallback in
	 * {@link rankBySearch}. Optional: the order-only helpers
	 * ({@link orderByRelevance}, {@link bestRelevance}, {@link rankGroupsBySearch})
	 * never read it, because those callers keep their own visibility filter and
	 * only need the direct-match tiers.
	 */
	corpus?: string | readonly string[];
}

/**
 * Direct-match tier for a normalized (trimmed, lowercased) query. Returns 0 when
 * nothing matches exactly / by prefix / by substring — such items are reachable
 * only via the fuzzy fallback and are ranked last.
 */
function directRelevanceScore(
	rankable: SearchRankable,
	normalizedQuery: string,
): number {
	const maker = rankable.maker.toLowerCase();
	if (maker === normalizedQuery) {
		return 1;
	}
	if (maker.startsWith(normalizedQuery)) {
		return 2;
	}
	if (rankable.names.some((n) => n.toLowerCase().startsWith(normalizedQuery))) {
		return 3;
	}
	if (maker.includes(normalizedQuery)) {
		return 4;
	}
	if (rankable.names.some((n) => n.toLowerCase().includes(normalizedQuery))) {
		return 5;
	}
	return 0;
}

/** Score for ordering: 0 (no direct hit) sinks below every real tier. */
function orderingRank(
	rankable: SearchRankable,
	normalizedQuery: string,
): number {
	const score = directRelevanceScore(rankable, normalizedQuery);
	return score === 0 ? Number.POSITIVE_INFINITY : score;
}

/**
 * Filter + relevance-rank a FLAT list, for callers that group downstream on
 * their own (OpenRouter). Direct matches lead in tier order; the fuzzy-only
 * matches follow in their original order; non-matching items are dropped. A
 * blank query returns the items unchanged.
 */
export function rankBySearch<T>(
	items: readonly T[],
	query: string,
	project: (item: T) => SearchRankable,
): T[] {
	if (!query.trim()) {
		return [...items];
	}
	const normalizedQuery = query.trim().toLowerCase();
	const direct: { index: number; item: T; score: number }[] = [];
	const rest: T[] = [];
	items.forEach((item, index) => {
		const score = directRelevanceScore(project(item), normalizedQuery);
		if (score > 0) {
			direct.push({ index, item, score });
		} else {
			rest.push(item);
		}
	});
	direct.sort((a, b) => a.score - b.score || a.index - b.index);
	const fuzzy = rest.filter((item) =>
		matchesFuzzySearch(project(item).corpus ?? project(item).names, query),
	);
	return [...direct.map((entry) => entry.item), ...fuzzy];
}

/**
 * Order items best-match-first for a list whose *visibility* is still owned by
 * the combobox's own `filter` (STT / TTS / Ollama). Direct matches lead in tier
 * order; everything else keeps its original relative order (it will be hidden by
 * the filter, so only the ranked matches show). A blank query returns the items
 * unchanged.
 */
export function orderByRelevance<T>(
	items: readonly T[],
	query: string,
	project: (item: T) => SearchRankable,
): T[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return [...items];
	}
	return items
		.map((item, index) => ({
			index,
			item,
			rank: orderingRank(project(item), normalizedQuery),
		}))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.item);
}

/**
 * Best (lowest) direct-relevance tier among a group's items, or `Infinity` when
 * none directly match. Used to order groups so the one holding the closest match
 * leads. A blank query yields `Infinity` (no reordering).
 */
export function bestRelevance<T>(
	items: readonly T[],
	query: string,
	project: (item: T) => SearchRankable,
): number {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return Number.POSITIVE_INFINITY;
	}
	let best = Number.POSITIVE_INFINITY;
	for (const item of items) {
		const score = directRelevanceScore(project(item), normalizedQuery);
		if (score > 0 && score < best) {
			best = score;
		}
	}
	return best;
}

/**
 * Reorder a grouped list best-match-first during an active search: each group's
 * items are ordered by relevance, and the groups themselves are ordered by their
 * closest match (stable — ties keep the original group order). A blank query
 * returns the groups unchanged. Synthetic / pinned groups (favorites) are the
 * caller's concern: rank the real groups first, then prepend the pinned one.
 *
 * `rebuild` re-attaches the reordered items to the concrete group shape, which
 * keeps this generic without spreading an unconstrained type parameter.
 */
export function rankGroupsBySearch<T, G extends { items: T[] }>(
	groups: readonly G[],
	query: string,
	project: (item: T) => SearchRankable,
	rebuild: (group: G, items: T[]) => G,
): G[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return [...groups];
	}
	return groups
		.map((group, index) => {
			const items = orderByRelevance(group.items, normalizedQuery, project);
			return {
				best: bestRelevance(items, normalizedQuery, project),
				group: rebuild(group, items),
				index,
			};
		})
		.sort((a, b) => a.best - b.best || a.index - b.index)
		.map((entry) => entry.group);
}
