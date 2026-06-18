import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelCacheInfo, ModelStateEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";

export type QuantizationModelIds = Partial<Record<OnnxQuantization, string>>;

export interface StreamingLatencyVariant {
	latencyMs: number;
	model: PrecisionRoutedSttModel;
}

export type PrecisionRoutedSttModel = ModelInfo & {
	quantizationModelIds?: QuantizationModelIds;
	latencyVariants?: StreamingLatencyVariant[];
};

interface MergeBucket {
	index: number;
	model: PrecisionRoutedSttModel;
}

const STREAMING_PRECISION_ROW_RE =
	/^(streaming-(?:nemo-(?:ctc|rnnt)-en-\d+ms|parakeet-unified-en-\d+ms|nemotron-en-\d+ms))(?:-int8)?$/;
const STREAMING_LATENCY_GROUP_RE =
	/^(streaming-(?:nemo-(?:ctc|rnnt)-en|parakeet-unified-en|nemotron-en))(?:-\d+ms)?(?:-int8)?$/;
const STREAMING_LATENCY_SOURCE_RE = /(?:^|[-_])(\d+)ms(?:[-_]|$)/i;

export function nativeStreamingLatencyMs(
	model: Pick<ModelInfo, "id" | "onnxModelName">,
): number | null {
	for (const source of [model.id, model.onnxModelName ?? ""]) {
		const match = source.match(STREAMING_LATENCY_SOURCE_RE);
		const rawMs = match?.[1];
		if (rawMs !== undefined) {
			const ms = Number.parseInt(rawMs, 10);
			if (Number.isFinite(ms) && ms > 0) {
				return ms;
			}
		}
	}
	return null;
}

function streamingPrecisionKey(model: ModelInfo): string | null {
	if (!model.nativeStreaming) {
		return null;
	}
	if (model.id === "streaming-nemo-ctc-en") {
		return "streaming-nemo-ctc-en-80ms";
	}
	if (model.id === "streaming-nemo-rnnt-en") {
		return "streaming-nemo-rnnt-en-480ms";
	}
	return model.id.match(STREAMING_PRECISION_ROW_RE)?.[1] ?? null;
}

function streamingLatencyKey(model: ModelInfo): string | null {
	if (!model.nativeStreaming) {
		return null;
	}
	return model.id.match(STREAMING_LATENCY_GROUP_RE)?.[1] ?? null;
}

function singlePublishedQuant(model: ModelInfo): OnnxQuantization | null {
	if (model.availableQuantizations.length !== 1) {
		return null;
	}
	const [quant] = model.availableQuantizations;
	return quant === "" || quant === "int8" ? quant : null;
}

function uniqueQuantizations(
	a: readonly string[],
	b: readonly string[],
): OnnxQuantization[] {
	const out: OnnxQuantization[] = [];
	const seen = new Set<OnnxQuantization>();
	for (const quant of [...a, ...b]) {
		if ((quant === "" || quant === "int8") && !seen.has(quant)) {
			seen.add(quant);
			out.push(quant);
		}
	}
	return out;
}

function mergeModel(
	current: PrecisionRoutedSttModel,
	incoming: ModelInfo,
	incomingQuant: OnnxQuantization,
): PrecisionRoutedSttModel {
	const currentRoutes = current.quantizationModelIds ?? {};
	const displayBase = incomingQuant === "" ? incoming : current;
	return {
		...displayBase,
		availableQuantizations: uniqueQuantizations(
			current.availableQuantizations,
			incoming.availableQuantizations,
		),
		quantizationModelIds: {
			...currentRoutes,
			[incomingQuant]: incoming.id,
		},
		sizeBytesByQuantization: {
			...current.sizeBytesByQuantization,
			...incoming.sizeBytesByQuantization,
		},
	};
}

function withoutLatencyVariants(
	model: PrecisionRoutedSttModel,
): PrecisionRoutedSttModel {
	const { latencyVariants: _latencyVariants, ...rest } = model;
	return rest;
}

function latencyVariantForModel(
	model: PrecisionRoutedSttModel,
): StreamingLatencyVariant | null {
	const latencyMs = nativeStreamingLatencyMs(model);
	if (latencyMs === null) {
		return null;
	}
	return { latencyMs, model: withoutLatencyVariants(model) };
}

function uniqueLatencyVariants(
	variants: readonly StreamingLatencyVariant[],
): StreamingLatencyVariant[] {
	const byKey = new Map<string, StreamingLatencyVariant>();
	for (const variant of variants) {
		byKey.set(`${variant.latencyMs}:${variant.model.id}`, variant);
	}
	return [...byKey.values()].toSorted((a, b) => a.latencyMs - b.latencyMs);
}

function defaultLatencyVariant(
	variants: readonly StreamingLatencyVariant[],
): StreamingLatencyVariant | null {
	if (variants.length === 0) {
		return null;
	}
	return variants.reduce((best, candidate) =>
		candidate.latencyMs > best.latencyMs ? candidate : best,
	);
}

function variantListForModel(
	model: PrecisionRoutedSttModel,
): StreamingLatencyVariant[] {
	if (model.latencyVariants && model.latencyVariants.length > 0) {
		return model.latencyVariants;
	}
	const variant = latencyVariantForModel(model);
	return variant === null ? [] : [variant];
}

function mergeLatencyModel(
	current: PrecisionRoutedSttModel,
	incoming: PrecisionRoutedSttModel,
): PrecisionRoutedSttModel {
	const variants = uniqueLatencyVariants([
		...variantListForModel(current),
		...(latencyVariantForModel(incoming)
			? [latencyVariantForModel(incoming) as StreamingLatencyVariant]
			: []),
	]);
	const primary = defaultLatencyVariant(variants)?.model ?? incoming;
	return {
		...primary,
		latencyVariants: variants,
	};
}

export function mergeStreamingPrecisionModels(
	models: readonly ModelInfo[],
): PrecisionRoutedSttModel[] {
	const out: PrecisionRoutedSttModel[] = [];
	const buckets = new Map<string, MergeBucket>();
	for (const model of models) {
		const key = streamingPrecisionKey(model);
		const quant = singlePublishedQuant(model);
		if (key === null || quant === null) {
			out.push(model);
			continue;
		}
		const existing = buckets.get(key);
		if (!existing) {
			const routed: PrecisionRoutedSttModel = {
				...model,
				quantizationModelIds: { [quant]: model.id },
			};
			buckets.set(key, { index: out.length, model: routed });
			out.push(routed);
			continue;
		}
		const merged = mergeModel(existing.model, model, quant);
		existing.model = merged;
		out[existing.index] = merged;
	}
	return out;
}

export function mergeStreamingLatencyModels(
	models: readonly PrecisionRoutedSttModel[],
): PrecisionRoutedSttModel[] {
	const out: PrecisionRoutedSttModel[] = [];
	const buckets = new Map<string, MergeBucket>();
	for (const model of models) {
		const key = streamingLatencyKey(model);
		const latencyMs = nativeStreamingLatencyMs(model);
		if (key === null || latencyMs === null) {
			out.push(model);
			continue;
		}
		const existing = buckets.get(key);
		if (!existing) {
			const routed: PrecisionRoutedSttModel = {
				...model,
				latencyVariants: [{ latencyMs, model: withoutLatencyVariants(model) }],
			};
			buckets.set(key, { index: out.length, model: routed });
			out.push(routed);
			continue;
		}
		const merged = mergeLatencyModel(existing.model, model);
		existing.model = merged;
		out[existing.index] = merged;
	}
	return out;
}

function modelMatchesBackingId(
	model: PrecisionRoutedSttModel,
	selectedId: string | undefined,
): boolean {
	if (!selectedId) {
		return false;
	}
	return (
		model.id === selectedId ||
		Object.values(model.quantizationModelIds ?? {}).includes(selectedId)
	);
}

export function latencyVariantsForModel(
	model: PrecisionRoutedSttModel,
): readonly StreamingLatencyVariant[] {
	return variantListForModel(model);
}

export function activeLatencyModel(
	model: PrecisionRoutedSttModel,
	selectedId?: string,
): PrecisionRoutedSttModel {
	for (const variant of variantListForModel(model)) {
		if (modelMatchesBackingId(variant.model, selectedId)) {
			return variant.model;
		}
	}
	return defaultLatencyVariant(variantListForModel(model))?.model ?? model;
}

export function backingModelIdForQuant(
	model: PrecisionRoutedSttModel,
	quantization: OnnxQuantization,
	selectedId?: string,
): string {
	const activeModel = activeLatencyModel(model, selectedId);
	return activeModel.quantizationModelIds?.[quantization] ?? activeModel.id;
}

export function isSelectedSttModel(
	model: PrecisionRoutedSttModel,
	selectedId: string | undefined,
): boolean {
	if (modelMatchesBackingId(model, selectedId)) {
		return true;
	}
	return variantListForModel(model).some((variant) =>
		modelMatchesBackingId(variant.model, selectedId),
	);
}

export function findDisplayModelByBackingId(
	models: readonly PrecisionRoutedSttModel[],
	modelId: string,
): PrecisionRoutedSttModel | null {
	return models.find((model) => isSelectedSttModel(model, modelId)) ?? null;
}

function cacheForQuant(
	statesById: Record<string, ModelStateEntry>,
	modelId: string,
	quantization: OnnxQuantization,
): ModelCacheInfo | undefined {
	const state = statesById[modelId];
	return state?.cache_by_quantization?.[quantization] ?? state?.cache;
}

function firstExistingState(
	statesById: Record<string, ModelStateEntry>,
	model: PrecisionRoutedSttModel,
): ModelStateEntry | undefined {
	if (statesById[model.id]) {
		return statesById[model.id];
	}
	for (const modelId of Object.values(model.quantizationModelIds ?? {})) {
		if (modelId && statesById[modelId]) {
			return statesById[modelId];
		}
	}
	return undefined;
}

function firstCachedQuant(
	byQuant: Record<string, ModelCacheInfo>,
	quants: readonly string[],
): string | null {
	return (
		quants.find((quant) => byQuant[quant]?.state === "cached") ??
		quants.find((quant) => byQuant[quant]?.state === "partial") ??
		null
	);
}

function firstAvailableCache(
	byQuant: Record<string, ModelCacheInfo>,
	quants: readonly string[],
): ModelCacheInfo | undefined {
	const quant = firstCachedQuant(byQuant, quants);
	return quant === null ? undefined : byQuant[quant];
}

function mergeStateForModel(
	statesById: Record<string, ModelStateEntry>,
	model: PrecisionRoutedSttModel,
): ModelStateEntry | undefined {
	if (!model.quantizationModelIds) {
		return statesById[model.id];
	}
	const base = firstExistingState(statesById, model);
	if (!base) {
		return undefined;
	}
	const cacheByQuantization: Record<string, ModelCacheInfo> = {};
	for (const quantization of model.availableQuantizations) {
		const modelId = backingModelIdForQuant(
			model,
			quantization as OnnxQuantization,
		);
		const cache = cacheForQuant(
			statesById,
			modelId,
			quantization as OnnxQuantization,
		);
		if (cache) {
			cacheByQuantization[quantization] = cache;
		}
	}
	const baseEffective = base.effective_quantization;
	const preferredQuant: string =
		typeof baseEffective === "string" &&
		model.availableQuantizations.includes(baseEffective)
			? baseEffective
			: (firstCachedQuant(cacheByQuantization, model.availableQuantizations) ??
				model.availableQuantizations[0] ??
				"");
	return {
		...base,
		id: model.id,
		available_quantizations: model.availableQuantizations,
		cache_by_quantization: cacheByQuantization,
		effective_quantization: preferredQuant,
		cache:
			cacheByQuantization[preferredQuant] ??
			firstAvailableCache(cacheByQuantization, model.availableQuantizations) ??
			base.cache,
	};
}

export function mergeStreamingPrecisionStates(
	models: readonly PrecisionRoutedSttModel[],
	statesById: Record<string, ModelStateEntry>,
): Record<string, ModelStateEntry> {
	const out = { ...statesById };
	for (const model of models) {
		const merged = mergeStateForModel(statesById, model);
		if (merged) {
			out[model.id] = merged;
		}
	}
	return out;
}

function stateRank(state: ModelStateEntry | undefined): number {
	if (state?.cache.state === "cached") {
		return 2;
	}
	if (state?.cache.state === "partial") {
		return 1;
	}
	return 0;
}

export function mergeStreamingLatencyStates(
	models: readonly PrecisionRoutedSttModel[],
	statesById: Record<string, ModelStateEntry>,
): Record<string, ModelStateEntry> {
	const out = { ...statesById };
	for (const model of models) {
		const variants = variantListForModel(model);
		if (variants.length <= 1) {
			continue;
		}
		const defaultModel = activeLatencyModel(model);
		const defaultState = statesById[defaultModel.id];
		const bestState = variants
			.map((variant) => statesById[variant.model.id])
			.reduce<
				ModelStateEntry | undefined
			>((best, state) => (stateRank(state) > stateRank(best) ? state : best), defaultState);
		if (!defaultState && !bestState) {
			continue;
		}
		out[model.id] = {
			...(defaultState ?? bestState),
			cache: bestState?.cache ?? defaultState?.cache,
			id: model.id,
		} as ModelStateEntry;
	}
	return out;
}
