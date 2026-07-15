export type { TtsCloning, TtsModelInfo } from "./model/tts-catalog-store";
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
	getEngineConfig,
	getEngineLabel,
	getEngineLogoSrc,
	getEngineMaker,
	groupModelsByEngine,
	ttsLanguageMeta,
	type TtsEngineGroup,
	type TtsEngineKey,
	type TtsListGroup,
	TTS_SORTED_GROUP_VALUE,
	voiceDesignLabel,
	withTtsFavoritesGroup,
} from "./lib/model-presentation";
