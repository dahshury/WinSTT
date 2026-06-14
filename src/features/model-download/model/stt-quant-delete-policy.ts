import {
	resolveEffectiveQuant,
	resolveQuantCache,
} from "@/widgets/model-picker/stt/lib/cache-helpers";
import type { ModelInfo } from "@/entities/model-catalog";
import {
	isSelectableRealtimeModel,
	isVisibleSttModel,
	modelsHaveLanguageOverlap,
} from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import {
	ONNX_QUANTIZATIONS,
	type OnnxQuantization,
} from "@/shared/config/defaults";

type StatesById = Record<string, ModelStateEntry>;

export interface SttSwitchTarget {
	modelId: string;
	quantization?: OnnxQuantization;
}

export interface SttDeleteRecovery {
	canDelete: boolean;
	mainTarget?: SttSwitchTarget | undefined;
	realtimeTarget?: SttSwitchTarget | null | undefined;
}

interface DeletePolicyArgs {
	currentMainModel: string;
	currentQuantization: OnnxQuantization | "auto";
	currentRealtimeModel?: string | undefined;
	mainModelInfo?: ModelInfo | undefined;
	modelId: string;
	models: readonly ModelInfo[];
	previousModelIds?: readonly string[] | undefined;
	quantization: OnnxQuantization;
	statesById: StatesById;
}

interface PickReplacementArgs {
	excludeIds: ReadonlySet<string>;
	filter: (model: ModelInfo) => boolean;
	preferredQuantization: OnnxQuantization | "auto";
	previousModelIds: readonly string[];
	sourceModel: ModelInfo | undefined;
	models: readonly ModelInfo[];
	statesById: StatesById;
}

function isCachedQuant(
	statesById: StatesById,
	modelId: string,
	quantization: OnnxQuantization,
): boolean {
	return (
		resolveQuantCache(statesById[modelId], quantization)?.state === "cached"
	);
}

function cachedQuantizations(entry: ModelStateEntry | undefined): string[] {
	if (!entry) {
		return [];
	}
	const perQuant = Object.entries(entry.cache_by_quantization ?? {})
		.filter(([, cache]) => cache.state === "cached")
		.map(([quantization]) => quantization);
	if (perQuant.length > 0) {
		return perQuant;
	}
	return entry.cache.state === "cached"
		? [entry.effective_quantization ?? ""]
		: [];
}

function toOnnxQuantization(value: string): OnnxQuantization {
	return (ONNX_QUANTIZATIONS as readonly string[]).includes(value)
		? (value as OnnxQuantization)
		: "";
}

function pickCachedQuantForModel(
	entry: ModelStateEntry | undefined,
	preferredQuantization: OnnxQuantization | "auto",
	excludeQuantization?: OnnxQuantization | undefined,
): OnnxQuantization | null {
	const cached = cachedQuantizations(entry).filter(
		(q) => q !== excludeQuantization,
	);
	if (cached.length === 0) {
		return null;
	}
	const effective = entry?.effective_quantization;
	const preferred = [preferredQuantization, effective, "", ...cached].find(
		(q): q is string => q !== undefined && cached.includes(q),
	);
	return preferred === undefined ? null : toOnnxQuantization(preferred);
}

function countCachedVisibleQuants(
	models: readonly ModelInfo[],
	statesById: StatesById,
): number {
	return models
		.filter((model) => model.available !== false && isVisibleSttModel(model))
		.reduce(
			(sum, model) => sum + cachedQuantizations(statesById[model.id]).length,
			0,
		);
}

/** Partial downloads are not installed models, so they stay deletable. */
export function canDeleteSttQuant(
	models: readonly ModelInfo[],
	statesById: StatesById,
	modelId: string,
	quantization: OnnxQuantization,
): boolean {
	if (!isCachedQuant(statesById, modelId, quantization)) {
		return true;
	}
	return countCachedVisibleQuants(models, statesById) > 1;
}

function activeQuantMatchesDeletion(
	args: DeletePolicyArgs,
	activeModel: string,
): boolean {
	if (args.modelId !== activeModel) {
		return false;
	}
	const activeQuant = resolveEffectiveQuant(
		args.statesById[activeModel],
		args.currentQuantization,
	);
	return (
		activeQuant === args.quantization &&
		isCachedQuant(args.statesById, args.modelId, args.quantization)
	);
}

function modelSize(statesById: StatesById, model: ModelInfo): number {
	return statesById[model.id]?.estimated_bytes ?? Number.POSITIVE_INFINITY;
}

function compareBySimilarity(
	sourceModel: ModelInfo | undefined,
	statesById: StatesById,
): (a: { model: ModelInfo }, b: { model: ModelInfo }) => number {
	return (a, b) => {
		const sameFamilyA =
			sourceModel !== undefined && a.model.family === sourceModel.family;
		const sameFamilyB =
			sourceModel !== undefined && b.model.family === sourceModel.family;
		if (sameFamilyA !== sameFamilyB) {
			return sameFamilyA ? -1 : 1;
		}
		const overlapA =
			sourceModel !== undefined &&
			modelsHaveLanguageOverlap(sourceModel, a.model);
		const overlapB =
			sourceModel !== undefined &&
			modelsHaveLanguageOverlap(sourceModel, b.model);
		if (overlapA !== overlapB) {
			return overlapA ? -1 : 1;
		}
		return modelSize(statesById, a.model) - modelSize(statesById, b.model);
	};
}

function targetForModel(
	model: ModelInfo,
	statesById: StatesById,
	preferredQuantization: OnnxQuantization | "auto",
): ({ model: ModelInfo } & SttSwitchTarget) | null {
	const quantization = pickCachedQuantForModel(
		statesById[model.id],
		preferredQuantization,
	);
	return quantization === null
		? null
		: { model, modelId: model.id, quantization };
}

function pickPreviousTarget(
	targets: readonly ({ model: ModelInfo } & SttSwitchTarget)[],
	previousModelIds: readonly string[],
): ({ model: ModelInfo } & SttSwitchTarget) | null {
	for (const id of previousModelIds) {
		const target = targets.find((candidate) => candidate.modelId === id);
		if (target) {
			return target;
		}
	}
	return null;
}

function stripModel(
	target: ({ model: ModelInfo } & SttSwitchTarget) | null,
): SttSwitchTarget | null {
	if (!target) {
		return null;
	}
	return target.quantization === undefined
		? { modelId: target.modelId }
		: { modelId: target.modelId, quantization: target.quantization };
}

function pickReplacement(args: PickReplacementArgs): SttSwitchTarget | null {
	const targets = args.models
		.filter(
			(model) =>
				model.available !== false &&
				isVisibleSttModel(model) &&
				!args.excludeIds.has(model.id) &&
				args.filter(model),
		)
		.map((model) =>
			targetForModel(model, args.statesById, args.preferredQuantization),
		)
		.filter(
			(target): target is { model: ModelInfo } & SttSwitchTarget =>
				target !== null,
		);
	const sorted = targets.toSorted(
		compareBySimilarity(args.sourceModel, args.statesById),
	);
	const similar = sorted.find(
		(target) =>
			args.sourceModel !== undefined &&
			target.model.family === args.sourceModel.family &&
			modelsHaveLanguageOverlap(args.sourceModel, target.model),
	);
	return stripModel(
		similar ??
			pickPreviousTarget(targets, args.previousModelIds) ??
			sorted[0] ??
			null,
	);
}

function sameModelQuantTarget(args: DeletePolicyArgs): SttSwitchTarget | null {
	const model = args.models.find((candidate) => candidate.id === args.modelId);
	if (!model || !isVisibleSttModel(model)) {
		return null;
	}
	const quantization = pickCachedQuantForModel(
		args.statesById[args.modelId],
		args.currentQuantization,
		args.quantization,
	);
	return quantization === null ? null : { modelId: args.modelId, quantization };
}

function resolveMainTarget(
	args: DeletePolicyArgs,
): SttSwitchTarget | undefined {
	if (!activeQuantMatchesDeletion(args, args.currentMainModel)) {
		return undefined;
	}
	const sameModelTarget = sameModelQuantTarget(args);
	if (sameModelTarget) {
		return sameModelTarget;
	}
	return (
		pickReplacement({
			excludeIds: new Set([args.modelId]),
			filter: () => true,
			models: args.models,
			preferredQuantization: args.currentQuantization,
			previousModelIds: args.previousModelIds ?? [],
			sourceModel: args.models.find((model) => model.id === args.modelId),
			statesById: args.statesById,
		}) ?? undefined
	);
}

function isRealtimeCompatible(
	mainModelInfo: ModelInfo | undefined,
	model: ModelInfo,
): boolean {
	return (
		isSelectableRealtimeModel(model) &&
		(mainModelInfo === undefined ||
			modelsHaveLanguageOverlap(mainModelInfo, model))
	);
}

function resolveRealtimeTarget(
	args: DeletePolicyArgs,
	mainTarget: SttSwitchTarget | undefined,
): SttSwitchTarget | null | undefined {
	const currentRealtime = args.currentRealtimeModel ?? "";
	if (!currentRealtime || !activeQuantMatchesDeletion(args, currentRealtime)) {
		return undefined;
	}
	const effectiveMainInfo =
		(mainTarget
			? args.models.find((model) => model.id === mainTarget.modelId)
			: args.mainModelInfo) ?? undefined;
	const currentRealtimeInfo = args.models.find(
		(model) => model.id === currentRealtime,
	);
	const sameModelTarget =
		currentRealtimeInfo &&
		isRealtimeCompatible(effectiveMainInfo, currentRealtimeInfo)
			? sameModelQuantTarget(args)
			: null;
	if (sameModelTarget) {
		return sameModelTarget;
	}
	return pickReplacement({
		excludeIds: new Set([args.modelId]),
		filter: (model) => isRealtimeCompatible(effectiveMainInfo, model),
		models: args.models,
		preferredQuantization: args.currentQuantization,
		previousModelIds: args.previousModelIds ?? [],
		sourceModel: currentRealtimeInfo,
		statesById: args.statesById,
	});
}

export function resolveSttDeleteRecovery(
	args: DeletePolicyArgs,
): SttDeleteRecovery {
	if (
		!canDeleteSttQuant(
			args.models,
			args.statesById,
			args.modelId,
			args.quantization,
		)
	) {
		return { canDelete: false };
	}
	const mainTarget = resolveMainTarget(args);
	const realtimeTarget = resolveRealtimeTarget(args, mainTarget);
	return { canDelete: true, mainTarget, realtimeTarget };
}
