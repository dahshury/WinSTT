import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../model/catalog-store";
import {
  modelSupportsAnySourceLanguage,
  modelSupportsSelectedSourceLanguages,
  normalizeSttLanguageCode,
  resolveSelectedSourceLanguages,
} from "./source-language-compatibility";

function model(languages: readonly string[]): ModelInfo {
  return {
    id: "model",
    displayName: "Model",
    backend: "onnx_asr",
    family: "whisper",
    languages: [...languages],
    supportsLanguageDetection: true,
    sizeLabel: "",
    previewCapable: true,
    nativeStreaming: false,
    finalReuseSafe: true,
    supportsRealtime: true,
    onnxModelName: null,
    description: "",
    availableQuantizations: [],
    sizeBytesByQuantization: {},
    available: true,
    errorMessage: "",
    localPath: null,
    speedScore: 0.5,
    accuracyScore: 0.5,
  };
}

describe("source language compatibility", () => {
  test("normalizes region and script subtags to catalog language codes", () => {
    expect(normalizeSttLanguageCode("EN-us")).toBe("en");
    expect(normalizeSttLanguageCode("zh_Hans")).toBe("zh");
    expect(normalizeSttLanguageCode("auto")).toBe("");
  });

  test("prefers explicit source-language candidates", () => {
    expect(
      resolveSelectedSourceLanguages(
        {
          autoDetectLanguage: false,
          language: "en",
          languageCandidates: ["de", "fr", "de"],
        },
        model(["en", "de", "fr"]),
      ),
    ).toEqual(["de", "fr"]);
  });

  test("falls back to the pinned source language when auto detect is off", () => {
    expect(
      resolveSelectedSourceLanguages(
        { autoDetectLanguage: false, language: "ru", languageCandidates: [] },
        model(["en", "ru"]),
      ),
    ).toEqual(["ru"]);
  });

  test("uses the main model language set for unconstrained auto detect", () => {
    expect(
      resolveSelectedSourceLanguages(
        { autoDetectLanguage: true, language: "", languageCandidates: [] },
        model(["en", "de"]),
      ),
    ).toEqual(["en", "de"]);
  });

  test("allows realtime when it supports at least one selected language", () => {
    expect(modelSupportsAnySourceLanguage(model(["en"]), ["en", "ru"])).toBe(
      true,
    );
  });

  test("rejects realtime when it supports none of the selected languages", () => {
    expect(
      modelSupportsSelectedSourceLanguages(
        model(["en"]),
        { autoDetectLanguage: false, languageCandidates: ["ru", "de"] },
        model(["en", "ru", "de"]),
      ),
    ).toBe(false);
  });

  test("treats an empty model language list as broad support", () => {
    expect(modelSupportsAnySourceLanguage(model([]), ["ru"])).toBe(true);
  });
});
