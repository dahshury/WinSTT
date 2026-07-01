import type { useCatalogStore } from "./model/catalog-store";
import type { useModelStateStore } from "./model/model-state-store";

export {
	readLastLocalSttModelHistory,
	recordLastLocalSttModel,
	resolveLocalDefault,
} from "./lib/last-local-model";
export {
	getModelAssistance,
	modelNeedsDictationCleanup,
	type ModelAssistance,
	type ModelAssistanceKind,
	type ModelAssistanceReason,
} from "./lib/model-assistance";
export { modelHasNativeBasicFormatting } from "./lib/model-formatting";
export { resolveEffectiveQuant, resolveQuantCache } from "./lib/quant-cache";
export {
	isSelectableRealtimeModel,
	isVisibleSttModel,
	modelsHaveLanguageOverlap,
	needsModelFallback,
	pickCachedSttModel,
	pickDefaultSttModel,
	supportsTranslateToEnglish,
} from "./lib/model-options";
export {
	modelSupportsSelectedSourceLanguages,
	type SourceLanguageSelection,
} from "./lib/source-language-compatibility";
export type { ModelInfo } from "./model/catalog-store";
export { useCatalogStore } from "./model/catalog-store";
export { useModelStateStore } from "./model/model-state-store";
export {
	_resetOptimisticSwapForTests,
	useModelSwapStore,
} from "./model/model-swap-store";

export type CatalogModels = ReturnType<
	typeof useCatalogStore.getState
>["models"];
export type ModelStatesById = ReturnType<
	typeof useModelStateStore.getState
>["statesById"];
export type ModelSystemInfo = ReturnType<
	typeof useModelStateStore.getState
>["systemInfo"];
