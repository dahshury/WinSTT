import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../model/catalog-store";
import {
  getModelAssistance,
  modelNeedsDictationCleanup,
} from "./model-assistance";

const baseModel: ModelInfo = {
  id: "large-v3",
  displayName: "Whisper Large v3",
  family: "whisper",
  backend: "onnx_asr",
  languages: ["en"],
  supportsLanguageDetection: true,
  sizeLabel: "1.5B",
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

function model(overrides: Partial<ModelInfo>): ModelInfo {
  return { ...baseModel, ...overrides };
}

describe("model assistance policy", () => {
  test("does not add help for dictation-ready Whisper and Granite rows", () => {
    expect(getModelAssistance(baseModel)).toEqual([]);
    expect(getModelAssistance(model({ family: "granite" }))).toEqual([]);
  });

  test("uses verbatim cleanup for CrisperWhisper", () => {
    expect(getModelAssistance(model({ id: "crisper-whisper" }))).toEqual([
      { kind: "dictationCleanup", reason: "verbatim" },
    ]);
  });

  test("uses streaming cleanup for native streaming or streaming-id rows", () => {
    expect(
      getModelAssistance(model({ id: "nemo-live", nativeStreaming: true })),
    ).toEqual([{ kind: "dictationCleanup", reason: "streaming" }]);
    expect(getModelAssistance(model({ id: "streaming-zipformer-en" }))).toEqual(
      [{ kind: "dictationCleanup", reason: "streaming" }],
    );
  });

  test("classifies CTC and transducer/RNN-T rows before broad family fallbacks", () => {
    expect(getModelAssistance(model({ id: "dolphin-base-ctc" }))).toEqual([
      { kind: "dictationCleanup", reason: "ctc" },
    ]);
    expect(
      getModelAssistance(model({ id: "nemo-fastconformer-ru-rnnt" })),
    ).toEqual([{ kind: "dictationCleanup", reason: "transducer" }]);
  });

  test("uses raw cleanup for families that usually emit recognizer text, not prose", () => {
    for (const family of [
      "dolphin",
      "gigaam",
      "kaldi",
      "moonshine",
      "sense_voice",
      "t-one",
    ] as const) {
      expect(modelNeedsDictationCleanup(model({ family }))).toBe(true);
    }
  });
});
