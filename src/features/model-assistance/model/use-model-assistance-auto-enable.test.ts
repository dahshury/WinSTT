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

/** Catalog with a non-cleanup model ("plain-whisper") + the cleanup
 *  "crisper-whisper", so a test can simulate switching from one to the other. */
function seedCatalogWithBothModels(): void {
	useCatalogStore.setState({
		isLoaded: true,
		models: [
			assistanceModel("plain-whisper"),
			assistanceModel("crisper-whisper"),
		],
	});
}

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

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
	test("never auto-enables on mount, even for a cleanup model with dictation off", async () => {
		// The decisive guarantee: mounting / reopening Settings / restarting the
		// app must NEVER turn post-processing back on. Boot state is a cleanup
		// model (crisper-whisper) with dictation OFF; the first effect pass is
		// observe-only.
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));
		await settle();
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});

	test("does not re-enable after a manual disable when the view re-mounts (app restart)", async () => {
		// Disable is already persisted (boot state). Reopening Settings / a restart
		// re-mounts the hook; it must keep dictation OFF.
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true })).unmount();
		seedSettings();
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));
		await settle();
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});

	test("does not re-enable after a toggle-off when the STT catalog loads late", async () => {
		// Catalog object not loaded yet at mount; a toggle-off during that window
		// must not be clobbered once the catalog resolves.
		useCatalogStore.setState({ isLoaded: false, models: [] });
		seedSettings();
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));
		await settle();
		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: false });
		});
		act(() => {
			useCatalogStore.setState({ isLoaded: true, models: [assistanceModel()] });
		});
		await settle();
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});

	test("auto-enables + disables smart endpoint when the user switches to a cleanup model in-session", async () => {
		seedCatalogWithBothModels();
		seedSettings({ selectedModel: "plain-whisper" });
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));
		await settle();
		// Mount on a non-cleanup model does nothing.
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);

		// In-session switch to a model that needs cleanup → the one moment we nudge.
		act(() => {
			seedSettings({ selectedModel: "crisper-whisper" });
		});
		await waitFor(() => {
			const s = useSettingsStore.getState().settings;
			expect(s.llm.dictation.enabled).toBe(true);
			expect(s.quality.smartEndpoint).toBe(false);
		});
	});

	test("opens the Ollama picker on switch when no cleanup model is selected", async () => {
		seedCatalogWithBothModels();
		seedSettings({ selectedModel: "plain-whisper" });
		const onOpenOllamaPicker = mock(() => undefined);
		renderHook(() =>
			useModelAssistanceAutoEnable({ enabled: true, onOpenOllamaPicker }),
		);
		await settle();

		act(() => {
			seedSettings({ selectedModel: "crisper-whisper", dictationModel: "" });
		});
		await waitFor(() => {
			expect(onOpenOllamaPicker).toHaveBeenCalledTimes(1);
		});
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});

	test("does not fight a manual disable after an in-session switch", async () => {
		seedCatalogWithBothModels();
		seedSettings({ selectedModel: "plain-whisper" });
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));
		await settle();
		act(() => {
			seedSettings({ selectedModel: "crisper-whisper" });
		});
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
				true,
			);
		});

		// User turns it back off → must stick (no re-assert without a new switch).
		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: false });
		});
		await settle();
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});

	test("nudges a switched-to cleanup model only once (persisted marker)", async () => {
		seedCatalogWithBothModels();
		seedSettings({ selectedModel: "plain-whisper" });
		renderHook(() => useModelAssistanceAutoEnable({ enabled: true }));
		await settle();
		act(() => {
			seedSettings({ selectedModel: "crisper-whisper" });
		});
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
				true,
			);
		});
		// Disable, switch away, then switch BACK — the already-nudged model is not
		// re-enabled (the persisted marker holds across the round trip).
		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: false });
		});
		act(() => {
			seedSettings({ selectedModel: "plain-whisper" });
		});
		await settle();
		act(() => {
			seedSettings({ selectedModel: "crisper-whisper" });
		});
		await settle();
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});
});
