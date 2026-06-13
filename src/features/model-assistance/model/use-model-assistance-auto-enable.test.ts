import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ModelInfo, useCatalogStore } from "@/entities/model-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useModelAssistanceStore } from "./model-assistance-store";
import {
	type DictationCleanupAutoInputs,
	resolveDictationCleanupAutoAction,
	useModelAssistanceAutoEnable,
} from "./use-model-assistance-auto-enable";

const base: DictationCleanupAutoInputs = {
	dictationEnabled: false,
	needsCleanup: true,
	ollamaModel: "llama3.2:3b",
	openrouterApiKey: "",
	provider: "ollama",
	wordByWordPasting: false,
};

function assistanceModel(id = "crisper-whisper"): ModelInfo {
	return {
		id,
		displayName: "CrisperWhisper",
		backend: "onnx_asr",
		family: "whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "809M",
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: false,
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
	};
}

function seedSettings({
	dictationModel = "llama3.2:3b",
	selectedModel = "crisper-whisper",
}: {
	dictationModel?: string;
	selectedModel?: string;
} = {}): void {
	useSettingsStore.setState({
		isLoaded: true,
		settings: {
			...DEFAULT_SETTINGS,
			general: {
				...DEFAULT_SETTINGS.general,
				wordByWordPasting: false,
			},
			model: {
				...DEFAULT_SETTINGS.model,
				backend: "onnx_asr",
				model: selectedModel,
			},
			quality: {
				...DEFAULT_SETTINGS.quality,
				smartEndpoint: true,
			},
			llm: {
				...DEFAULT_SETTINGS.llm,
				dictation: {
					...DEFAULT_SETTINGS.llm.dictation,
					enabled: false,
					model: dictationModel,
					provider: "ollama",
				},
			},
		},
	});
}

beforeEach(() => {
	// The auto-applied marker persists across mounts (that's the whole point),
	// so it must be cleared between tests for isolation.
	useModelAssistanceStore.getState().reset();
	useCatalogStore.setState({
		isLoaded: true,
		models: [assistanceModel()],
	});
	seedSettings();
});

afterEach(() => {
	cleanup();
	useModelAssistanceStore.getState().reset();
	useCatalogStore.setState({ isLoaded: false, models: [] });
	useSettingsStore.setState({ isLoaded: true, settings: DEFAULT_SETTINGS });
});

describe("resolveDictationCleanupAutoAction", () => {
	test("does nothing when the selected model needs no assistance", () => {
		expect(
			resolveDictationCleanupAutoAction({ ...base, needsCleanup: false }),
		).toBe("none");
	});

	test("does not fight an already-enabled or word-by-word configuration", () => {
		expect(
			resolveDictationCleanupAutoAction({ ...base, dictationEnabled: true }),
		).toBe("none");
		expect(
			resolveDictationCleanupAutoAction({ ...base, wordByWordPasting: true }),
		).toBe("none");
	});

	test("enables Ollama cleanup when a model is already selected", () => {
		expect(resolveDictationCleanupAutoAction(base)).toBe("enable");
	});

	test("opens the Ollama picker when cleanup is needed but no model is selected", () => {
		expect(
			resolveDictationCleanupAutoAction({ ...base, ollamaModel: "" }),
		).toBe("openOllamaPicker");
	});

	test("requires an OpenRouter API key before enabling cloud cleanup", () => {
		expect(
			resolveDictationCleanupAutoAction({
				...base,
				ollamaModel: "",
				provider: "openrouter",
			}),
		).toBe("none");
		expect(
			resolveDictationCleanupAutoAction({
				...base,
				ollamaModel: "",
				openrouterApiKey: "sk-or-v1-test",
				provider: "openrouter",
			}),
		).toBe("enable");
	});
});

describe("useModelAssistanceAutoEnable", () => {
	test("enables dictation cleanup and disables smart endpoint for a selected model that needs help", async () => {
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));

		await waitFor(() => {
			const state = useSettingsStore.getState().settings;
			expect(state.llm.dictation.enabled).toBe(true);
			expect(state.quality.smartEndpoint).toBe(false);
		});
	});

	test("opens the Ollama picker with enable intent when no cleanup model is selected", async () => {
		seedSettings({ dictationModel: "" });
		const onOpenOllamaPicker = mock(() => undefined);

		renderHook(() =>
			useModelAssistanceAutoEnable({
				enabled: true,
				onOpenOllamaPicker,
			}),
		);

		await waitFor(() => {
			expect(onOpenOllamaPicker).toHaveBeenCalledTimes(1);
		});
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});

	test("does not fight a manual disable until the selected model changes", async () => {
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));

		await waitFor(() => {
			expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
				true,
			);
		});

		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: false });
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});

	test("does not re-enable after a manual disable when the view re-mounts (app restart)", async () => {
		const first = renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));

		await waitFor(() => {
			expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
				true,
			);
		});

		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: false });
		});
		first.unmount();

		// Re-mount with the SAME selected model — simulating reopening Settings
		// or restarting the app. The old in-memory guard reset here and silently
		// re-enabled cleanup; the persisted marker must keep it off.
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});

	test("auto-enables again when the user switches to a different cleanup model", async () => {
		const first = renderHook(() =>
			useModelAssistanceAutoEnable({ enabled: true }),
		);
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
				true,
			);
		});
		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: false });
		});
		first.unmount();

		// A genuinely new model the user just picked is still worth nudging for.
		// (`ctc` in the id flags it as needing dictation cleanup.)
		useCatalogStore.setState({
			isLoaded: true,
			models: [
				assistanceModel("crisper-whisper"),
				assistanceModel("parakeet-ctc-other"),
			],
		});
		seedSettings({ selectedModel: "parakeet-ctc-other" });

		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
				true,
			);
		});
	});
});
