import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useSettingsStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "./llm-model-picker-store";

const initial = useSettingsStore.getState().settings;

beforeEach(() => {
	useSettingsStore.setState({ settings: { ...initial } });
	useLlmModelPickerStore.getState().close();
});

afterEach(() => {
	useSettingsStore.setState({ settings: initial });
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
});
