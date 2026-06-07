import { describe, expect, test } from "bun:test";
import type { BuiltinPresetEntry, CustomModifier } from "@/entities/llm-catalog";
import {
	type LlmConfiguration,
	matchConfigurationId,
	type SavedConfiguration,
} from "./configurations";

// A full configuration body. The matcher only inspects presets + customModifiers,
// so the provider/model half is filler — varying it must NOT change a match.
function body(overrides: Partial<LlmConfiguration> = {}): LlmConfiguration {
	return {
		enabled: false,
		maxOutputTokens: null,
		model: "",
		openrouterFallbackModel: "",
		openrouterModel: "",
		presets: [{ key: "neutral" }],
		provider: "ollama",
		reasoningEffort: "medium",
		thinkingEffort: "off",
		verbosity: "medium",
		customModifiers: [],
		...overrides,
	};
}

function saved(id: string, overrides: Partial<LlmConfiguration> = {}): SavedConfiguration {
	return { id, name: id, config: body(overrides) };
}

const presets = (entries: BuiltinPresetEntry[]) => entries;
const mod = (overrides: Partial<CustomModifier>): CustomModifier => ({
	id: "m1",
	name: "M",
	prompt: "do a thing",
	enabled: true,
	levelsEnabled: false,
	...overrides,
});

describe("matchConfigurationId", () => {
	test("returns '' when there are no saved configurations", () => {
		expect(matchConfigurationId({ presets: [{ key: "formal" }], customModifiers: [] }, [])).toBe("");
	});

	test("matches a configuration with identical tone + modifiers", () => {
		const configs = [
			saved("a", { presets: presets([{ key: "formal" }, { key: "summarize", level: "high" }]) }),
		];
		expect(
			matchConfigurationId(
				{ presets: [{ key: "formal" }, { key: "summarize", level: "high" }], customModifiers: [] },
				configs
			)
		).toBe("a");
	});

	test("ignores the provider/model half when matching", () => {
		// Same tone + modifiers, wildly different provider/model — still a match,
		// because the tone row only applies (and so only compares) tone + modifiers.
		const configs = [
			saved("a", {
				presets: presets([{ key: "technical" }]),
				provider: "openrouter",
				model: "some-model",
				openrouterModel: "anthropic/claude",
			}),
		];
		expect(
			matchConfigurationId({ presets: [{ key: "technical" }], customModifiers: [] }, configs)
		).toBe("a");
	});

	test("distinguishes configurations by modifier level", () => {
		const configs = [
			saved("light", { presets: presets([{ key: "summarize", level: "light" }]) }),
			saved("high", { presets: presets([{ key: "summarize", level: "high" }]) }),
		];
		expect(
			matchConfigurationId(
				{ presets: [{ key: "summarize", level: "high" }], customModifiers: [] },
				configs
			)
		).toBe("high");
	});

	test("distinguishes configurations by translate target language", () => {
		const configs = [
			saved("es", { presets: presets([{ key: "translate", targetLang: "Spanish" }]) }),
			saved("fr", { presets: presets([{ key: "translate", targetLang: "French" }]) }),
		];
		expect(
			matchConfigurationId(
				{ presets: [{ key: "translate", targetLang: "French" }], customModifiers: [] },
				configs
			)
		).toBe("fr");
	});

	test("matches custom modifiers including their enabled flag and prompt", () => {
		const configs = [saved("a", { customModifiers: [mod({ enabled: true })] })];
		// Same modifier but disabled — must NOT match.
		expect(
			matchConfigurationId({ presets: [{ key: "neutral" }], customModifiers: [mod({ enabled: false })] }, configs)
		).toBe("");
		// Exact same modifier — matches.
		expect(
			matchConfigurationId({ presets: [{ key: "neutral" }], customModifiers: [mod({ enabled: true })] }, configs)
		).toBe("a");
	});

	test("returns '' once the live carrier diverges from every saved configuration", () => {
		const configs = [saved("a", { presets: presets([{ key: "formal" }]) })];
		expect(
			matchConfigurationId({ presets: [{ key: "friendly" }], customModifiers: [] }, configs)
		).toBe("");
	});
});
