/**
 * Pure maker-grouping logic + query matching for the Ollama picker (no JSX).
 *
 * Every model — installed, recommended, and (on search) library — collapses into
 * ONE group per maker, so gemma4 shows under "Google" next to gemma3 instead of in
 * a separate maker-less "Recommended"/"Library" pile. Also test-imported as
 * `buildMakerGroups`/`MakerGroup`.
 */

import type {
	OllamaLibraryHit,
	OllamaModel,
	RecommendedOllamaModel,
} from "@/shared/api/models";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import {
	formatOllamaDisplayName,
	getOllamaFamily,
	getOllamaPublisher,
	getOllamaPublisherBySlug,
} from "../lib/family-helpers";
import {
	isModelSizeInstalled,
	libraryBaseSlug,
} from "../lib/quant-shelf-helpers";
import {
	EMPTY_DESCRIPTION_BY_BASE,
	familySlugFromName,
	installedDescriptionForModel,
} from "./ollama-description-helpers";

export interface MakerGroup {
	installed: OllamaModel[];
	library: OllamaLibraryHit[];
	recommended: RecommendedOllamaModel[];
	slug: string;
}

function recommendedPublisherSlug(m: RecommendedOllamaModel): string {
	return getOllamaPublisher(
		(m.family ?? familySlugFromName(m.name)).toLowerCase(),
	).slug;
}

function ensureMakerGroup(
	map: Map<string, MakerGroup>,
	slug: string,
): MakerGroup {
	const found = map.get(slug);
	if (found) {
		return found;
	}
	const created: MakerGroup = {
		slug,
		installed: [],
		recommended: [],
		library: [],
	};
	map.set(slug, created);
	return created;
}

export function makerGroupCount(g: MakerGroup): number {
	return g.installed.length + g.recommended.length + g.library.length;
}

/**
 * Merge installed + recommended + (query-only) library models into one group per
 * maker, sorted by maker label. Library hits whose base slug is already shown as
 * an installed/recommended card in the same maker are dropped (no `gemma4` library
 * card next to the `gemma4:e2b` recommended card).
 */
export function buildMakerGroups(opts: {
	installed: readonly OllamaModel[];
	library: readonly OllamaLibraryHit[];
	recommended: readonly RecommendedOllamaModel[];
}): MakerGroup[] {
	const map = new Map<string, MakerGroup>();
	for (const m of opts.installed) {
		ensureMakerGroup(
			map,
			getOllamaPublisher(getOllamaFamily(m)).slug,
		).installed.push(m);
	}
	for (const m of opts.recommended) {
		ensureMakerGroup(map, recommendedPublisherSlug(m)).recommended.push(m);
	}
	for (const hit of opts.library) {
		const group = ensureMakerGroup(
			map,
			getOllamaPublisher(familySlugFromName(hit.name)).slug,
		);
		const covered = new Set(
			[...group.installed, ...group.recommended].map((m) =>
				libraryBaseSlug(m.name),
			),
		);
		if (!covered.has(libraryBaseSlug(hit.name))) {
			group.library.push(hit);
		}
	}
	return [...map.values()]
		.filter((g) => makerGroupCount(g) > 0)
		.toSorted((a, b) =>
			getOllamaPublisherBySlug(a.slug).label.localeCompare(
				getOllamaPublisherBySlug(b.slug).label,
			),
		);
}

/** Build the maker-grouped view. Search filters installed/recommended rows only;
 *  remote Ollama tags resolve through the exact-tag card instead of broad
 *  catalog search results. */
export function buildMakerView(opts: {
	installed: readonly OllamaModel[];
	recommended: readonly RecommendedOllamaModel[];
}): MakerGroup[] {
	const makerGroups = buildMakerGroups({
		installed: opts.installed,
		recommended: opts.recommended,
		library: [],
	});
	return makerGroups;
}

/**
 * True when an installed model is part of the curated catalog we ship — it shares
 * a (base slug, parameter size) with some recommended model.
 *
 * Catalog models ship with the application and their CARD must persist for the
 * application's lifetime, so they expose ONLY per-quant deletes (the trash on each
 * shelf badge) — never a whole-card delete, which would make a curated model
 * vanish. Deleting every quant simply reverts the card to its recommended /
 * download state. A model with NO catalog match was pulled ad-hoc (typed or
 * searched in the picker) and keeps the card-level delete so it can be removed
 * entirely.
 *
 * `catalogNames` is the set of curated model names
 * (`recommendedModels.map((m) => m.name)`).
 */
export function isCatalogBackedModel(
	catalogNames: ReadonlySet<string>,
	installedName: string,
): boolean {
	return isModelSizeInstalled(catalogNames, installedName);
}

/** Recommended models not already installed, filtered by the active query. */
export function computeRecommendedVisible(
	recommendedModels: readonly RecommendedOllamaModel[] | undefined,
	installedNameSet: ReadonlySet<string>,
	query: string,
): RecommendedOllamaModel[] {
	if (!recommendedModels) {
		return [];
	}
	return recommendedModels.filter(
		(m) =>
			// Hide a recommended card once ANY variant of its size is on disk — not
			// just the exact/aliased tag — so it collapses into the installed card
			// instead of showing a near-identical duplicate (e.g. recommended
			// `gemma4:e2b` next to installed `gemma4:e2b-it-q8_0`).
			!isModelSizeInstalled(installedNameSet, m.name) &&
			matchesRecommendedQuery(m, query),
	);
}

const installedSearchCorpusCache = new WeakMap<
	OllamaModel,
	{ corpus: string[]; description: string }
>();
const recommendedSearchCorpusCache = new WeakMap<
	RecommendedOllamaModel,
	string[]
>();

function installedSearchCorpus(
	m: OllamaModel,
	descriptionsByBase: ReadonlyMap<string, string>,
): string[] {
	const description = installedDescriptionForModel(m, descriptionsByBase) ?? "";
	const cached = installedSearchCorpusCache.get(m);
	if (cached && cached.description === description) {
		return cached.corpus;
	}
	const family = getOllamaFamily(m);
	const publisher = getOllamaPublisher(family);
	const corpus = [
		m.name,
		formatOllamaDisplayName(m.name),
		family,
		publisher.label,
		publisher.slug,
		description,
		m.details?.parameterSize ?? "",
		m.details?.quantizationLevel ?? "",
		m.details?.format ?? "",
		m.details?.family ?? "",
		...(m.details?.families ?? []),
		...(m.capabilities ?? []),
		String(m.contextLength ?? ""),
	];
	installedSearchCorpusCache.set(m, { corpus, description });
	return corpus;
}

/** Fuzzy match against the model's full search corpus. We index the
 *  beautified display name, the publisher label, and the publisher slug too
 *  so users typing "google" surface their installed Gemma models, "meta"
 *  surfaces Llama, "alibaba" or "qwen" surface Qwen, and so on — the same
 *  search affordance the OpenRouter picker offers. */
export function matchesInstalledQuery(
	m: OllamaModel,
	query: string,
	descriptionsByBase: ReadonlyMap<string, string> = EMPTY_DESCRIPTION_BY_BASE,
): boolean {
	return matchesFuzzySearch(
		installedSearchCorpus(m, descriptionsByBase),
		query,
	);
}

function matchesRecommendedQuery(
	m: RecommendedOllamaModel,
	query: string,
): boolean {
	const cached = recommendedSearchCorpusCache.get(m);
	if (cached !== undefined) {
		return matchesFuzzySearch(cached, query);
	}
	const family = (m.family ?? familySlugFromName(m.name)).toLowerCase();
	const publisher = getOllamaPublisher(family);
	const corpus = [
		m.name,
		m.displayName,
		m.description,
		family,
		publisher.label,
		publisher.slug,
		formatOllamaDisplayName(m.name),
		...(m.tags ?? []),
	];
	recommendedSearchCorpusCache.set(m, corpus);
	return matchesFuzzySearch(corpus, query);
}
