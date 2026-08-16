import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useSettingsStore } from "./settings-store";

const STORAGE_KEY = "winstt-settings";

beforeEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
	// Reset the store to its initial defaults via resetSettings (with empty dict/snippets)
	useSettingsStore.getState().updateDictionary([]);
	useSettingsStore.getState().updateSnippets([]);
	useSettingsStore.getState().resetSettings();
});

afterEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
});

describe("useSettingsStore mutators", () => {
	test("updateModelSettings merges patch into existing model branch", () => {
		useSettingsStore.getState().updateModelSettings({ language: "fr" });
		expect(useSettingsStore.getState().settings.model.language).toBe("fr");
		expect(useSettingsStore.getState().settings.model.model).toBe("tiny"); // default preserved
	});

	test("updateQualitySettings merges patch", () => {
		useSettingsStore.getState().updateQualitySettings({ smartEndpoint: true });
		expect(useSettingsStore.getState().settings.quality.smartEndpoint).toBe(
			true,
		);
	});

	test("updateAudioSettings merges patch", () => {
		useSettingsStore.getState().updateAudioSettings({ sampleRate: 44_100 });
		expect(useSettingsStore.getState().settings.audio.sampleRate).toBe(44_100);
	});

	test("updateGeneralSettings merges patch", () => {
		useSettingsStore
			.getState()
			.updateGeneralSettings({ recordingMode: "toggle" });
		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"toggle",
		);
	});

	test("updateGeneralSettings disables LLM dictation when word-by-word is enabled", () => {
		useSettingsStore.getState().updateLlmDictation({ enabled: true });
		useSettingsStore
			.getState()
			.updateGeneralSettings({ wordByWordPasting: true });

		const settings = useSettingsStore.getState().settings;
		expect(settings.llm.dictation.enabled).toBe(false);
		expect(settings.general.wordByWordPasting).toBe(true);
	});

	test("updateGlobalSettings merges patch", () => {
		const store =
			useSettingsStore.getState() as typeof useSettingsStore extends {
				getState: () => infer S;
			}
				? S & {
						updateGlobalSettings?: (patch: {
							modelUnloadTimeout: "hour1";
						}) => void;
					}
				: never;
		expect(typeof store.updateGlobalSettings).toBe("function");
		store.updateGlobalSettings?.({ modelUnloadTimeout: "hour1" });
		expect(
			(
				useSettingsStore.getState().settings as {
					global?: { modelUnloadTimeout?: string };
				}
			).global?.modelUnloadTimeout,
		).toBe("hour1");
	});

	test("updateHotkeySettings merges patch", () => {
		useSettingsStore
			.getState()
			.updateHotkeySettings({ pushToTalkKey: "Ctrl+S" });
		expect(useSettingsStore.getState().settings.hotkey.pushToTalkKey).toBe(
			"Ctrl+S",
		);
	});

	test("updateLlmSettings merges shared-field patch (endpoint, openrouterApiKey)", () => {
		useSettingsStore.getState().updateLlmSettings({
			endpoint: "http://example.com:11434",
			openrouterApiKey: "sk-test",
		});
		expect(useSettingsStore.getState().settings.llm.endpoint).toBe(
			"http://example.com:11434",
		);
		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			"sk-test",
		);
		// Default per-feature state must remain untouched
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
		expect(useSettingsStore.getState().settings.llm.transforms.enabled).toBe(
			false,
		);
	});

	test("updateLlmAppProfiles replaces only the per-app rule list", () => {
		const before = useSettingsStore.getState().settings.llm;
		useSettingsStore.getState().updateLlmAppProfiles([
			{
				id: "gmail",
				enabled: true,
				appExe: "chrome.exe",
				titlePattern: "",
				urlPattern: "gmail.com",
				configurationId: "builtin:formal",
				configurationName: "Formal",
				config: {
					provider: "ollama",
					model: "qwen3:4b",
					openrouterModel: "",
					openrouterFallbackModel: "",
					reasoningEffort: "medium",
					thinkingEffort: "off",
					verbosity: "medium",
					maxOutputTokens: null,
					presets: [{ key: "formal" }],
					customModifiers: [],
				},
			},
		]);
		const after = useSettingsStore.getState().settings.llm;
		expect(after.appProfiles.rules[0]?.id).toBe("gmail");
		expect(after.dictation).toEqual(before.dictation);
		expect(after.endpoint).toBe(before.endpoint);
	});

	test("updateLlmDictation merges patch into the dictation sub-tree without touching other LLM branches", () => {
		useSettingsStore
			.getState()
			.updateLlmDictation({ enabled: true, presets: [{ key: "formal" }] });
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			true,
		);
		expect(useSettingsStore.getState().settings.llm.dictation.presets).toEqual([
			{ key: "formal" },
		]);
		// Other branches untouched
		expect(useSettingsStore.getState().settings.llm.transforms.enabled).toBe(
			false,
		);
		expect(useSettingsStore.getState().settings.llm.endpoint).toBe(
			"http://localhost:11434",
		);
	});

	test("updateLlmDictation keeps word-by-word pasting active when dictation is enabled", () => {
		useSettingsStore
			.getState()
			.updateGeneralSettings({ wordByWordPasting: true });
		expect(useSettingsStore.getState().settings.general.wordByWordPasting).toBe(
			true,
		);

		useSettingsStore.getState().updateLlmDictation({ enabled: true });

		const settings = useSettingsStore.getState().settings;
		expect(settings.llm.dictation.enabled).toBe(false);
		expect(settings.general.wordByWordPasting).toBe(true);
	});

	test("updateLlmTransforms merges patch into the transforms sub-tree only", () => {
		useSettingsStore
			.getState()
			.updateLlmTransforms({ enabled: true, model: "llama3" });
		expect(useSettingsStore.getState().settings.llm.transforms.enabled).toBe(
			true,
		);
		expect(useSettingsStore.getState().settings.llm.transforms.model).toBe(
			"llama3",
		);
		// Dictation branch untouched
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
		expect(useSettingsStore.getState().settings.llm.dictation.model).toBe("");
	});

	// Transformations used to be a SHADOW of dictation — `updateLlmPostProcessing`
	// copied provider/model/tone/modifiers/`enabled` into both, so the two could
	// never be configured apart (which is why there was nothing to configure for
	// transformations at all). They are independent consumers now: each is
	// ASSIGNED a saved configuration, so writing one must not disturb the other.
	test("updateLlmPostProcessing writes dictation ONLY, leaving transformations alone", () => {
		useSettingsStore.getState().updateLlmTransforms({
			hotkey: "LCtrl+LAlt+T",
			enabled: false,
			model: "transform-model",
			presets: [{ key: "friendly" }],
		});

		useSettingsStore.getState().updateLlmPostProcessing({
			enabled: true,
			model: "llama3",
			provider: "ollama",
			presets: [{ key: "formal" }],
			dictionaryAutoAddEnabled: true,
		});

		const { dictation, transforms } = useSettingsStore.getState().settings.llm;
		expect(dictation.enabled).toBe(true);
		expect(dictation.model).toBe("llama3");
		expect(dictation.presets).toEqual([{ key: "formal" }]);
		expect(dictation.dictionaryAutoAddEnabled).toBe(true);

		expect(transforms.enabled).toBe(false);
		expect(transforms.model).toBe("transform-model");
		expect(transforms.presets).toEqual([{ key: "friendly" }]);
		expect(transforms.hotkey).toBe("LCtrl+LAlt+T");
		// Dictation-only field, never mirrored anywhere.
		expect("dictionaryAutoAddEnabled" in transforms).toBe(false);
	});

	test("updateLlmReadAloud patches only the read-aloud consumer", () => {
		useSettingsStore.getState().updateLlmReadAloud({
			enabled: true,
			configurationId: "cfg-read",
			provider: "openrouter",
			openrouterModel: "vendor/fast",
		});
		const { dictation, readAloud, transforms } =
			useSettingsStore.getState().settings.llm;
		expect(readAloud.enabled).toBe(true);
		expect(readAloud.configurationId).toBe("cfg-read");
		// A cloud read-aloud pass alongside a local dictation pass is supported.
		expect(readAloud.provider).toBe("openrouter");
		expect(dictation.provider).toBe("ollama");
		expect(transforms.provider).toBe("ollama");
	});

	// The one-shared-local-model rule spans four slices, so it is upheld here
	// rather than by each caller: the model picker used to write `localModel` and
	// the feature it was opened from, leaving the others on the previous model —
	// two models resident in VRAM, which is what the rule exists to prevent.
	test("updateLlmSharedLocalModel moves every local consumer onto the model", () => {
		useSettingsStore.getState().updateLlmPostProcessing({ model: "old:1b" });
		useSettingsStore.getState().updateLlmTransforms({ model: "old:1b" });
		useSettingsStore.getState().updateLlmReadAloud({
			model: "cloud-untouched",
			provider: "openrouter",
		});

		useSettingsStore.getState().updateLlmSharedLocalModel("new:4b");

		const { llm } = useSettingsStore.getState().settings;
		expect(llm.localModel).toBe("new:4b");
		expect(llm.dictation.model).toBe("new:4b");
		expect(llm.transforms.model).toBe("new:4b");
		// Cloud consumers are unconstrained — their model costs no VRAM.
		expect(llm.readAloud.model).toBe("cloud-untouched");
	});

	test("updateLlmSharedLocalModel leaves per-feature models alone while the power toggle is on", () => {
		useSettingsStore.getState().updateLlmSettings({
			allowMultipleLocalModels: true,
		});
		useSettingsStore.getState().updateLlmPostProcessing({ model: "own:1b" });

		useSettingsStore.getState().updateLlmSharedLocalModel("new:4b");

		const { llm } = useSettingsStore.getState().settings;
		expect(llm.localModel).toBe("new:4b");
		expect(llm.dictation.model).toBe("own:1b");
	});

	test("updateDictionary replaces the dictionary list wholesale", () => {
		const dict = [{ id: "1", term: "Kubernetes" }];
		useSettingsStore.getState().updateDictionary(dict);
		expect(useSettingsStore.getState().settings.dictionary).toEqual(dict);
	});

	test("updateSnippets replaces the snippets list wholesale", () => {
		const snippets = [{ id: "1", trigger: "/sig", expansion: "kind regards" }];
		useSettingsStore.getState().updateSnippets(snippets);
		expect(useSettingsStore.getState().settings.snippets).toEqual(snippets);
	});

	test("setSettings replaces the whole settings object and marks loaded", () => {
		const before = useSettingsStore.getState().settings;
		useSettingsStore.getState().setSettings({
			...before,
			general: { ...before.general, recordingMode: "listen" },
		});
		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"listen",
		);
		expect(useSettingsStore.getState().isLoaded).toBe(true);
	});

	test("setSettings preserves LLM dictation flags (hydration/broadcast path does not re-normalize)", () => {
		// Audit #23: setSettings is the hydration / cross-window broadcast path, not
		// a user edit. It must store the given (already-writer-normalized) value
		// verbatim instead of silently clearing the user's llm.enabled flags — the
		// old re-normalization here let an unrelated broadcast wipe those flags, and
		// the next save then persisted the loss.
		const before = useSettingsStore.getState().settings;
		useSettingsStore.getState().setSettings({
			...before,
			general: { ...before.general, wordByWordPasting: true },
			llm: {
				...before.llm,
				dictation: { ...before.llm.dictation, enabled: true },
			},
		});

		const settings = useSettingsStore.getState().settings;
		expect(settings.llm.dictation.enabled).toBe(true);
		expect(settings.general.wordByWordPasting).toBe(true);
	});

	test("setLoaded toggles the isLoaded flag without touching settings", () => {
		const snapshot = useSettingsStore.getState().settings;
		useSettingsStore.getState().setLoaded(false);
		expect(useSettingsStore.getState().isLoaded).toBe(false);
		expect(useSettingsStore.getState().settings).toBe(snapshot);
	});

	test("resetSettings restores the complete renderer settings tree", () => {
		useSettingsStore
			.getState()
			.updateGeneralSettings({ recordingMode: "toggle" });
		useSettingsStore
			.getState()
			.updateDictionary([{ id: "1", term: "Kubernetes" }]);
		useSettingsStore
			.getState()
			.updateSnippets([
				{ id: "1", trigger: "/sig", expansion: "Kind regards" },
			]);

		useSettingsStore.getState().resetSettings();
		const settings = useSettingsStore.getState().settings;
		expect(settings.general.recordingMode).toBe("ptt"); // back to default
		expect(settings.dictionary).toEqual([]);
		expect(settings.snippets).toEqual([]);
	});

	test("persists state under the EXACT key 'winstt-settings' (kills `name: \"\"` and storage-name mutants)", () => {
		// Mutate something so persist writes to localStorage.
		useSettingsStore
			.getState()
			.updateGeneralSettings({ recordingMode: "toggle" });
		// The persist key MUST be "winstt-settings" — a mutant that changes
		// the name to "" or anything else would write to a different key,
		// leaving "winstt-settings" empty.
		const stored = window.localStorage.getItem("winstt-settings");
		expect(stored).not.toBeNull();
		// Confirm the persisted blob is valid JSON containing the change.
		expect(JSON.parse(stored as string)).toMatchObject({
			state: { settings: { general: { recordingMode: "toggle" } } },
		});
	});

	test("updateIntegrations({ elevenlabs }) shallow-merges the elevenlabs branch and preserves prior fields", () => {
		// ElevenLabs is the only integrations-backed cloud provider (OpenAI
		// removed; OpenRouter STT reuses the LLM key). Prove a partial patch
		// replaces `apiKey` while a `verified` flag set by a prior call survives.
		useSettingsStore.getState().updateIntegrations({
			elevenlabs: { apiKey: "el-old", verified: true },
		});
		useSettingsStore
			.getState()
			.updateIntegrations({ elevenlabs: { apiKey: "el-new" } });

		const integrations = useSettingsStore.getState().settings.integrations;
		// elevenlabs.apiKey replaced, but `verified` from the prior call survives.
		expect(integrations.elevenlabs.apiKey).toBe("el-new");
		expect(integrations.elevenlabs.verified).toBe(true);
	});

	test("updateIntegrations({}) (empty patch) leaves integrations unchanged in value", () => {
		useSettingsStore.getState().updateIntegrations({
			elevenlabs: { apiKey: "el-keep" },
		});
		const before = useSettingsStore.getState().settings.integrations;
		useSettingsStore.getState().updateIntegrations({});
		const after = useSettingsStore.getState().settings.integrations;
		expect(after).toEqual(before);
		// Per-provider sub-objects retain their fields.
		expect(after.elevenlabs.apiKey).toBe("el-keep");
	});

	test("partialize only persists `settings` (NOT `isLoaded`) — kills `() => undefined` and `{}` mutants", () => {
		useSettingsStore
			.getState()
			.updateGeneralSettings({ recordingMode: "listen" });
		const stored = window.localStorage.getItem("winstt-settings");
		expect(stored).not.toBeNull();
		const parsed = JSON.parse(stored as string) as {
			state: Record<string, unknown>;
		};
		// `settings` MUST be present in the persisted state.
		expect(parsed.state["settings"]).toBeDefined();
		// `isLoaded` MUST NOT be persisted — partialize is `(s) => ({ settings: s.settings })`.
		// A mutant `(s) => undefined` would store `{ state: undefined }`;
		// a mutant `{}` would store `{ state: {} }`. Either way `settings` would be
		// missing or undefined.
		expect(
			(parsed.state["settings"] as Record<string, unknown>)["general"],
		).toBeDefined();
		expect("isLoaded" in parsed.state).toBe(false);
	});
});
