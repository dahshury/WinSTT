import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commands } from "@/bindings";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import {
	type ModelInfo,
	useCatalogStore,
	useModelStateStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTtsModelStateStore } from "@/entities/tts-catalog";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { revertSurfacesForOfflineProvider } from "./use-cloud-offline-auto-revert";
import { useRevertNoticeStore } from "./revert-notice-store";

const originalSwitchModel = commands.sttSwitchModel;

function model(id: string): ModelInfo {
	return {
		id,
		displayName: id,
		family: "whisper",
		languages: [],
		supportsLanguageDetection: false,
		sizeLabel: "",
		previewCapable: false,
		nativeStreaming: false,
		finalReuseSafe: false,
		onnxModelName: null,
		description: "",
		availableQuantizations: [],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
	} as ModelInfo;
}

function cachedState(id: string) {
	return { [id]: { cache: { state: "cached" } } } as never;
}

function seed(over: Partial<AppSettingsOutput>): void {
	useSettingsStore.setState({
		settings: { ...DEFAULT_SETTINGS, ...over },
		isLoaded: true,
	});
}

beforeEach(() => {
	commands.sttSwitchModel = (async (request) =>
		({
			status: "completed",
			requestId: request.requestId,
		}) as never) satisfies typeof commands.sttSwitchModel;
	useCatalogStore.setState({ models: [model("tiny")], isLoaded: true });
	useModelStateStore.setState({ statesById: {} });
	useTtsModelStateStore.setState({ statesById: {} });
	useLlmCatalogStore.setState({ models: [], isReachable: false });
	useRevertNoticeStore.setState({ notices: [] });
	useModelSwapStore.getState().clear("main");
});

afterEach(() => {
	commands.sttSwitchModel = originalSwitchModel;
});

describe("revertSurfacesForOfflineProvider — STT", () => {
	test("reverts a cloud STT model to local when a local model is cached", () => {
		useModelStateStore.setState({ statesById: cachedState("tiny") });
		seed({ model: { ...DEFAULT_SETTINGS.model, model: "openrouter:whisper" } });

		revertSurfacesForOfflineProvider("openrouter");

		expect(useModelSwapStore.getState().activeMain).toBe("tiny");
		expect(useSettingsStore.getState().settings.model.model).toBe(
			"openrouter:whisper",
		);
		expect(useRevertNoticeStore.getState().notices.length).toBeGreaterThan(0);
	});

	test("leaves the cloud STT model in place when NO local model is cached", () => {
		useModelStateStore.setState({ statesById: {} });
		seed({ model: { ...DEFAULT_SETTINGS.model, model: "openrouter:whisper" } });

		revertSurfacesForOfflineProvider("openrouter");

		expect(useSettingsStore.getState().settings.model.model).toBe(
			"openrouter:whisper",
		);
		expect(useRevertNoticeStore.getState().notices.length).toBe(0);
	});

	test("ignores an offline provider that does not back the STT model", () => {
		useModelStateStore.setState({ statesById: cachedState("tiny") });
		seed({ model: { ...DEFAULT_SETTINGS.model, model: "openrouter:whisper" } });

		// ElevenLabs is offline, but STT runs on OpenRouter → no STT revert.
		revertSurfacesForOfflineProvider("elevenlabs");

		expect(useSettingsStore.getState().settings.model.model).toBe(
			"openrouter:whisper",
		);
	});
});

describe("revertSurfacesForOfflineProvider — LLM", () => {
	test("switches OpenRouter dictation to an installed Ollama model", () => {
		useLlmCatalogStore.setState({
			models: [{ name: "llama3" }] as never,
			isReachable: true,
		});
		seed({
			llm: {
				...DEFAULT_SETTINGS.llm,
				dictation: {
					...DEFAULT_SETTINGS.llm.dictation,
					provider: "openrouter",
				},
			},
		});

		revertSurfacesForOfflineProvider("openrouter");

		const dictation = useSettingsStore.getState().settings.llm.dictation;
		expect(dictation.provider).toBe("ollama");
		expect(dictation.model).toBe("llama3");
	});

	test("leaves OpenRouter dictation in place when no Ollama model is installed", () => {
		useLlmCatalogStore.setState({ models: [], isReachable: true });
		seed({
			llm: {
				...DEFAULT_SETTINGS.llm,
				dictation: {
					...DEFAULT_SETTINGS.llm.dictation,
					provider: "openrouter",
				},
			},
		});

		revertSurfacesForOfflineProvider("openrouter");

		expect(useSettingsStore.getState().settings.llm.dictation.provider).toBe(
			"openrouter",
		);
	});
});
