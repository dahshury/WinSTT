import { describe, expect, test } from "bun:test";
import {
	isPostProcessingReady,
	type PostProcessingGateSettings,
} from "./post-processing-gate";

type Dictation = PostProcessingGateSettings["dictation"];

function dictation(overrides: Partial<Dictation> = {}): Dictation {
	return {
		enabled: true,
		provider: "ollama",
		model: "",
		openrouterModel: "",
		...overrides,
	} as Dictation;
}

function gate(
	overrides: Partial<PostProcessingGateSettings> = {},
): PostProcessingGateSettings {
	return {
		dictation: dictation(),
		openrouterApiKey: "",
		...overrides,
	} as PostProcessingGateSettings;
}

describe("isPostProcessingReady", () => {
	test("false when the settings tree isn't hydrated yet", () => {
		expect(isPostProcessingReady(undefined)).toBe(false);
	});

	test("false while the dictation feature itself is off, even with a model", () => {
		expect(
			isPostProcessingReady(
				gate({ dictation: dictation({ enabled: false, model: "qwen3:4b" }) }),
			),
		).toBe(false);
	});

	test("ollama is ready once a model is picked", () => {
		expect(isPostProcessingReady(gate())).toBe(false);
		expect(
			isPostProcessingReady(
				gate({ dictation: dictation({ model: "qwen3:4b" }) }),
			),
		).toBe(true);
	});

	test("apple intelligence is ready without a model id", () => {
		const base = dictation({ provider: "apple-intelligence" });
		expect(isPostProcessingReady(gate({ dictation: base }))).toBe(true);
	});

	test("openrouter needs BOTH a key and a model — a key alone is not ready", () => {
		const openrouter = dictation({ provider: "openrouter" });
		expect(
			isPostProcessingReady(
				gate({ dictation: openrouter, openrouterApiKey: "sk-or-v1-x" }),
			),
		).toBe(false);
		expect(
			isPostProcessingReady(
				gate({
					dictation: { ...openrouter, openrouterModel: "anthropic/claude" },
					openrouterApiKey: "   ",
				}),
			),
		).toBe(false);
		expect(
			isPostProcessingReady(
				gate({
					dictation: { ...openrouter, openrouterModel: "anthropic/claude" },
					openrouterApiKey: "sk-or-v1-x",
				}),
			),
		).toBe(true);
	});

	test("openrouter ignores the plain ollama `model` field", () => {
		expect(
			isPostProcessingReady(
				gate({
					dictation: dictation({ provider: "openrouter", model: "qwen3:4b" }),
					openrouterApiKey: "sk-or-v1-x",
				}),
			),
		).toBe(false);
	});

	test("whitespace-only values never count as configured", () => {
		expect(
			isPostProcessingReady(gate({ dictation: dictation({ model: "   " }) })),
		).toBe(false);
	});
});
