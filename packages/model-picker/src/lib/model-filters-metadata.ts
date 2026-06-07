import type { OpenRouterModel } from "@/shared/api/models";
import { MODEL_VARIANTS, type ModelVariant } from "./model-variant-utils";
import {
	FILTERABLE_PARAMETERS,
	type FilterableParameter,
} from "./openrouter-provider-utils";

export interface ModelFiltersMetadata {
	availableVariants: Array<ModelVariant | "none">;
	endpointProviders: [string, number][];
	parameterCounts: Map<FilterableParameter, number>;
	providerCounts: Map<string, number>;
	variantCounts: Map<ModelVariant | "none", number>;
}

interface MetadataAccumulator {
	endpointProvidersMap: Map<string, number>;
	hasNoVariant: boolean;
	parameterCounts: Map<FilterableParameter, number>;
	providerCounts: Map<string, number>;
	variantCounts: Map<ModelVariant | "none", number>;
	variants: Set<ModelVariant>;
}

function createAccumulator(): MetadataAccumulator {
	const parameterCounts = new Map<FilterableParameter, number>();
	for (const param of FILTERABLE_PARAMETERS) {
		parameterCounts.set(param, 0);
	}
	return {
		variants: new Set<ModelVariant>(),
		hasNoVariant: false,
		variantCounts: new Map(),
		endpointProvidersMap: new Map(),
		providerCounts: new Map(),
		parameterCounts,
	};
}

function bumpCount<K>(map: Map<K, number>, key: K): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function modelHasImplicitVariant(model: OpenRouterModel): boolean {
	return MODEL_VARIANTS.some((v) => model.id.endsWith(`:${v}`));
}

function accumulateVariant(
	acc: MetadataAccumulator,
	model: OpenRouterModel,
): void {
	if (model.variant) {
		acc.variants.add(model.variant);
		bumpCount(acc.variantCounts, model.variant);
		return;
	}
	if (modelHasImplicitVariant(model)) {
		return;
	}
	acc.hasNoVariant = true;
	bumpCount(acc.variantCounts, "none");
}

function accumulateEndpoints(
	acc: MetadataAccumulator,
	model: OpenRouterModel,
): void {
	if (!model.endpoints) {
		return;
	}
	const seen = new Set<string>();
	for (const ep of model.endpoints) {
		registerEndpointProvider(acc, ep.provider_name, seen);
	}
}

function registerEndpointProvider(
	acc: MetadataAccumulator,
	name: string | undefined,
	seen: Set<string>,
): void {
	if (!name) {
		return;
	}
	if (seen.has(name)) {
		return;
	}
	seen.add(name);
	bumpCount(acc.endpointProvidersMap, name);
}

function accumulateMaker(
	acc: MetadataAccumulator,
	model: OpenRouterModel,
): void {
	if (!model.maker) {
		return;
	}
	bumpCount(acc.providerCounts, model.maker);
}

function accumulateParameters(
	acc: MetadataAccumulator,
	model: OpenRouterModel,
): void {
	if (!Array.isArray(model.supported_parameters)) {
		return;
	}
	for (const p of model.supported_parameters) {
		registerParameter(acc, p as FilterableParameter);
	}
}

function registerParameter(
	acc: MetadataAccumulator,
	param: FilterableParameter,
): void {
	if (!acc.parameterCounts.has(param)) {
		return;
	}
	bumpCount(acc.parameterCounts, param);
}

const MODEL_ACCUMULATORS: Array<
	(acc: MetadataAccumulator, model: OpenRouterModel) => void
> = [
	accumulateVariant,
	accumulateEndpoints,
	accumulateMaker,
	accumulateParameters,
];

function accumulateModel(
	acc: MetadataAccumulator,
	model: OpenRouterModel,
): void {
	for (const fn of MODEL_ACCUMULATORS) {
		fn(acc, model);
	}
}

function buildAvailableVariants(
	acc: MetadataAccumulator,
): Array<ModelVariant | "none"> {
	const out: Array<ModelVariant | "none"> = acc.hasNoVariant ? ["none"] : [];
	out.push(...Array.from(acc.variants).sort());
	return out;
}

function compareEndpointEntries(
	a: [string, number],
	b: [string, number],
): number {
	return a[0].localeCompare(b[0]);
}

function buildSortedEndpointProviders(
	acc: MetadataAccumulator,
): [string, number][] {
	return Array.from(acc.endpointProvidersMap.entries()).sort(
		compareEndpointEntries,
	);
}

/**
 * Single-pass aggregation of every count the filters menu needs.
 */
export function computeModelFiltersMetadata(
	models: OpenRouterModel[],
): ModelFiltersMetadata {
	const acc = createAccumulator();
	for (const model of models) {
		accumulateModel(acc, model);
	}
	return {
		availableVariants: buildAvailableVariants(acc),
		variantCounts: acc.variantCounts,
		endpointProviders: buildSortedEndpointProviders(acc),
		providerCounts: acc.providerCounts,
		parameterCounts: acc.parameterCounts,
	};
}
