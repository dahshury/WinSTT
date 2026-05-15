import type { OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";

const VALID_MODEL_NAME_RE = /^[a-zA-Z0-9._:/-]+$/;

export function normalizeQuery(query: string): string {
	return query.trim().toLowerCase();
}

export function matchesQuery(haystack: string, needle: string): boolean {
	// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — without the early-return, the function falls through to `haystack.toLowerCase().includes("")` which is also `true` for any haystack.
	if (!needle) {
		return true;
	}
	return haystack.toLowerCase().includes(needle);
}

export function filterInstalledModels(
	models: readonly OllamaModel[],
	rawQuery: string
): OllamaModel[] {
	const q = normalizeQuery(rawQuery);
	// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — without the early-return, the code falls through to `models.filter((m) => matchesQuery(m.name, ""))`; matchesQuery("", "") is true for every row, so the filter still yields every model in a fresh array.
	if (!q) {
		return [...models];
	}
	return models.filter((m) => matchesQuery(m.name, q));
}

function getSearchableFields(model: RecommendedOllamaModel): string[] {
	return [model.name, model.displayName, model.description, ...(model.tags ?? [])];
}

export function matchesRecommended(
	model: RecommendedOllamaModel,
	installedNames: ReadonlySet<string>,
	q: string
): boolean {
	if (installedNames.has(model.name)) {
		return false;
	}
	// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — without the early-return, the code falls through to `.some((field) => matchesQuery(field, ""))`; matchesQuery returns true for the empty needle so .some() is also true given any non-empty fields list.
	if (!q) {
		return true;
	}
	return getSearchableFields(model).some((field) => matchesQuery(field, q));
}

export function filterRecommendedModels(
	models: readonly RecommendedOllamaModel[],
	installedNames: ReadonlySet<string>,
	rawQuery: string
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
