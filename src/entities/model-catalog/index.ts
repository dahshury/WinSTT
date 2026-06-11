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
