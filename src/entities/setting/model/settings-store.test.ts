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

	test("setSettings normalizes LLM dictation off when word-by-word pasting is enabled", () => {
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
		expect(settings.llm.dictation.enabled).toBe(false);
		expect(settings.general.wordByWordPasting).toBe(true);
	});

	test("setLoaded toggles the isLoaded flag without touching settings", () => {
		const snapshot = useSettingsStore.getState().settings;
		useSettingsStore.getState().setLoaded(false);
		expect(useSettingsStore.getState().isLoaded).toBe(false);
		expect(useSettingsStore.getState().settings).toBe(snapshot);
	});

	test("resetSettings restores defaults but PRESERVES dictionary and snippets", () => {
		useSettingsStore
			.getState()
			.updateGeneralSettings({ recordingMode: "toggle" });
		useSettingsStore
			.getState()
			.updateDictionary([{ id: "1", term: "Kubernetes" }]);

		useSettingsStore.getState().resetSettings();
		const settings = useSettingsStore.getState().settings;
		expect(settings.general.recordingMode).toBe("ptt"); // back to default
		expect(settings.dictionary).toHaveLength(1); // preserved
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
		expect(parsed.state.settings).toBeDefined();
		// `isLoaded` MUST NOT be persisted — partialize is `(s) => ({ settings: s.settings })`.
		// A mutant `(s) => undefined` would store `{ state: undefined }`;
		// a mutant `{}` would store `{ state: {} }`. Either way `settings` would be
		// missing or undefined.
		expect(
			(parsed.state.settings as Record<string, unknown>).general,
		).toBeDefined();
		expect("isLoaded" in parsed.state).toBe(false);
	});
});
