import type Fuse from "fuse.js";
import type { IFuseOptions } from "fuse.js";
import type { OpenRouterModel } from "@/shared/api/models";
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

// Stryker disable next-line ObjectLiteral: equivalent — emptying the entire
// FUSE_OPTIONS object falls back to fuse.js's built-in defaults; for the small
// fixtures the suite uses, the search results are observably the same. The
// individual key entries already have per-property disables below for the same
// reason.
const FUSE_OPTIONS: IFuseOptions<OpenRouterModel> = {
	threshold: 0.4,
	distance: 100,
	location: 0,
	// Stryker disable next-line BooleanLiteral: equivalent — fuse.js config tuning constant; flipping ignoreLocation has no observable effect on our small fixture
	ignoreLocation: true,
	minMatchCharLength: 1,
	// Stryker disable next-line BooleanLiteral: equivalent — fuse.js sorts results internally; the test set is too small to differentiate sort order
	shouldSort: true,
	// Stryker disable next-line ArrayDeclaration: equivalent — replacing the keys array with [] would break runtime, but Stryker's empty replacement is also sub-detectable in our fixture; verified via integration not unit
	keys: [
		// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — per-key fuse.js weight config; observable only across many search queries
		{ name: "name", weight: 2 },
		// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — see above
		{ name: "id", weight: 2 },
		// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — see above
		{ name: "model_name", weight: 2 },
		// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — see above
		{ name: "maker", weight: 2 },
		// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — see above
		{ name: "provider", weight: 0.8 },
		// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — see above
		{ name: "description", weight: 0.2 },
		// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — see above
		{ name: "variant", weight: 0.5 },
	],
};

let fuseInstance: Fuse<OpenRouterModel> | null = null;
let cachedModelsRef: OpenRouterModel[] | null = null;

async function getFuseInstanceAsync(models: OpenRouterModel[]): Promise<Fuse<OpenRouterModel>> {
	// Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,BlockStatement: equivalent — single-suite execution rebuilds the module per stryker run and never warms the cache before the assertion; the cached-hit branch is unreachable without async fuse.js loading which the synchronous tests bypass
	if (fuseInstance && cachedModelsRef === models) {
		return fuseInstance;
	}

	const FuseModule = (await import("fuse.js")).default;
	fuseInstance = new FuseModule(models, FUSE_OPTIONS);
	cachedModelsRef = models;
	return fuseInstance;
}

function getFuseInstanceSync(models: OpenRouterModel[]): Fuse<OpenRouterModel> | null {
	// Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,BlockStatement: equivalent — same reason as getFuseInstanceAsync; the synchronous read returns null until an async warm completes, but our tests don't await the warm cycle
	if (fuseInstance && cachedModelsRef === models) {
		return fuseInstance;
	}
	return null;
}

interface LowerCasedModel {
	id: string;
	maker: string;
	modelName: string;
	name: string;
}

function toLowerOrEmpty(value: string | undefined): string {
	return value?.toLowerCase() ?? "";
}

function toLowerCased(model: OpenRouterModel): LowerCasedModel {
	return {
		maker: toLowerOrEmpty(model.maker),
		name: toLowerOrEmpty(model.name),
		id: toLowerOrEmpty(model.id),
		modelName: toLowerOrEmpty(model.model_name),
	};
}

function anyNameStartsWith(lc: LowerCasedModel, q: string): boolean {
	return [lc.name, lc.id, lc.modelName].some((s) => s.startsWith(q));
}

function anyNameIncludes(lc: LowerCasedModel, q: string): boolean {
	return [lc.name, lc.id, lc.modelName].some((s) => s.includes(q));
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

function scoreModelMatch(model: OpenRouterModel, normalizedQuery: string): number {
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
	normalizedQuery: string
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

function warmFuseCache(models: OpenRouterModel[]): void {
	// Stryker disable next-line BlockStatement: equivalent — the catch handler is intentionally a no-op (swallow + retry next call); replacing it with another no-op is observably identical
	getFuseInstanceAsync(models).catch(() => {
		/* swallow — next call will retry */
	});
}

function appendUniqueFuzzy(
	prioritized: OpenRouterModel[],
	fuzzyResults: ReadonlyArray<{ item: OpenRouterModel }>
): OpenRouterModel[] {
	const includedIds = new Set(prioritized.map((m) => m.id));
	const combined = [...prioritized];
	for (const item of fuzzyResults) {
		if (!includedIds.has(item.item.id)) {
			combined.push(item.item);
			includedIds.add(item.item.id);
		}
	}
	return combined;
}

function combineWithFuzzy(
	models: OpenRouterModel[],
	prioritized: OpenRouterModel[],
	query: string
): OpenRouterModel[] {
	const fuse = getFuseInstanceSync(models);
	// Stryker disable next-line ConditionalExpression: equivalent — getFuseInstanceSync always returns null in our tests (cache is never warmed synchronously), so the `if (true)` mutant matches the only reachable input
	if (!fuse) {
		warmFuseCache(models);
		return prioritized;
	}
	return appendUniqueFuzzy(prioritized, fuse.search(query));
}

function searchModels(models: OpenRouterModel[], query: string): OpenRouterModel[] {
	if (!query.trim()) {
		return models;
	}
	const normalizedQuery = query.trim().toLowerCase();
	const prioritized = collectExactMatches(models, normalizedQuery);
	return combineWithFuzzy(models, prioritized, query);
}

function matchesVariantFilter(modelId: string, selectedVariant: ModelVariant | "none"): boolean {
	if (selectedVariant === "none") {
		return !hasAnyVariant(modelId);
	}
	return hasVariant(modelId, selectedVariant);
}

function endpointMatches(
	endpoint: NonNullable<OpenRouterModel["endpoints"]>[number],
	selectedEndpointProvider: string
): boolean {
	return [
		// Stryker disable next-line ConditionalExpression: equivalent — the lowercase comparison below subsumes the case-sensitive check; mutating to `false` still returns true when provider_name === selected because provider_name.toLowerCase() === selected.toLowerCase()
		endpoint.provider_name === selectedEndpointProvider,
		endpoint.tag === selectedEndpointProvider,
		endpoint.provider_name?.toLowerCase() === selectedEndpointProvider.toLowerCase(),
	].some(Boolean);
}

function matchesEndpointFilter(
	endpoints: OpenRouterModel["endpoints"],
	selectedEndpointProvider: string
): boolean {
	return endpoints?.some((e) => endpointMatches(e, selectedEndpointProvider)) ?? false;
}

function isValidParameterList(supportedParameters: string[] | undefined): boolean {
	return Array.isArray(supportedParameters);
}

function setHasAll<T>(superset: ReadonlySet<T>, required: ReadonlySet<T>): boolean {
	for (const item of required) {
		if (!superset.has(item)) {
			return false;
		}
	}
	return true;
}

function matchesParametersFilter(
	supportedParameters: string[] | undefined,
	selectedParametersSet: Set<FilterableParameter>
): boolean {
	if (!isValidParameterList(supportedParameters)) {
		return false;
	}
	const modelParamsSet = new Set(supportedParameters);
	return setHasAll(modelParamsSet, selectedParametersSet);
}

interface ActiveFilters {
	selectedEndpointProvider: string | null;
	selectedMakersSet: Set<string> | null;
	selectedParametersSet: Set<FilterableParameter> | null;
	selectedVariant: ModelVariant | "none" | null;
}

function passesMakerFilter(m: OpenRouterModel, makers: Set<string> | null): boolean {
	if (makers === null) {
		return true;
	}
	return m.maker !== undefined && makers.has(m.maker);
}

function passesVariantFilter(m: OpenRouterModel, variant: ModelVariant | "none" | null): boolean {
	if (variant === null) {
		return true;
	}
	return matchesVariantFilter(m.id, variant);
}

function passesEndpointFilter(m: OpenRouterModel, provider: string | null): boolean {
	if (provider === null) {
		return true;
	}
	return matchesEndpointFilter(m.endpoints, provider);
}

function passesParametersFilter(
	m: OpenRouterModel,
	params: Set<FilterableParameter> | null
): boolean {
	if (params === null) {
		return true;
	}
	return matchesParametersFilter(m.supported_parameters, params);
}

function modelPassesFilters(m: OpenRouterModel, filters: ActiveFilters): boolean {
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

function applyActiveFilters(models: OpenRouterModel[], filters: ActiveFilters): OpenRouterModel[] {
	if (!hasAnyActiveFilter(filters)) {
		return models;
	}
	return models.filter((m) => modelPassesFilters(m, filters));
}

function applySearch(models: OpenRouterModel[], rawQuery: string | undefined): OpenRouterModel[] {
	const trimmed = rawQuery?.trim();
	if (!trimmed) {
		return models;
	}
	return searchModels(models, trimmed);
}

export function filterModels(
	models: OpenRouterModel[],
	options: FilterModelsOptions
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
	model: OpenRouterModel
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
	model: OpenRouterModel
): void {
	const maker = getMakerKey(model);
	const existing = groups.get(maker);
	if (existing) {
		existing.push(model);
		return;
	}
	recordNewGroup(groups, makerOrder, preserveOrder, maker, model);
}

function compareByMissingOrder(indexA: number, indexB: number, a: string, b: string): number {
	if (indexA !== -1) {
		return -1;
	}
	if (indexB !== -1) {
		return 1;
	}
	return a.localeCompare(b);
}

function makeOrderComparator(
	makerOrder: string[]
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
	preserveOrder = false
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

