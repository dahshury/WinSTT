import { providerOf } from "@/entities/cloud-stt-provider";
import {
	isSelectableRealtimeModel,
	modelSupportsSelectedSourceLanguages,
	type ModelInfo,
	type ModelStatesById as StatesById,
	modelsHaveLanguageOverlap,
	pickCachedSttModel,
	pickDefaultSttModel,
	type SourceLanguageSelection,
} from "@/entities/model-catalog";
import type { LiveTranscriptionDisplay } from "@/shared/lib/realtime-enabled";

export interface RealtimePreviewFallbackArgs {
	catalogLoaded: boolean;
	catalogModels: readonly ModelInfo[];
	currentMainModel: string | undefined;
	currentRealtimeModel: string | undefined;
	sourceLanguageSelection?: SourceLanguageSelection;
	realtimeEnabled: boolean;
	statesById: StatesById;
	statesLoaded: boolean;
}

export interface RealtimePreviewFallbackPatch {
	realtimeModel: string;
}

export interface RealtimeLanguageGuardArgs extends RealtimePreviewFallbackArgs {
	liveTranscriptionDisplay: LiveTranscriptionDisplay;
	wordByWordPasting: boolean;
}

export interface RealtimeLanguageGuardPatch {
	liveTranscriptionDisplay?: "none";
	wordByWordPasting?: false;
}

function resolveEffectiveMainModel(
	currentMainModel: string | undefined,
	catalogModels: readonly ModelInfo[],
	statesById: StatesById,
): ModelInfo | null {
	if (providerOf(currentMainModel ?? "") !== null) {
		return null;
	}
	const current = catalogModels.find((m) => m.id === currentMainModel);
	if (current) {
		return current;
	}
	const fallbackId = pickDefaultSttModel(catalogModels, statesById);
	return catalogModels.find((m) => m.id === fallbackId) ?? null;
}

function compatibleRealtimeModels(
	effectiveMain: ModelInfo | null,
	catalogModels: readonly ModelInfo[],
	sourceLanguageSelection: SourceLanguageSelection | undefined,
): readonly ModelInfo[] {
	return catalogModels.filter(
		(m) =>
			isSelectableRealtimeModel(m) &&
			(effectiveMain === null
				? modelSupportsSelectedSourceLanguages(
						m,
						sourceLanguageSelection,
						effectiveMain,
					)
				: modelsHaveLanguageOverlap(effectiveMain, m) &&
					modelSupportsSelectedSourceLanguages(
						m,
						sourceLanguageSelection,
						effectiveMain,
					)),
	);
}

function isCached(
	model: ModelInfo | undefined,
	statesById: StatesById,
): boolean {
	return model !== undefined && statesById[model.id]?.cache.state === "cached";
}

function hasCachedCompatibleRealtime(
	args: RealtimePreviewFallbackArgs,
): boolean {
	if (
		!args.catalogLoaded ||
		!args.statesLoaded ||
		args.catalogModels.length === 0
	) {
		return true;
	}
	const effectiveMain = resolveEffectiveMainModel(
		args.currentMainModel,
		args.catalogModels,
		args.statesById,
	);
	if (
		effectiveMain !== null &&
		isSelectableRealtimeModel(effectiveMain) &&
		modelSupportsSelectedSourceLanguages(
			effectiveMain,
			args.sourceLanguageSelection,
			effectiveMain,
		) &&
		isCached(effectiveMain, args.statesById)
	) {
		return true;
	}
	const compatibleRealtime = compatibleRealtimeModels(
		effectiveMain,
		args.catalogModels,
		args.sourceLanguageSelection,
	);
	const currentRealtime = compatibleRealtime.find(
		(m) => m.id === args.currentRealtimeModel,
	);
	return (
		isCached(currentRealtime, args.statesById) ||
		pickCachedSttModel(compatibleRealtime, args.statesById) !== null
	);
}

/**
 * Keep the realtime slot honest when live preview is enabled.
 *
 * A separate realtime model is optional in the Rust port, but it must still
 * match the selected source languages. This resolver keeps the realtime slot
 * on a cached compatible native-streaming model when one exists; the separate
 * language guard decides whether realtime display settings can remain enabled.
 */
export function resolveRealtimePreviewFallbackPatch(
	args: RealtimePreviewFallbackArgs,
): RealtimePreviewFallbackPatch | null {
	if (
		!args.realtimeEnabled ||
		!args.catalogLoaded ||
		!args.statesLoaded ||
		args.catalogModels.length === 0
	) {
		return null;
	}
	const effectiveMain = resolveEffectiveMainModel(
		args.currentMainModel,
		args.catalogModels,
		args.statesById,
	);
	const compatibleRealtime = compatibleRealtimeModels(
		effectiveMain,
		args.catalogModels,
		args.sourceLanguageSelection,
	);
	if (
		effectiveMain !== null &&
		isSelectableRealtimeModel(effectiveMain) &&
		modelSupportsSelectedSourceLanguages(
			effectiveMain,
			args.sourceLanguageSelection,
			effectiveMain,
		) &&
		isCached(effectiveMain, args.statesById)
	) {
		return effectiveMain.id === args.currentRealtimeModel
			? null
			: { realtimeModel: effectiveMain.id };
	}
	const currentRealtime = compatibleRealtime.find(
		(m) => m.id === args.currentRealtimeModel,
	);
	if (isCached(currentRealtime, args.statesById)) {
		return null;
	}
	const next = pickCachedSttModel(compatibleRealtime, args.statesById);
	if (next) {
		return next === args.currentRealtimeModel ? null : { realtimeModel: next };
	}
	return args.currentRealtimeModel ? { realtimeModel: "" } : null;
}

export function resolveRealtimeLanguageGuardPatch(
	args: RealtimeLanguageGuardArgs,
): RealtimeLanguageGuardPatch | null {
	if (!args.realtimeEnabled || hasCachedCompatibleRealtime(args)) {
		return null;
	}

	const patch: RealtimeLanguageGuardPatch = {};
	if (args.liveTranscriptionDisplay !== "none") {
		patch.liveTranscriptionDisplay = "none";
	}
	if (args.wordByWordPasting) {
		patch.wordByWordPasting = false;
	}
	return Object.keys(patch).length === 0 ? null : patch;
}
