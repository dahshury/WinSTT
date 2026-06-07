import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  _resetOptimisticSwapForTests,
  type ModelInfo,
  useCatalogStore,
  useModelStateStore,
  useModelSwapStore,
} from "@/entities/model-catalog";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { useRevertNoticeStore } from "./revert-notice-store";
import { useCloudKeyAutoRevert } from "./use-cloud-key-auto-revert";

// Shrink the revert debounce so the timer fires within waitFor's budget; the
// no-revert assertions wait a few multiples of this to prove nothing fired.
const FAST_DEBOUNCE_MS = 5;

interface Overrides {
  dictationProvider?: "ollama" | "openrouter" | "apple-intelligence";
  elevenlabsKey?: string;
  model?: string;
  openaiKey?: string;
  openrouterKey?: string;
  transformsProvider?: "ollama" | "openrouter" | "apple-intelligence";
  ttsSource?: "local" | "cloud";
}

function buildSettings(over: Overrides): AppSettingsOutput {
  return {
    ...DEFAULT_SETTINGS,
    model: { ...DEFAULT_SETTINGS.model, model: over.model ?? "tiny" },
    integrations: {
      openai: {
        ...DEFAULT_SETTINGS.integrations.openai,
        apiKey: over.openaiKey ?? "",
      },
      elevenlabs: {
        ...DEFAULT_SETTINGS.integrations.elevenlabs,
        apiKey: over.elevenlabsKey ?? "",
      },
    },
    llm: {
      ...DEFAULT_SETTINGS.llm,
      openrouterApiKey: over.openrouterKey ?? "",
      dictation: {
        ...DEFAULT_SETTINGS.llm.dictation,
        provider: over.dictationProvider ?? "ollama",
      },
      transforms: {
        ...DEFAULT_SETTINGS.llm.transforms,
        provider: over.transformsProvider ?? "ollama",
      },
    },
    tts: { ...DEFAULT_SETTINGS.tts, source: over.ttsSource ?? "local" },
  };
}

function seed(over: Overrides): void {
  useSettingsStore.setState({ settings: buildSettings(over), isLoaded: true });
}

function model(id: string, backend = "onnx_asr"): ModelInfo {
  return {
    id,
    displayName: id,
    backend,
    family: "whisper",
    languages: [],
    supportsLanguageDetection: false,
    sizeLabel: "",
    previewCapable: false,
    nativeStreaming: false,
    finalReuseSafe: false,
    supportsRealtime: false,
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

beforeEach(() => {
  // A single local model in the catalog so the STT revert resolves to "tiny".
  useCatalogStore.setState({ models: [model("tiny")], isLoaded: true });
  useModelStateStore.setState({ statesById: {} });
  useRevertNoticeStore.setState({ notices: [] });
  useModelSwapStore.getState().clear("main");
  _resetOptimisticSwapForTests();
  seed({ model: "tiny" });
});

afterEach(() => {
  cleanup();
  useModelSwapStore.getState().clear("main");
  _resetOptimisticSwapForTests();
  useRevertNoticeStore.setState({ notices: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
});

describe("useCloudKeyAutoRevert", () => {
  test("clearing the OpenRouter key flips an OpenRouter LLM feature to Ollama + disabled", async () => {
    seed({ openrouterKey: "sk-or", dictationProvider: "openrouter" });
    renderHook(() => useCloudKeyAutoRevert(FAST_DEBOUNCE_MS));
    act(() => seed({ openrouterKey: "", dictationProvider: "openrouter" }));
    await waitFor(() => {
      const dictation = useSettingsStore.getState().settings.llm.dictation;
      expect(dictation.provider).toBe("ollama");
      expect(dictation.enabled).toBe(false);
    });
    expect(
      useRevertNoticeStore.getState().notices.map((n) => n.provider),
    ).toEqual(["openrouter"]);
  });

  test("does not treat disabled hydration changes as user key removals", async () => {
    seed({ openrouterKey: "sk-or", dictationProvider: "openrouter" });
    const { rerender } = renderHook(
      ({ enabled }) => useCloudKeyAutoRevert(FAST_DEBOUNCE_MS, enabled),
      { initialProps: { enabled: false } },
    );

    act(() => seed({ openrouterKey: "", dictationProvider: "openrouter" }));
    rerender({ enabled: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, FAST_DEBOUNCE_MS * 6));
    });

    expect(useSettingsStore.getState().settings.llm.dictation.provider).toBe(
      "openrouter",
    );
    expect(useRevertNoticeStore.getState().notices).toHaveLength(0);
  });

  test("clearing the OpenAI key while on an OpenAI model swaps STT back to local", async () => {
    seed({ openaiKey: "sk", model: "openai:whisper-1" });
    renderHook(() => useCloudKeyAutoRevert(FAST_DEBOUNCE_MS));
    act(() => seed({ openaiKey: "", model: "openai:whisper-1" }));
    await waitFor(() => {
      expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
    });
    // beginSwap opened the in-flight chip toward the local target.
    expect(useModelSwapStore.getState().activeMain).toBe("tiny");
    expect(
      useRevertNoticeStore.getState().notices.map((n) => n.provider),
    ).toEqual(["openai"]);
  });

  test("clearing the ElevenLabs key while on cloud TTS reverts TTS to local", async () => {
    seed({ elevenlabsKey: "el", ttsSource: "cloud" });
    renderHook(() => useCloudKeyAutoRevert(FAST_DEBOUNCE_MS));
    act(() => seed({ elevenlabsKey: "", ttsSource: "cloud" }));
    await waitFor(() => {
      expect(useSettingsStore.getState().settings.tts.source).toBe("local");
    });
    expect(
      useRevertNoticeStore.getState().notices.map((n) => n.provider),
    ).toEqual(["elevenlabs"]);
  });

  test("clearing a key for an inactive provider does nothing", async () => {
    // OpenAI key present but the active model is local — removing it is a no-op.
    seed({ openaiKey: "sk", model: "tiny" });
    renderHook(() => useCloudKeyAutoRevert(FAST_DEBOUNCE_MS));
    act(() => seed({ openaiKey: "", model: "tiny" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, FAST_DEBOUNCE_MS * 6));
    });
    expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
    expect(useModelSwapStore.getState().activeMain).toBeNull();
    expect(useRevertNoticeStore.getState().notices).toHaveLength(0);
  });

  test("boots a cloud model with no key straight back to local (silent, no toast)", async () => {
    // Imported/persisted broken state: cloud STT model selected but the
    // provider key is absent. No clear transition ever happens, so the
    // steady-state safety net must repair it on mount.
    seed({ openaiKey: "", model: "openai:whisper-1" });
    renderHook(() => useCloudKeyAutoRevert(FAST_DEBOUNCE_MS));
    await waitFor(() => {
      expect(useSettingsStore.getState().settings.model.model).toBe("tiny");
    });
    expect(useModelSwapStore.getState().activeMain).toBe("tiny");
    // Silent repair — the user didn't just remove a key, so no toast.
    expect(useRevertNoticeStore.getState().notices).toHaveLength(0);
  });

  test("a cloud model WITH its key present at boot is left untouched", async () => {
    seed({ openaiKey: "sk", model: "openai:whisper-1" });
    renderHook(() => useCloudKeyAutoRevert(FAST_DEBOUNCE_MS));
    await act(async () => {
      await new Promise((r) => setTimeout(r, FAST_DEBOUNCE_MS * 6));
    });
    expect(useSettingsStore.getState().settings.model.model).toBe(
      "openai:whisper-1",
    );
    expect(useModelSwapStore.getState().activeMain).toBeNull();
    expect(useRevertNoticeStore.getState().notices).toHaveLength(0);
  });

  test("a whitespace-only previous key is not treated as a removal", async () => {
    seed({ openrouterKey: "   ", dictationProvider: "openrouter" });
    renderHook(() => useCloudKeyAutoRevert(FAST_DEBOUNCE_MS));
    act(() => seed({ openrouterKey: "", dictationProvider: "openrouter" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, FAST_DEBOUNCE_MS * 6));
    });
    expect(useSettingsStore.getState().settings.llm.dictation.provider).toBe(
      "openrouter",
    );
    expect(useRevertNoticeStore.getState().notices).toHaveLength(0);
  });
});
