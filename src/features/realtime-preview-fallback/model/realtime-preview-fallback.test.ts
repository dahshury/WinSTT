import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import { resolveRealtimePreviewFallbackPatch } from "./realtime-preview-fallback";

function model(
  overrides: Partial<ModelInfo> & Pick<ModelInfo, "id">,
): ModelInfo {
  return {
    id: overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    backend: overrides.backend ?? "onnx_asr",
    family: overrides.family ?? "whisper",
    languages: overrides.languages ?? [],
    supportsLanguageDetection: false,
    sizeLabel: "",
    previewCapable: overrides.previewCapable ?? true,
    nativeStreaming: overrides.nativeStreaming ?? false,
    finalReuseSafe: overrides.finalReuseSafe ?? true,
    supportsRealtime: overrides.supportsRealtime ?? true,
    onnxModelName: null,
    description: "",
    availableQuantizations: [],
    sizeBytesByQuantization: {},
    available: true,
    errorMessage: "",
    localPath: null,
    speedScore: 0.5,
    accuracyScore: 0.5,
    ...overrides,
  };
}

function stateEntry(estimatedBytes: number, cached: boolean): ModelStateEntry {
  return {
    cache: {
      state: cached ? "cached" : "not_cached",
      progress: cached ? 1 : 0,
    },
    estimated_bytes: estimatedBytes,
    comfortable_on_cpu: true,
    comfortable_on_gpu: true,
  } as unknown as ModelStateEntry;
}

describe("resolveRealtimePreviewFallbackPatch", () => {
  const catalog = [
    model({ id: "main-en", languages: ["en"], nativeStreaming: false }),
    model({ id: "rt-en-small", languages: ["en"], nativeStreaming: true }),
    model({ id: "rt-en-large", languages: ["en"], nativeStreaming: true }),
    model({ id: "rt-ru", languages: ["ru"], nativeStreaming: true }),
  ];

  test("clears a valid realtime model when it is not cached", () => {
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: catalog,
        currentMainModel: "main-en",
        currentRealtimeModel: "rt-en-small",
        realtimeEnabled: true,
        statesById: {
          "main-en": stateEntry(300, true),
          "rt-en-small": stateEntry(50, false),
          "rt-en-large": stateEntry(100, false),
          "rt-ru": stateEntry(40, true),
        },
        statesLoaded: true,
      }),
    ).toEqual({ realtimeModel: "" });
  });

  test("selects the smallest cached compatible native-streaming model", () => {
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: catalog,
        currentMainModel: "main-en",
        currentRealtimeModel: "deleted",
        realtimeEnabled: true,
        statesById: {
          "main-en": stateEntry(300, true),
          "rt-en-small": stateEntry(50, false),
          "rt-en-large": stateEntry(100, true),
          "rt-ru": stateEntry(40, true),
        },
        statesLoaded: true,
      }),
    ).toEqual({ realtimeModel: "rt-en-large" });
  });

  test("selects a cached compatible realtime model when realtime was enabled with no saved realtime id", () => {
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: catalog,
        currentMainModel: "main-en",
        currentRealtimeModel: "",
        realtimeEnabled: true,
        statesById: {
          "main-en": stateEntry(300, true),
          "rt-en-small": stateEntry(50, true),
          "rt-en-large": stateEntry(100, true),
          "rt-ru": stateEntry(40, true),
        },
        statesLoaded: true,
      }),
    ).toEqual({ realtimeModel: "rt-en-small" });
  });

  test("keeps realtime blank when no compatible native-streaming model is cached", () => {
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: catalog,
        currentMainModel: "main-en",
        currentRealtimeModel: "",
        realtimeEnabled: true,
        statesById: {
          "main-en": stateEntry(300, true),
          "rt-en-small": stateEntry(50, false),
          "rt-en-large": stateEntry(100, false),
          "rt-ru": stateEntry(40, true),
        },
        statesLoaded: true,
      }),
    ).toBeNull();
  });

  test("leaves a cached compatible realtime model alone", () => {
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: catalog,
        currentMainModel: "main-en",
        currentRealtimeModel: "rt-en-large",
        realtimeEnabled: true,
        statesById: {
          "main-en": stateEntry(300, true),
          "rt-en-small": stateEntry(50, false),
          "rt-en-large": stateEntry(100, true),
          "rt-ru": stateEntry(40, true),
        },
        statesLoaded: true,
      }),
    ).toBeNull();
  });

  test("uses the cached native-streaming main model instead of a separate realtime model", () => {
    const models = [
      model({
        id: "streaming-zipformer-en",
        languages: ["en"],
        nativeStreaming: true,
      }),
      model({ id: "rt-en-large", languages: ["en"], nativeStreaming: true }),
    ];
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: models,
        currentMainModel: "streaming-zipformer-en",
        currentRealtimeModel: "rt-en-large",
        realtimeEnabled: true,
        statesById: {
          "streaming-zipformer-en": stateEntry(300, true),
          "rt-en-large": stateEntry(100, true),
        },
        statesLoaded: true,
      }),
    ).toEqual({ realtimeModel: "streaming-zipformer-en" });
  });

  test("migrates a cached non-canonical streaming export to the canonical realtime row", () => {
    const models = [
      model({ id: "main-en", languages: ["en"], nativeStreaming: false }),
      model({
        id: "streaming-parakeet-unified-en-1120ms-int8",
        languages: ["en"],
        nativeStreaming: true,
      }),
      model({
        id: "streaming-parakeet-unified-en-240ms-int8",
        languages: ["en"],
        nativeStreaming: true,
      }),
    ];
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: models,
        currentMainModel: "main-en",
        currentRealtimeModel: "streaming-parakeet-unified-en-240ms-int8",
        realtimeEnabled: true,
        statesById: {
          "main-en": stateEntry(300, true),
          "streaming-parakeet-unified-en-1120ms-int8": stateEntry(100, true),
          "streaming-parakeet-unified-en-240ms-int8": stateEntry(50, true),
        },
        statesLoaded: true,
      }),
    ).toEqual({ realtimeModel: "streaming-parakeet-unified-en-1120ms-int8" });
  });

  test("does nothing until cache state is loaded", () => {
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: catalog,
        currentMainModel: "main-en",
        currentRealtimeModel: "rt-en-small",
        realtimeEnabled: true,
        statesById: {},
        statesLoaded: false,
      }),
    ).toBeNull();
  });

  test("does nothing while realtime display is disabled", () => {
    expect(
      resolveRealtimePreviewFallbackPatch({
        catalogLoaded: true,
        catalogModels: catalog,
        currentMainModel: "main-en",
        currentRealtimeModel: "rt-en-small",
        realtimeEnabled: false,
        statesById: {
          "main-en": stateEntry(300, true),
          "rt-en-small": stateEntry(50, false),
        },
        statesLoaded: true,
      }),
    ).toBeNull();
  });
});
