export type {
	TtsCloning,
	TtsModelInfo,
	TtsTagSyntax,
} from "./model/tts-catalog-store";
export type { TtsModelStateEntry as TtsModelState } from "@/shared/api/ipc-client";
export {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "./model/tts-catalog-store";
export {
	type TtsSwapTransition,
	useTtsSwapStore,
} from "./model/tts-swap-store";
export {
	buildTtsSearchCorpus,
	cloningLabel,
	formatInlineTagList,
	getEngineConfig,
	getEngineLabel,
	getEngineLogoSrc,
	getEngineMaker,
	groupModelsByEngine,
	inlineTagsLabel,
	ttsLanguageMeta,
	type TtsCapabilityCopy,
	type TtsEngineGroup,
	type TtsEngineKey,
	type TtsListGroup,
	TTS_SORTED_GROUP_VALUE,
	voiceDesignLabel,
	withTtsFavoritesGroup,
} from "./lib/model-presentation";
