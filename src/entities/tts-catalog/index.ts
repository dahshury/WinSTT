export type { TtsCloning, TtsModelInfo } from "./model/tts-catalog-store";
export type { TtsModelStateEntry as TtsModelState } from "@/shared/api/ipc-client";
export {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "./model/tts-catalog-store";
