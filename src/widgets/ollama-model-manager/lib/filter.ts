import type { OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";

const VALID_MODEL_NAME_RE = /^[a-zA-Z0-9._:/-]+$/;

export function normalizeQuery(query: string): string {
	return query.trim().toLowerCase();
}

export function matchesQuery(haystack: string, needle: string): boolean {
	if (!needle) {
		return true;
	}
	return matchesFuzzySearch(haystack, needle);
}

export function filterInstalledModels(
	models: readonly OllamaModel[],
	rawQuery: string,
): OllamaModel[] {
	const q = normalizeQuery(rawQuery);
	if (!q) {
		return [...models];
	}
	return models.filter((m) => matchesQuery(m.name, q));
}

function getSearchableFields(model: RecommendedOllamaModel): string[] {
	return [
		model.name,
		model.displayName,
		model.description,
		...(model.tags ?? []),
	];
}

export function matchesRecommended(
	model: RecommendedOllamaModel,
	installedNames: ReadonlySet<string>,
	q: string,
): boolean {
	if (installedNames.has(model.name)) {
		return false;
	}
	if (!q) {
		return true;
	}
	return matchesFuzzySearch(getSearchableFields(model), q);
}

export function filterRecommendedModels(
	models: readonly RecommendedOllamaModel[],
	installedNames: ReadonlySet<string>,
	rawQuery: string,
): RecommendedOllamaModel[] {
	const q = normalizeQuery(rawQuery);
	return models.filter((m) => matchesRecommended(m, installedNames, q));
}

export function isCustomModelQuery(rawQuery: string): boolean {
	const q = rawQuery.trim();
	// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — without the early-return, the code falls through to `VALID_MODEL_NAME_RE.test("")`; the regex requires one-or-more characters so the empty string fails it and the function still returns false.
	if (!q) {
		return false;
	}
	return VALID_MODEL_NAME_RE.test(q);
}

export function formatGigabytes(bytes: number): string {
	return (bytes / 1_000_000_000).toFixed(1);
}
