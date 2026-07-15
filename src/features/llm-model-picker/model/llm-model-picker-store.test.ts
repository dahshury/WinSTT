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
