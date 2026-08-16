import { describe, expect, test } from "bun:test";
import type {
	BuiltinPresetEntry,
	CustomModifier,
} from "@/entities/llm-catalog";
import { useSettingsStore } from "@/entities/setting";
import { SECRET_CLEAR_SENTINEL } from "@/shared/config/settings-schema";
import { configSnapshotFromSavedConfiguration } from "./app-profile-rules";
import {
	BUILTIN_CONFIGURATIONS,
	configurationsEqual,
	type LlmConfiguration,
	matchConfigurationId,
	matchFullConfigurationId,
	matchPostProcessingProfileId,
	mergeSavedConfigurations,
	parseSavedConfigurations,
	postProcessingPatchFromConfiguration,
	reorderSavedConfigurations,
	type SavedConfiguration,
	seedBuiltinConfigurations,
	syncConfigurationsFromStorage,
	useLlmConfigurationsStore,
	withAvailableLlmProvider,
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

describe("configurationsEqual", () => {
	test("true for two structurally identical configurations", () => {
		expect(
			configurationsEqual(
				body({ model: "llama3", presets: presets([{ key: "formal" }]) }),
				body({ model: "llama3", presets: presets([{ key: "formal" }]) }),
			),
		).toBe(true);
	});

	test("ignores enabled — the toggle owns on/off, not profile content", () => {
		expect(
			configurationsEqual(body({ enabled: true }), body({ enabled: false })),
		).toBe(true);
	});

	test("distinguishes the provider/model half (drives the dirty state)", () => {
		expect(
			configurationsEqual(
				body({ provider: "ollama" }),
				body({ provider: "openrouter" }),
			),
		).toBe(false);
		expect(
			configurationsEqual(body({ model: "a" }), body({ model: "b" })),
		).toBe(false);
	});

	test("distinguishes tone + modifiers", () => {
		expect(
			configurationsEqual(
				body({ presets: presets([{ key: "formal" }]) }),
				body({ presets: presets([{ key: "friendly" }]) }),
			),
		).toBe(false);
		expect(
			configurationsEqual(
				body({ customModifiers: [mod({ id: "m1", enabled: true })] }),
				body({ customModifiers: [mod({ id: "m1", enabled: false })] }),
			),
		).toBe(false);
	});
});

describe("order-insensitive matching (#27)", () => {
	// Toggling a modifier off then on reorders the stored presets/customModifiers
	// arrays but is a no-net-change, so equality/matching must compare them as
	// sets — otherwise the reorder would falsely read as "modified".
	test("configurationsEqual ignores preset + modifier array order", () => {
		const a = body({
			presets: presets([
				{ key: "formal" },
				{ key: "summarize", level: "high" },
				{ key: "reorder" },
			]),
			customModifiers: [mod({ id: "m1" }), mod({ id: "m2" })],
		});
		const b = body({
			presets: presets([
				{ key: "reorder" },
				{ key: "summarize", level: "high" },
				{ key: "formal" },
			]),
			customModifiers: [mod({ id: "m2" }), mod({ id: "m1" })],
		});
		expect(configurationsEqual(a, b)).toBe(true);
	});

	test("matchConfigurationId matches a reordered but equivalent carrier", () => {
		const configs = [
			saved("a", {
				presets: presets([{ key: "formal" }, { key: "reorder" }]),
			}),
		];
		expect(
			matchConfigurationId(
				{
					presets: [{ key: "reorder" }, { key: "formal" }],
					customModifiers: [],
				},
				configs,
			),
		).toBe("a");
	});
});

describe("BUILTIN_CONFIGURATIONS", () => {
	test("ships the AI Prompt preset: Polish tone + concise(high)/reorder/restructure/reword", () => {
		const aiPrompt = BUILTIN_CONFIGURATIONS.find(
			(c) => c.id === "builtin:ai-prompt",
		);
		expect(aiPrompt).toBeDefined();
		expect(aiPrompt?.name).toBe("AI Prompt");
		expect(aiPrompt?.config.presets).toEqual([
			{ key: "neutral" },
			{ key: "concise", level: "high" },
			{ key: "reorder" },
			{ key: "restructure" },
			{ key: "rewordForClarity" },
		]);
	});

	test("ships the Casual Chat preset: Friendly tone + concise(medium)/reword", () => {
		const chat = BUILTIN_CONFIGURATIONS.find(
			(c) => c.id === "builtin:casual-chat",
		);
		expect(chat?.name).toBe("Casual Chat");
		expect(chat?.config.presets).toEqual([
			{ key: "friendly" },
			{ key: "concise", level: "medium" },
			{ key: "rewordForClarity" },
		]);
	});

	test("ships the Formal Email preset: Formal tone + concise/reorder/restructure/reword", () => {
		const email = BUILTIN_CONFIGURATIONS.find(
			(c) => c.id === "builtin:formal-email",
		);
		expect(email?.name).toBe("Formal Email");
		expect(email?.config.presets).toEqual([
			{ key: "formal" },
			{ key: "concise", level: "medium" },
			{ key: "reorder" },
			{ key: "restructure" },
			{ key: "rewordForClarity" },
		]);
	});

	test("ships the Note Taking preset: Polish tone + summarize(medium)/reorder/restructure", () => {
		const notes = BUILTIN_CONFIGURATIONS.find(
			(c) => c.id === "builtin:note-taking",
		);
		expect(notes?.name).toBe("Note Taking");
		expect(notes?.config.presets).toEqual([
			{ key: "neutral" },
			{ key: "summarize", level: "medium" },
			{ key: "reorder" },
			{ key: "restructure" },
		]);
	});

	test("every built-in has a stable, unique builtin: id and a valid preset stack", () => {
		const ids = BUILTIN_CONFIGURATIONS.map((c) => c.id);
		expect(ids.every((id) => id.startsWith("builtin:"))).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
		// Schema invariants every stack must honor: exactly one tone, no dup keys,
		// levels only on the leveled presets.
		const TONES = new Set(["neutral", "formal", "friendly", "technical"]);
		const LEVELED = new Set(["concise", "summarize"]);
		for (const { config } of BUILTIN_CONFIGURATIONS) {
			const keys = config.presets.map((p) => p.key);
			expect(new Set(keys).size).toBe(keys.length);
			expect(keys.filter((k) => TONES.has(k)).length).toBe(1);
			for (const p of config.presets) {
				if (p.level !== undefined) {
					expect(LEVELED.has(p.key)).toBe(true);
				}
			}
		}
	});
});

describe("seedBuiltinConfigurations", () => {
	const b1 = saved("builtin:one");
	const b2 = saved("builtin:two");

	test("seeds an unseeded built-in into an empty list and records its id", () => {
		const result = seedBuiltinConfigurations([], new Set(), [b1]);
		expect(result.changed).toBe(true);
		expect(result.configurations.map((c) => c.id)).toEqual(["builtin:one"]);
		expect(result.seededIds).toEqual(["builtin:one"]);
		// Deep-cloned so the shipped definition is never aliased into the store.
		expect(result.configurations[0]?.config).not.toBe(b1.config);
	});

	test("appends built-ins after the user's own configurations", () => {
		const result = seedBuiltinConfigurations([saved("mine")], new Set(), [b1]);
		expect(result.configurations.map((c) => c.id)).toEqual([
			"mine",
			"builtin:one",
		]);
	});

	test("does not re-seed a built-in the user deleted (id already recorded)", () => {
		const result = seedBuiltinConfigurations(
			[saved("mine")],
			new Set(["builtin:one"]),
			[b1],
		);
		expect(result.changed).toBe(false);
		expect(result.configurations.map((c) => c.id)).toEqual(["mine"]);
		expect(result.seededIds).toEqual(["builtin:one"]);
	});

	test("seeds only the newly-shipped built-in on an app update", () => {
		const result = seedBuiltinConfigurations(
			[b1, saved("mine")],
			new Set(["builtin:one"]),
			[b1, b2],
		);
		expect(result.changed).toBe(true);
		expect(result.configurations.map((c) => c.id)).toEqual([
			"builtin:one",
			"mine",
			"builtin:two",
		]);
		expect(result.seededIds.sort()).toEqual(["builtin:one", "builtin:two"]);
	});

	test("records the id but adds no duplicate when the built-in is already present", () => {
		const result = seedBuiltinConfigurations([b1], new Set(), [b1]);
		// First seeding: the id must be recorded even though it was already in the
		// list, so it is not re-added on the next load.
		expect(result.changed).toBe(true);
		expect(result.configurations.map((c) => c.id)).toEqual(["builtin:one"]);
		expect(result.seededIds).toEqual(["builtin:one"]);
	});
});

describe("withAvailableLlmProvider", () => {
	test("downshifts a keyless OpenRouter config to local ollama", () => {
		const gated = withAvailableLlmProvider(
			body({ provider: "openrouter", openrouterModel: "anthropic/claude" }),
			"",
		);
		expect(gated.provider).toBe("ollama");
		// Tone/modifiers + stored cloud model fields are preserved so re-adding the
		// key and re-applying restores the original target.
		expect(gated.openrouterModel).toBe("anthropic/claude");
	});

	test("treats a whitespace-only key as absent", () => {
		expect(
			withAvailableLlmProvider(body({ provider: "openrouter" }), "   ")
				.provider,
		).toBe("ollama");
	});

	test("treats the explicit clear sentinel as absent", () => {
		const config = body({ provider: "openrouter" });
		expect(
			withAvailableLlmProvider(config, SECRET_CLEAR_SENTINEL).provider,
		).toBe("ollama");
	});

	test("leaves OpenRouter intact when a key is present (returns same ref)", () => {
		const config = body({ provider: "openrouter" });
		expect(withAvailableLlmProvider(config, "sk-or-123")).toBe(config);
	});

	test("leaves local providers untouched even without a key", () => {
		const ollama = body({ provider: "ollama" });
		expect(withAvailableLlmProvider(ollama, "")).toBe(ollama);
		const apple = body({ provider: "apple-intelligence" });
		expect(withAvailableLlmProvider(apple, "")).toBe(apple);
	});
});

describe("saved configuration storage validation", () => {
	test("repairs duplicate/invalid preset and modifier entries", () => {
		const raw = JSON.stringify([
			{
				id: "profile",
				name: "Profile",
				config: body({
					presets: [
						{ key: "neutral" },
						{ key: "formal" },
						{ key: "concise", level: "high" },
						{ key: "concise", level: "light" },
						{ key: "summarize", level: "caveman" },
					] as BuiltinPresetEntry[],
					customModifiers: [mod({ id: "same" }), mod({ id: "same" })],
				}),
			},
		]);

		const parsed = parseSavedConfigurations(raw);
		expect(parsed.repaired).toBe(true);
		expect(parsed.configs).toHaveLength(1);
		expect(parsed.configs[0]?.config.presets).toEqual([
			{ key: "neutral" },
			{ key: "concise", level: "high" },
		]);
		expect(parsed.configs[0]?.config.customModifiers).toHaveLength(1);
	});

	test("drops empty shells, duplicate ids, and out-of-range token limits", () => {
		const valid = saved("one");
		const parsed = parseSavedConfigurations(
			JSON.stringify([
				valid,
				{ ...valid, name: "duplicate" },
				{ ...saved(""), name: "No id" },
				{
					...saved("too-many"),
					config: body({ maxOutputTokens: 200_001 }),
				},
			]),
		);

		expect(parsed.repaired).toBe(true);
		expect(parsed.configs.map((entry) => entry.id)).toEqual(["one"]);
	});

	test("cross-window sync refreshes app-profile snapshots and active cache", () => {
		const configurationState = useLlmConfigurationsStore.getState();
		const settingsBefore = useSettingsStore.getState().settings;
		const oldConfig = saved("shared", { model: "old-model" });
		const editedConfig: SavedConfiguration = {
			...oldConfig,
			name: "Edited",
			config: body({ model: "new-model" }),
		};
		try {
			useLlmConfigurationsStore.setState({
				activeConfigurationId: "shared",
				configurations: [oldConfig],
				seededBuiltinIds: BUILTIN_CONFIGURATIONS.map((entry) => entry.id),
			});
			useSettingsStore.setState({
				settings: {
					...settingsBefore,
					llm: {
						...settingsBefore.llm,
						appProfiles: {
							rules: [
								{
									id: "rule",
									enabled: true,
									appExe: "editor.exe",
									titlePattern: "",
									urlPattern: "",
									configurationId: "shared",
									configurationName: oldConfig.name,
									config: configSnapshotFromSavedConfiguration(
										oldConfig.config,
									),
								},
							],
						},
					},
				},
			});

			syncConfigurationsFromStorage(
				JSON.stringify({
					version: 1,
					configurations: [editedConfig],
					seededBuiltinIds: BUILTIN_CONFIGURATIONS.map((entry) => entry.id),
				}),
			);

			expect(useLlmConfigurationsStore.getState().activeConfigurationId).toBe(
				"shared",
			);
			expect(
				useSettingsStore.getState().settings.llm.appProfiles.rules[0]
					?.configurationName,
			).toBe("Edited");
			expect(
				useSettingsStore.getState().settings.llm.appProfiles.rules[0]?.config
					.model,
			).toBe("new-model");
		} finally {
			useLlmConfigurationsStore.setState({
				activeConfigurationId: configurationState.activeConfigurationId,
				configurations: configurationState.configurations,
				seededBuiltinIds: configurationState.seededBuiltinIds,
			});
			useSettingsStore.setState({ settings: settingsBefore });
		}
	});
});
