import { describe, expect, test } from "bun:test";
import type { OpenRouterTtsModel } from "@/shared/api/models";
import { resolveOpenRouterTtsFallback } from "./cloud-tts-picker";

function model(id: string, voices: string[]): OpenRouterTtsModel {
	return { id, supported_voices: voices } as OpenRouterTtsModel;
}

describe("OpenRouter TTS fallback", () => {
	test("keeps a valid persisted model and voice", () => {
		expect(
			resolveOpenRouterTtsFallback(
				[model("a", ["alloy", "nova"])],
				"a",
				"nova",
			),
		).toEqual({ modelId: "a", voiceId: "nova" });
	});

	test("resolves a stale model and voice to a persistable live pair", () => {
		expect(
			resolveOpenRouterTtsFallback(
				[model("first", ["alloy"]), model("second", ["nova"])],
				"retired",
				"retired-voice",
			),
		).toEqual({ modelId: "first", voiceId: "alloy" });
	});

	test("waits for a non-empty catalog", () => {
		expect(resolveOpenRouterTtsFallback([], "", "")).toBeNull();
	});
});
