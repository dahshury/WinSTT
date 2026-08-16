import { describe, expect, test } from "bun:test";
import {
	type AssignmentContext,
	collapseToSharedLocalModel,
	effectiveLocalModel,
	featurePatchFromConfiguration,
	resolveLocalModel,
	sharedLocalModelPatch,
} from "./configuration-assignment";
import type { LlmConfiguration } from "./configuration-types";

function config(patch: Partial<LlmConfiguration> = {}): LlmConfiguration {
	return {
		customModifiers: [],
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
		...patch,
	};
}

function context(patch: Partial<AssignmentContext> = {}): AssignmentContext {
	return {
		allowMultipleLocalModels: false,
		localModel: "shared:8b",
		openrouterApiKey: "",
		...patch,
	};
}

describe("resolveLocalModel", () => {
	test("a local configuration is pinned to the shared model", () => {
		// The whole point: several local models would fight over VRAM, and Ollama
		// resolves that fight by silently evicting and reloading.
		expect(resolveLocalModel(config({ model: "own:70b" }), context())).toBe(
			"shared:8b",
		);
	});

	test("the power toggle lets a configuration keep its own local model", () => {
		expect(
			resolveLocalModel(
				config({ model: "own:70b" }),
				context({ allowMultipleLocalModels: true }),
			),
		).toBe("own:70b");
	});

	test("an EMPTY shared model never wipes a configured one", () => {
		// The regression: `localModel` is blank on an upgraded install, and
		// resolving to it blanked a working model — the picker then showed
		// "Select a model" for a setup that was running fine.
		expect(
			resolveLocalModel(
				config({ model: "qwen3:4b" }),
				context({ localModel: "" }),
			),
		).toBe("qwen3:4b");
		expect(
			resolveLocalModel(
				config({ model: "qwen3:4b" }),
				context({ localModel: "   " }),
			),
		).toBe("qwen3:4b");
	});

	test("a cloud configuration is never touched by the shared local model", () => {
		expect(
			resolveLocalModel(
				config({ provider: "openrouter", model: "" }),
				context(),
			),
		).toBe("");
	});

	test("Apple Intelligence has no model id and is left alone", () => {
		expect(
			resolveLocalModel(
				config({ provider: "apple-intelligence", model: "" }),
				context(),
			),
		).toBe("");
	});
});

describe("effectiveLocalModel (upgrade path)", () => {
	function llm(patch: Record<string, unknown> = {}) {
		const feature = (over: Record<string, unknown> = {}) => ({
			provider: "ollama",
			model: "",
			enabled: false,
			...over,
		});
		return {
			allowMultipleLocalModels: false,
			localModel: "",
			openrouterApiKey: "",
			dictation: feature(),
			transforms: feature(),
			readAloud: feature(),
			...patch,
		} as unknown as Parameters<typeof effectiveLocalModel>[0];
	}

	test("adopts the model an older settings file already had", () => {
		// `llm.localModel` is NEWER than the per-feature fields, so every install
		// that predates it is blank here while dictation still names the model the
		// user has been running. Showing them an empty picker would be asking them
		// to choose a model they already chose.
		expect(
			effectiveLocalModel(
				llm({ dictation: { provider: "ollama", model: "qwen3:4b" } }),
			),
		).toBe("qwen3:4b");
	});

	test("prefers an explicit shared model over a feature's", () => {
		expect(
			effectiveLocalModel(
				llm({
					localModel: "chosen:8b",
					dictation: { provider: "ollama", model: "old:4b" },
				}),
			),
		).toBe("chosen:8b");
	});

	test("falls back past a cloud feature to a local one", () => {
		expect(
			effectiveLocalModel(
				llm({
					dictation: { provider: "openrouter", model: "" },
					transforms: { provider: "ollama", model: "local:4b" },
				}),
			),
		).toBe("local:4b");
	});

	test("is empty only when nothing local is configured anywhere", () => {
		expect(effectiveLocalModel(llm())).toBe("");
	});
});

describe("featurePatchFromConfiguration", () => {
	test("carries the configuration's stack and records which one it came from", () => {
		const patch = featurePatchFromConfiguration(
			config({ presets: [{ key: "formal" }] }),
			"cfg-1",
			context(),
		);
		expect(patch.configurationId).toBe("cfg-1");
		expect(patch.presets).toEqual([{ key: "formal" }]);
		expect(patch.model).toBe("shared:8b");
	});

	test("never carries `enabled` — assignment must not start or stop a feature", () => {
		const patch = featurePatchFromConfiguration(
			config({ enabled: true }),
			"cfg-1",
			context(),
		);
		expect(patch).not.toHaveProperty("enabled");
	});

	test("a keyless cloud configuration degrades to local and picks up the shared model", () => {
		// Saved while a key was installed, applied after it was removed: it must not
		// strand the feature on a provider that cannot run.
		const patch = featurePatchFromConfiguration(
			config({ provider: "openrouter", openrouterModel: "x/y", model: "" }),
			"cfg-1",
			context({ openrouterApiKey: "" }),
		);
		expect(patch.provider).toBe("ollama");
		expect(patch.model).toBe("shared:8b");
		// The cloud target survives, so re-adding the key and re-assigning restores it.
		expect(patch.openrouterModel).toBe("x/y");
	});

	test("a cloud configuration WITH a key keeps its own cloud model", () => {
		const patch = featurePatchFromConfiguration(
			config({ provider: "openrouter", openrouterModel: "x/y" }),
			"cfg-1",
			context({ openrouterApiKey: "sk-test" }),
		);
		expect(patch.provider).toBe("openrouter");
		expect(patch.openrouterModel).toBe("x/y");
	});

	test("does not alias the stored configuration's arrays", () => {
		// Editing a feature's modifiers must never reach back into the saved config.
		const source = config({
			customModifiers: [
				{
					id: "m",
					name: "n",
					prompt: "p",
					enabled: true,
					levelsEnabled: false,
				},
			],
		});
		const patch = featurePatchFromConfiguration(source, "cfg-1", context());
		expect(patch.customModifiers[0]).not.toBe(source.customModifiers[0]);
	});
});

describe("sharedLocalModelPatch", () => {
	test("moves a local feature onto the new shared model", () => {
		expect(
			sharedLocalModelPatch({ provider: "ollama", model: "old:8b" }, "new:8b", {
				allowMultipleLocalModels: false,
			}),
		).toEqual({ model: "new:8b" });
	});

	test("is a no-op when the feature already runs it", () => {
		expect(
			sharedLocalModelPatch({ provider: "ollama", model: "new:8b" }, "new:8b", {
				allowMultipleLocalModels: false,
			}),
		).toBeNull();
	});

	test("leaves cloud features alone", () => {
		expect(
			sharedLocalModelPatch({ provider: "openrouter", model: "" }, "new:8b", {
				allowMultipleLocalModels: false,
			}),
		).toBeNull();
	});

	test("leaves every feature alone while the power toggle is on", () => {
		expect(
			sharedLocalModelPatch(
				{ provider: "ollama", model: "own:70b" },
				"new:8b",
				{
					allowMultipleLocalModels: true,
				},
			),
		).toBeNull();
	});
});

describe("collapseToSharedLocalModel", () => {
	test("keeps the current shared model when an enabled feature already runs it", () => {
		expect(
			collapseToSharedLocalModel(
				[
					{ enabled: true, provider: "ollama", model: "shared:8b" },
					{ enabled: true, provider: "ollama", model: "other:70b" },
				],
				"shared:8b",
			),
		).toBe("shared:8b");
	});

	test("adopts an enabled feature's model rather than forcing a fresh load", () => {
		// Turning the toggle OFF asks for FEWER models — collapsing onto one that is
		// already resident is the cheap answer.
		expect(
			collapseToSharedLocalModel(
				[{ enabled: true, provider: "ollama", model: "other:70b" }],
				"shared:8b",
			),
		).toBe("other:70b");
	});

	test("ignores disabled and cloud features", () => {
		expect(
			collapseToSharedLocalModel(
				[
					{ enabled: false, provider: "ollama", model: "disabled:70b" },
					{ enabled: true, provider: "openrouter", model: "" },
				],
				"shared:8b",
			),
		).toBe("shared:8b");
	});

	test("falls back to the current value when nothing local is enabled", () => {
		expect(collapseToSharedLocalModel([], "shared:8b")).toBe("shared:8b");
	});
});
