import type { OpenRouterModel } from "@/shared/api/models";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import type { ModelVariant } from "./model-variant-utils";
import { hasAnyVariant, hasVariant } from "./model-variant-utils";
import type { FilterableParameter } from "./openrouter-provider-utils";

export interface FilterModelsOptions {
	searchQuery?: string;
	selectedEndpointProvider?: string | null;
	selectedMakers?: string[];
	selectedParameters?: FilterableParameter[];
	selectedVariant?: ModelVariant | "none" | null;
}

interface LowerCasedModel {
	id: string;
	maker: string;
	modelName: string;
	name: string;
}

const lowerCasedCache = new WeakMap<OpenRouterModel, LowerCasedModel>();
const searchCorpusCache = new WeakMap<OpenRouterModel, string[]>();
const supportedParametersCache = new WeakMap<readonly string[], ReadonlySet<string>>();

function toLowerOrEmpty(value: string | undefined): string {
	return value?.toLowerCase() ?? "";
}

function toLowerCased(model: OpenRouterModel): LowerCasedModel {
	const cached = lowerCasedCache.get(model);
	if (cached) {
		return cached;
	}
	const lowerCased = {
		maker: toLowerOrEmpty(model.maker),
		name: toLowerOrEmpty(model.name),
		id: toLowerOrEmpty(model.id),
		modelName: toLowerOrEmpty(model.model_name),
	};
	lowerCasedCache.set(model, lowerCased);
	return lowerCased;
}

function anyNameStartsWith(lc: LowerCasedModel, q: string): boolean {
	return (
		lc.name.startsWith(q) || lc.id.startsWith(q) || lc.modelName.startsWith(q)
	);
}

function anyNameIncludes(lc: LowerCasedModel, q: string): boolean {
	return lc.name.includes(q) || lc.id.includes(q) || lc.modelName.includes(q);
}

function scoreMakerMatch(lc: LowerCasedModel, q: string): number {
	if (lc.maker === q) {
		return 1;
	}
	if (lc.maker.startsWith(q)) {
		return 2;
	}
	return 0;
}

function scoreIncludesMatch(lc: LowerCasedModel, q: string): number {
	if (lc.maker.includes(q)) {
		return 4;
	}
	return anyNameIncludes(lc, q) ? 5 : 0;
}

function scoreNameMatch(lc: LowerCasedModel, q: string): number {
	if (anyNameStartsWith(lc, q)) {
		return 3;
	}
	return scoreIncludesMatch(lc, q);
}

function scoreModelMatch(
	model: OpenRouterModel,
	normalizedQuery: string,
): number {
	const lc = toLowerCased(model);
	const makerScore = scoreMakerMatch(lc, normalizedQuery);
	return makerScore || scoreNameMatch(lc, normalizedQuery);
}

interface MatchWithScore {
	model: OpenRouterModel;
	score: number;
}

function collectExactMatches(
	models: OpenRouterModel[],
	normalizedQuery: string,
): OpenRouterModel[] {
	const exactMatches: MatchWithScore[] = [];
	for (const model of models) {
		const score = scoreModelMatch(model, normalizedQuery);
		if (score > 0) {
			exactMatches.push({ model, score });
		}
	}
	return exactMatches.toSorted((a, b) => a.score - b.score).map((m) => m.model);
}

function modelSearchCorpus(model: OpenRouterModel): string[] {
	const cached = searchCorpusCache.get(model);
	if (cached) {
		return cached;
	}
	const corpus = [
		model.name ?? "",
		model.id,
		model.model_name ?? "",
		model.maker ?? "",
		model.provider ?? "",
		model.description ?? "",
		model.variant ?? "",
	];
	searchCorpusCache.set(model, corpus);
	return corpus;
}

function appendSynchronousFuzzyMatches(
	models: OpenRouterModel[],
	prioritized: OpenRouterModel[],
	query: string,
): OpenRouterModel[] {
	const includedIds = new Set(prioritized.map((m) => m.id));
	const combined = [...prioritized];
	for (const model of models) {
		if (includedIds.has(model.id)) {
			continue;
		}
		if (matchesFuzzySearch(modelSearchCorpus(model), query)) {
			combined.push(model);
			includedIds.add(model.id);
		}
	}
	return combined;
}

function searchModels(
	models: OpenRouterModel[],
	query: string,
): OpenRouterModel[] {
	if (!query.trim()) {
		return models;
	}
	const normalizedQuery = query.trim().toLowerCase();
	const prioritized = collectExactMatches(models, normalizedQuery);
	return appendSynchronousFuzzyMatches(models, prioritized, query);
}

function matchesVariantFilter(
	modelId: string,
	selectedVariant: ModelVariant | "none",
): boolean {
	if (selectedVariant === "none") {
		return !hasAnyVariant(modelId);
	}
	return hasVariant(modelId, selectedVariant);
}

function endpointMatches(
	endpoint: NonNullable<OpenRouterModel["endpoints"]>[number],
	selectedEndpointProvider: string,
): boolean {
	return [
		// Stryker disable next-line ConditionalExpression: equivalent — the lowercase comparison below subsumes the case-sensitive check; mutating to `false` still returns true when provider_name === selected because provider_name.toLowerCase() === selected.toLowerCase()
		endpoint.provider_name === selectedEndpointProvider,
		endpoint.tag === selectedEndpointProvider,
		endpoint.provider_name?.toLowerCase() ===
			selectedEndpointProvider.toLowerCase(),
	].some(Boolean);
}

function matchesEndpointFilter(
	endpoints: OpenRouterModel["endpoints"],
	selectedEndpointProvider: string,
): boolean {
	return (
		endpoints?.some((e) => endpointMatches(e, selectedEndpointProvider)) ??
		false
	);
}

function isValidParameterList(
	supportedParameters: string[] | undefined,
): supportedParameters is string[] {
	return Array.isArray(supportedParameters);
}

function setHasAll(
	superset: ReadonlySet<string>,
	required: Iterable<string>,
): boolean {
	for (const item of required) {
		if (!superset.has(item)) {
			return false;
		}
	}
	return true;
}

function matchesParametersFilter(
	supportedParameters: string[] | undefined,
	selectedParametersSet: Set<FilterableParameter>,
): boolean {
	if (!isValidParameterList(supportedParameters)) {
		return false;
	}
	let modelParamsSet = supportedParametersCache.get(supportedParameters);
	if (!modelParamsSet) {
		modelParamsSet = new Set(supportedParameters);
		supportedParametersCache.set(supportedParameters, modelParamsSet);
	}
	return setHasAll(modelParamsSet, selectedParametersSet);
}

interface ActiveFilters {
	selectedEndpointProvider: string | null;
	selectedMakersSet: Set<string> | null;
	selectedParametersSet: Set<FilterableParameter> | null;
	selectedVariant: ModelVariant | "none" | null;
}

function passesMakerFilter(
	m: OpenRouterModel,
	makers: Set<string> | null,
): boolean {
	if (makers === null) {
		return true;
	}
	return m.maker !== undefined && makers.has(m.maker);
}

function passesVariantFilter(
	m: OpenRouterModel,
	variant: ModelVariant | "none" | null,
): boolean {
	if (variant === null) {
		return true;
	}
	return matchesVariantFilter(m.id, variant);
}

function passesEndpointFilter(
	m: OpenRouterModel,
	provider: string | null,
): boolean {
	if (provider === null) {
		return true;
	}
	return matchesEndpointFilter(m.endpoints, provider);
}

function passesParametersFilter(
	m: OpenRouterModel,
	params: Set<FilterableParameter> | null,
): boolean {
	if (params === null) {
		return true;
	}
	return matchesParametersFilter(m.supported_parameters, params);
}

function modelPassesFilters(
	m: OpenRouterModel,
	filters: ActiveFilters,
): boolean {
	return [
		passesMakerFilter(m, filters.selectedMakersSet),
		passesVariantFilter(m, filters.selectedVariant),
		passesEndpointFilter(m, filters.selectedEndpointProvider),
		passesParametersFilter(m, filters.selectedParametersSet),
	].every(Boolean);
}

function nonEmptySetOrNull<T>(items: T[] | undefined): Set<T> | null {
	if (!items) {
		return null;
	}
	return items.length > 0 ? new Set(items) : null;
}

function buildActiveFilters(options: FilterModelsOptions): ActiveFilters {
	return {
		selectedMakersSet: nonEmptySetOrNull(options.selectedMakers),
		selectedVariant: options.selectedVariant ?? null,
		selectedEndpointProvider: options.selectedEndpointProvider ?? null,
		selectedParametersSet: nonEmptySetOrNull(options.selectedParameters),
	};
}

function hasAnyActiveFilter(filters: ActiveFilters): boolean {
	return [
		filters.selectedMakersSet !== null,
		filters.selectedVariant !== null,
		filters.selectedEndpointProvider !== null,
		filters.selectedParametersSet !== null,
	].some(Boolean);
}

function applyActiveFilters(
	models: OpenRouterModel[],
	filters: ActiveFilters,
): OpenRouterModel[] {
	if (!hasAnyActiveFilter(filters)) {
		return models;
	}
	return models.filter((m) => modelPassesFilters(m, filters));
}

function applySearch(
	models: OpenRouterModel[],
	rawQuery: string | undefined,
): OpenRouterModel[] {
	const trimmed = rawQuery?.trim();
	if (!trimmed) {
		return models;
	}
	return searchModels(models, trimmed);
}

export function filterModels(
	models: OpenRouterModel[],
	options: FilterModelsOptions,
): OpenRouterModel[] {
	const filters = buildActiveFilters(options);
	const filtered = applyActiveFilters(models, filters);
	return applySearch(filtered, options.searchQuery);
}

function getMakerKey(model: OpenRouterModel): string {
	const raw = model.maker;
	return raw ? raw : "Other";
}

function recordNewGroup(
	groups: Map<string, OpenRouterModel[]>,
	makerOrder: string[],
	preserveOrder: boolean,
	maker: string,
	model: OpenRouterModel,
): void {
	groups.set(maker, [model]);
	if (preserveOrder) {
		makerOrder.push(maker);
	}
}

function pushIntoGroup(
	groups: Map<string, OpenRouterModel[]>,
	makerOrder: string[],
	preserveOrder: boolean,
	model: OpenRouterModel,
): void {
	const maker = getMakerKey(model);
	const existing = groups.get(maker);
	if (existing) {
		existing.push(model);
		return;
	}
	recordNewGroup(groups, makerOrder, preserveOrder, maker, model);
}

function compareByMissingOrder(
	indexA: number,
	indexB: number,
	a: string,
	b: string,
): number {
	if (indexA !== -1) {
		return -1;
	}
	if (indexB !== -1) {
		return 1;
	}
	return a.localeCompare(b);
}

function makeOrderComparator(
	makerOrder: string[],
): (a: [string, OpenRouterModel[]], b: [string, OpenRouterModel[]]) => number {
	return ([a], [b]) => {
		const indexA = makerOrder.indexOf(a);
		const indexB = makerOrder.indexOf(b);
		if (indexA !== -1 && indexB !== -1) {
			return indexA - indexB;
		}
		return compareByMissingOrder(indexA, indexB, a, b);
	};
}

export function groupModelsByMaker(
	models: OpenRouterModel[],
	preserveOrder = false,
): [string, OpenRouterModel[]][] {
	const groups = new Map<string, OpenRouterModel[]>();
	const makerOrder: string[] = [];

	for (const model of models) {
		pushIntoGroup(groups, makerOrder, preserveOrder, model);
	}

	const entries = Array.from(groups.entries());

	if (preserveOrder) {
		return entries.toSorted(makeOrderComparator(makerOrder));
	}

	return entries.toSorted(([a], [b]) => a.localeCompare(b));
}
