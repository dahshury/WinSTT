import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "./llm-model-picker-store";

const initial = useSettingsStore.getState().settings;

/** Seed an in-flight Ollama pull so `close()` sees a streaming download. */
function seedPull(model: string): void {
	useLlmCatalogStore.setState({
		pulls: {
			[model]: {
				progress: { model, status: "downloading" as const },
				startedAt: 1,
			},
		},
	});
}

beforeEach(() => {
	useSettingsStore.setState({ settings: { ...initial } });
	useLlmCatalogStore.setState({ pulls: {} });
	useLlmModelPickerStore.getState().close();
	// `close()` deliberately preserves the parked turn-on intent, so tests
	// must reset it explicitly.
	useLlmModelPickerStore.setState({ pendingFeature: null });
});

afterEach(() => {
	useSettingsStore.setState({ settings: initial });
	useLlmCatalogStore.setState({ pulls: {} });
});

describe("useLlmModelPickerStore", () => {
	test("openFor records the feature + enable intent and opens", () => {
		useLlmModelPickerStore.getState().openFor("dictation", true);
		const s = useLlmModelPickerStore.getState();
		expect(s.open).toBe(true);
		expect(s.feature).toBe("dictation");
		expect(s.enableOnInstall).toBe(true);
	});

	test("close resets the coordination state", () => {
		useLlmModelPickerStore.getState().openFor("transforms", true);
		useLlmModelPickerStore.getState().close();
		const s = useLlmModelPickerStore.getState();
		expect(s.open).toBe(false);
		expect(s.feature).toBeNull();
		expect(s.enableOnInstall).toBe(false);
	});

	test("commitInstalled with enable intent turns the feature on with the model", () => {
		// This is the whole point: the toggle opened the picker WITHOUT enabling;
		// only a landed model flips `enabled` true — never the empty-model state.
		useLlmModelPickerStore.getState().openFor("dictation", true);
		useLlmModelPickerStore.getState().commitInstalled("llama3.2:3b");
		const d = useSettingsStore.getState().settings.llm.dictation;
		expect(d.model).toBe("llama3.2:3b");
		expect(d.provider).toBe("ollama");
		expect(d.enabled).toBe(true);
	});

	test("commitInstalled WITHOUT enable intent (browse) sets the model but leaves enabled off", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				llm: {
					...initial.llm,
					dictation: { ...initial.llm.dictation, enabled: false, model: "" },
				},
			},
		});
		useLlmModelPickerStore.getState().openFor("dictation", false);
		useLlmModelPickerStore.getState().commitInstalled("qwen3:1.7b");
		const d = useSettingsStore.getState().settings.llm.dictation;
		expect(d.model).toBe("qwen3:1.7b");
		expect(d.enabled).toBe(false);
	});

	test("commitInstalled is a no-op when nothing is pending", () => {
		useLlmModelPickerStore.getState().close();
		const before = useSettingsStore.getState().settings.llm.dictation.model;
		useLlmModelPickerStore.getState().commitInstalled("ghost-model");
		expect(useSettingsStore.getState().settings.llm.dictation.model).toBe(
			before,
		);
	});

	test("commitInstalled routes to the transforms feature when it is pending", () => {
		useLlmModelPickerStore.getState().openFor("transforms", true);
		useLlmModelPickerStore.getState().commitInstalled("mistral:7b");
		const tr = useSettingsStore.getState().settings.llm.transforms;
		expect(tr.model).toBe("mistral:7b");
		expect(tr.enabled).toBe(true);
	});

	test("closing a turn-on session with a pull streaming parks the enable intent", () => {
		// The background-download UX: enable toggle → dialog opens → pull starts
		// → user closes the dialog (or switches apps). The pull's success
		// callback outlives the dialog and must still enable the feature.
		useLlmModelPickerStore.getState().openFor("dictation", true);
		seedPull("llama3.2:3b");
		useLlmModelPickerStore.getState().close();
		expect(useLlmModelPickerStore.getState().pendingFeature).toBe("dictation");
		useLlmModelPickerStore.getState().commitInstalled("llama3.2:3b");
		const d = useSettingsStore.getState().settings.llm.dictation;
		expect(d.model).toBe("llama3.2:3b");
		expect(d.enabled).toBe(true);
		expect(useLlmModelPickerStore.getState().pendingFeature).toBeNull();
	});

	test("closing a turn-on session with NO pull streaming abandons the intent", () => {
		useLlmModelPickerStore.getState().openFor("dictation", true);
		useLlmModelPickerStore.getState().close();
		expect(useLlmModelPickerStore.getState().pendingFeature).toBeNull();
		const before = useSettingsStore.getState().settings.llm.dictation;
		useLlmModelPickerStore.getState().commitInstalled("llama3.2:3b");
		const d = useSettingsStore.getState().settings.llm.dictation;
		expect(d.model).toBe(before.model);
		expect(d.enabled).toBe(before.enabled);
	});

	test("a parked dictation intent still disables Smart Endpoint on commit", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				quality: { ...initial.quality, smartEndpoint: true },
			},
		});
		useLlmModelPickerStore.getState().openFor("dictation", true);
		seedPull("llama3.2:3b");
		useLlmModelPickerStore.getState().close();
		useLlmModelPickerStore.getState().commitInstalled("llama3.2:3b");
		expect(useSettingsStore.getState().settings.quality.smartEndpoint).toBe(
			false,
		);
	});

	// Read aloud used to be folded into "dictation" here, so a picker opened from
	// the Read aloud row enabled DICTATION (and silently turned Smart Endpoint
	// off) while read aloud stayed off.
	test("commitInstalled routes to read aloud when it is the pending feature", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				quality: { ...initial.quality, smartEndpoint: true },
			},
		});
		useLlmModelPickerStore.getState().openFor("readAloud", true);
		useLlmModelPickerStore.getState().commitInstalled("gemma3:4b");
		const { llm, quality } = useSettingsStore.getState().settings;
		expect(llm.readAloud.model).toBe("gemma3:4b");
		expect(llm.readAloud.enabled).toBe(true);
		expect(llm.dictation.enabled).toBe(false);
		// Smart Endpoint competes with DICTATION's finalization only.
		expect(quality.smartEndpoint).toBe(true);
	});

	test("dismissing a read-aloud turn-on switches read aloud off, not dictation", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				llm: {
					...initial.llm,
					dictation: { ...initial.llm.dictation, enabled: true },
					readAloud: { ...initial.llm.readAloud, enabled: true },
				},
			},
		});
		useLlmModelPickerStore.getState().openFor("readAloud", true);
		useLlmModelPickerStore.getState().close();
		const { llm } = useSettingsStore.getState().settings;
		expect(llm.readAloud.enabled).toBe(false);
		expect(llm.dictation.enabled).toBe(true);
	});

	// The installed model becomes THE shared local model, so every OTHER
	// locally-running consumer has to move onto it — leaving them behind is a
	// second model resident in VRAM, which is what the rule exists to prevent.
	test("commitInstalled moves every local consumer onto the installed model", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				llm: {
					...initial.llm,
					localModel: "old:1b",
					dictation: {
						...initial.llm.dictation,
						enabled: true,
						model: "old:1b",
						provider: "ollama",
					},
					readAloud: {
						...initial.llm.readAloud,
						model: "old:1b",
						provider: "ollama",
					},
					transforms: {
						...initial.llm.transforms,
						enabled: true,
						model: "old:1b",
						provider: "ollama",
					},
				},
			},
		});
		useLlmModelPickerStore.getState().openFor("dictation", true);
		useLlmModelPickerStore.getState().commitInstalled("new:4b");
		const { llm } = useSettingsStore.getState().settings;
		expect(llm.localModel).toBe("new:4b");
		expect(llm.dictation.model).toBe("new:4b");
		expect(llm.transforms.model).toBe("new:4b");
		expect(llm.readAloud.model).toBe("new:4b");
	});

	test("a cloud consumer keeps its own model when a local one lands", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				llm: {
					...initial.llm,
					transforms: {
						...initial.llm.transforms,
						enabled: true,
						openrouterModel: "vendor/fast",
						provider: "openrouter",
					},
				},
			},
		});
		useLlmModelPickerStore.getState().openFor("dictation", true);
		useLlmModelPickerStore.getState().commitInstalled("new:4b");
		const { llm } = useSettingsStore.getState().settings;
		expect(llm.transforms.provider).toBe("openrouter");
		expect(llm.transforms.model).toBe(initial.llm.transforms.model);
	});

	test("a later close without intent keeps an earlier parked intent alive", () => {
		useLlmModelPickerStore.getState().openFor("dictation", true);
		seedPull("llama3.2:3b");
		useLlmModelPickerStore.getState().close();
		// Reopen/close a session that never asked to turn anything on — the
		// dictation pull is still streaming and must keep its commit rights.
		useLlmModelPickerStore.getState().openFor("transforms", false);
		useLlmModelPickerStore.getState().close();
		expect(useLlmModelPickerStore.getState().pendingFeature).toBe("dictation");
	});
});
