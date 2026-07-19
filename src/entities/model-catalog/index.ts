import type { useCatalogStore } from "./model/catalog-store";
import type { useModelStateStore } from "./model/model-state-store";

export {
	readLastLocalSttModelHistory,
	recordLastLocalSttModel,
	resolveLocalDefault,
} from "./lib/last-local-model";
export {
	getModelAssistance,
	type ModelAssistance,
	type ModelAssistanceKind,
	type ModelAssistanceReason,
} from "./lib/model-assistance";
export {
	getModelNativeFormatting,
	type ModelNativeFormatting,
	type ModelNativeFormattingKey,
} from "./lib/model-formatting";
export {
	buildModelSearchCorpus,
	getAuthorLabel,
	getFamilyConfig,
	type FamilyKey,
} from "./lib/family-metadata";
export { variantDisplayName } from "./lib/family-display-name";
export { resolveEffectiveQuant, resolveQuantCache } from "./lib/quant-cache";
export {
	isSelectableRealtimeModel,
	isVisibleSttModel,
	modelsHaveLanguageOverlap,
	needsModelFallback,
	DEFAULT_STT_MODEL_ID,
	pickCachedSttModel,
	pickDefaultSttModel,
	supportsTranslateToEnglish,
} from "./lib/model-options";
export {
	modelSupportsSelectedSourceLanguages,
	normalizeSttLanguageCode,
	resolveSelectedSourceLanguages,
	type SourceLanguageSelection,
} from "./lib/source-language-compatibility";
export type { ModelInfo } from "./model/catalog-store";
export { initCatalogStore, useCatalogStore } from "./model/catalog-store";
export { useModelStateStore } from "./model/model-state-store";
export {
	type SwapQuant,
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
