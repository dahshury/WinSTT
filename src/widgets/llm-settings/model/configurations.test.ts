import { describe, expect, test } from "bun:test";
import type {
	BuiltinPresetEntry,
	CustomModifier,
} from "@/entities/llm-catalog";
import {
	type LlmConfiguration,
	matchConfigurationId,
	matchFullConfigurationId,
	matchPostProcessingProfileId,
	mergeSavedConfigurations,
	postProcessingPatchFromConfiguration,
	reorderSavedConfigurations,
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

function saved(
	id: string,
	overrides: Partial<LlmConfiguration> = {},
): SavedConfiguration {
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
		expect(
			matchConfigurationId(
				{ presets: [{ key: "formal" }], customModifiers: [] },
				[],
			),
		).toBe("");
	});

	test("matches a configuration with identical tone + modifiers", () => {
		const configs = [
			saved("a", {
				presets: presets([
					{ key: "formal" },
					{ key: "summarize", level: "high" },
				]),
			}),
		];
		expect(
			matchConfigurationId(
				{
					presets: [{ key: "formal" }, { key: "summarize", level: "high" }],
					customModifiers: [],
				},
				configs,
			),
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
			matchConfigurationId(
				{ presets: [{ key: "technical" }], customModifiers: [] },
				configs,
			),
		).toBe("a");
	});

	test("distinguishes configurations by modifier level", () => {
		const configs = [
			saved("light", {
				presets: presets([{ key: "summarize", level: "light" }]),
			}),
			saved("high", {
				presets: presets([{ key: "summarize", level: "high" }]),
			}),
		];
		expect(
			matchConfigurationId(
				{ presets: [{ key: "summarize", level: "high" }], customModifiers: [] },
				configs,
			),
		).toBe("high");
	});

	test("distinguishes configurations by translate target language", () => {
		const configs = [
			saved("es", {
				presets: presets([{ key: "translate", targetLang: "Spanish" }]),
			}),
			saved("fr", {
				presets: presets([{ key: "translate", targetLang: "French" }]),
			}),
		];
		expect(
			matchConfigurationId(
				{
					presets: [{ key: "translate", targetLang: "French" }],
					customModifiers: [],
				},
				configs,
			),
		).toBe("fr");
	});

	test("matches custom modifiers including their enabled flag and prompt", () => {
		const configs = [saved("a", { customModifiers: [mod({ enabled: true })] })];
		// Same modifier but disabled — must NOT match.
		expect(
			matchConfigurationId(
				{
					presets: [{ key: "neutral" }],
					customModifiers: [mod({ enabled: false })],
				},
				configs,
			),
		).toBe("");
		// Exact same modifier — matches.
		expect(
			matchConfigurationId(
				{
					presets: [{ key: "neutral" }],
					customModifiers: [mod({ enabled: true })],
				},
				configs,
			),
		).toBe("a");
	});

	test("returns '' once the live carrier diverges from every saved configuration", () => {
		const configs = [saved("a", { presets: presets([{ key: "formal" }]) })];
		expect(
			matchConfigurationId(
				{ presets: [{ key: "friendly" }], customModifiers: [] },
				configs,
			),
		).toBe("");
	});
});

describe("matchFullConfigurationId", () => {
	test("compares provider/model fields as part of the saved profile", () => {
		const configs = [
			saved("local", {
				presets: presets([{ key: "technical" }]),
				provider: "ollama",
				model: "llama3",
			}),
			saved("cloud", {
				presets: presets([{ key: "technical" }]),
				provider: "openrouter",
				openrouterModel: "anthropic/claude",
			}),
		];

		expect(
			matchFullConfigurationId(
				body({
					presets: presets([{ key: "technical" }]),
					provider: "openrouter",
					openrouterModel: "anthropic/claude",
				}),
				configs,
			),
		).toBe("cloud");
		expect(
			matchFullConfigurationId(
				body({
					presets: presets([{ key: "technical" }]),
					provider: "openrouter",
					openrouterModel: "other/model",
				}),
				configs,
			),
		).toBe("");
	});

	test("ignores enabled so the profile picker does not control the toggle", () => {
		const configs = [saved("a", { enabled: false, model: "llama3" })];
		expect(
			matchFullConfigurationId(
				body({ enabled: true, model: "llama3" }),
				configs,
			),
		).toBe("a");
	});
});

describe("matchPostProcessingProfileId", () => {
	test("prefers exact full-profile matches", () => {
		const configs = [
			saved("legacy", {
				presets: presets([{ key: "technical" }]),
				provider: "ollama",
				model: "llama3",
			}),
			saved("exact", {
				presets: presets([{ key: "technical" }]),
				provider: "openrouter",
				openrouterModel: "anthropic/claude",
			}),
		];

		expect(
			matchPostProcessingProfileId(
				body({
					presets: presets([{ key: "technical" }]),
					provider: "openrouter",
					openrouterModel: "anthropic/claude",
				}),
				configs,
			),
		).toBe("exact");
	});

	test("falls back to old tone and modifier matching", () => {
		const configs = [
			saved("legacy", {
				presets: presets([{ key: "technical" }]),
				provider: "ollama",
				model: "llama3",
			}),
		];

		expect(
			matchPostProcessingProfileId(
				body({
					presets: presets([{ key: "technical" }]),
					provider: "openrouter",
					openrouterModel: "anthropic/claude",
				}),
				configs,
			),
		).toBe("legacy");
	});
});

describe("mergeSavedConfigurations", () => {
	test("preserves the current order and appends legacy-only presets", () => {
		expect(
			mergeSavedConfigurations(
				[saved("current"), saved("shared")],
				[saved("legacy"), saved("shared")],
			).map((config) => config.id),
		).toEqual(["current", "shared", "legacy"]);
	});
});

describe("reorderSavedConfigurations", () => {
	test("moves an item before the drop target", () => {
		expect(
			reorderSavedConfigurations(
				[saved("a"), saved("b"), saved("c")],
				"c",
				"a",
				"before",
			).map((config) => config.id),
		).toEqual(["c", "a", "b"]);
	});

	test("moves an item after the drop target", () => {
		expect(
			reorderSavedConfigurations(
				[saved("a"), saved("b"), saved("c")],
				"a",
				"c",
				"after",
			).map((config) => config.id),
		).toEqual(["b", "c", "a"]);
	});

	test("leaves order unchanged for missing ids", () => {
		expect(
			reorderSavedConfigurations(
				[saved("a"), saved("b")],
				"missing",
				"b",
				"before",
			).map((config) => config.id),
		).toEqual(["a", "b"]);
	});
});

describe("postProcessingPatchFromConfiguration", () => {
	test("clones arrays and leaves enabled out of the applied profile patch", () => {
		const source = body({
			enabled: false,
			model: "llama3",
			presets: presets([{ key: "formal" }]),
			customModifiers: [mod({ id: "m2" })],
		});

		const patch = postProcessingPatchFromConfiguration(source);

		expect("enabled" in patch).toBe(false);
		expect(patch.model).toBe("llama3");
		expect(patch.presets).toEqual([{ key: "formal" }]);
		expect(patch.customModifiers).toEqual([mod({ id: "m2" })]);
		expect(patch.presets).not.toBe(source.presets);
		expect(patch.customModifiers).not.toBe(source.customModifiers);
	});
});
