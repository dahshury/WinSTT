import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ModelInfo, useCatalogStore } from "@/entities/model-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
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
  useCatalogStore.setState({
    isLoaded: true,
    models: [assistanceModel()],
  });
  seedSettings();
  useLlmModelPickerStore.getState().close();
});

afterEach(() => {
  cleanup();
  useCatalogStore.setState({ isLoaded: false, models: [] });
  useSettingsStore.setState({ isLoaded: true, settings: DEFAULT_SETTINGS });
  useLlmModelPickerStore.getState().close();
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
    renderHook(() => useModelAssistanceAutoEnable(true));

    await waitFor(() => {
      const state = useSettingsStore.getState().settings;
      expect(state.llm.dictation.enabled).toBe(true);
      expect(state.quality.smartEndpoint).toBe(false);
    });
  });

  test("opens the Ollama picker with enable intent when no cleanup model is selected", async () => {
    seedSettings({ dictationModel: "" });

    renderHook(() => useModelAssistanceAutoEnable(true));

    await waitFor(() => {
      const picker = useLlmModelPickerStore.getState();
      expect(picker.open).toBe(true);
      expect(picker.feature).toBe("dictation");
      expect(picker.enableOnInstall).toBe(true);
    });
    expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
      false,
    );
  });

  test("does not fight a manual disable until the selected model changes", async () => {
    renderHook(() => useModelAssistanceAutoEnable(true));

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
});
