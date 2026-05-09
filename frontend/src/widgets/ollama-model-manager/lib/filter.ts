import type { OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";

const VALID_MODEL_NAME_RE = /^[a-zA-Z0-9._:/-]+$/;

export function normalizeQuery(query: string): string {
	return query.trim().toLowerCase();
}

export function matchesQuery(haystack: string, needle: string): boolean {
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
	if (!q) {
		return [...models];
	}
	return models.filter((m) => matchesQuery(m.name, q));
}

export function filterRecommendedModels(
	models: readonly RecommendedOllamaModel[],
	installedNames: ReadonlySet<string>,
	rawQuery: string
): RecommendedOllamaModel[] {
	const q = normalizeQuery(rawQuery);
	const filtered = models.filter((m) => {
		if (installedNames.has(m.name)) {
			return false;
		}
		if (!q) {
			return true;
		}
		return (
			matchesQuery(m.name, q) ||
			matchesQuery(m.displayName, q) ||
			matchesQuery(m.description, q) ||
			(m.tags ?? []).some((t) => matchesQuery(t, q))
		);
	});
	return filtered;
}

export function isCustomModelQuery(rawQuery: string): boolean {
	const q = rawQuery.trim();
	if (!q) {
		return false;
	}
	return VALID_MODEL_NAME_RE.test(q);
}

export function formatGigabytes(bytes: number): string {
	return (bytes / 1_000_000_000).toFixed(1);
}
