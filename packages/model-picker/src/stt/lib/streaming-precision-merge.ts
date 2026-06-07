import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelCacheInfo, ModelStateEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";

export type QuantizationModelIds = Partial<Record<OnnxQuantization, string>>;

export type PrecisionRoutedSttModel = ModelInfo & {
	quantizationModelIds?: QuantizationModelIds;
};

interface MergeBucket {
	index: number;
	model: PrecisionRoutedSttModel;
}

const STREAMING_PRECISION_ROW_RE =
	/^(streaming-(?:nemo-(?:ctc|rnnt)-en-\d+ms|parakeet-unified-en-\d+ms|nemotron-en-\d+ms))(?:-int8)?$/;

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
	for (const quant of [...a, ...b]) {
		if ((quant === "" || quant === "int8") && !out.includes(quant)) {
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

export function backingModelIdForQuant(
	model: PrecisionRoutedSttModel,
	quantization: OnnxQuantization,
): string {
	return model.quantizationModelIds?.[quantization] ?? model.id;
}

export function isSelectedSttModel(
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
