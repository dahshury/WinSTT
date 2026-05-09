import { describe, expect, test } from "bun:test";
import {
	addDictionaryEntrySchema,
	addSnippetEntrySchema,
	appSettingsSchema,
	audioSettingsSchema,
	dictionaryEntrySchema,
	generalSettingsSchema,
	hotkeySettingsSchema,
	llmSettingsSchema,
	modelSettingsSchema,
	qualitySettingsSchema,
	snippetEntrySchema,
} from "./settings-schema";

describe("modelSettingsSchema defaults", () => {
	test("produces all defaults from empty input", () => {
		const out = modelSettingsSchema.parse({});
		expect(out.model).toBe("large-v2");
		expect(out.realtimeModel).toBe("tiny");
		expect(out.language).toBe("en");
		expect(out.computeType).toBe("default");
		expect(out.device).toBe("auto");
		expect(out.backend).toBe("faster_whisper");
		expect(out.beamSize).toBe(5);
		expect(out.beamSizeRealtime).toBe(3);
	});

	test("rejects beamSize less than 1", () => {
		expect(() => modelSettingsSchema.parse({ beamSize: 0 })).toThrow();
	});

	test("rejects unknown computeType", () => {
		expect(() => modelSettingsSchema.parse({ computeType: "lol" })).toThrow();
	});

	test("rejects unknown backend", () => {
		expect(() => modelSettingsSchema.parse({ backend: "made-up" })).toThrow();
	});
});

describe("audioSettingsSchema bounds", () => {
	test("clamps allowed sileroSensitivity range [0,1]", () => {
		const ok = audioSettingsSchema.parse({ sileroSensitivity: 0.5 });
		expect(ok.sileroSensitivity).toBe(0.5);
		expect(() => audioSettingsSchema.parse({ sileroSensitivity: 1.5 })).toThrow();
		expect(() => audioSettingsSchema.parse({ sileroSensitivity: -0.1 })).toThrow();
	});

	test("clamps allowed webrtcSensitivity range [0,3]", () => {
		expect(audioSettingsSchema.parse({ webrtcSensitivity: 0 }).webrtcSensitivity).toBe(0);
		expect(audioSettingsSchema.parse({ webrtcSensitivity: 3 }).webrtcSensitivity).toBe(3);
		expect(() => audioSettingsSchema.parse({ webrtcSensitivity: 4 })).toThrow();
	});

	test("inputDeviceIndex accepts null", () => {
		expect(audioSettingsSchema.parse({ inputDeviceIndex: null }).inputDeviceIndex).toBeNull();
	});
});

describe("qualitySettingsSchema", () => {
	test("smartEndpointSpeed bounded [0.5, 3.0]", () => {
		expect(qualitySettingsSchema.parse({ smartEndpointSpeed: 1 }).smartEndpointSpeed).toBe(1);
		expect(() => qualitySettingsSchema.parse({ smartEndpointSpeed: 0.4 })).toThrow();
		expect(() => qualitySettingsSchema.parse({ smartEndpointSpeed: 3.5 })).toThrow();
	});

	test("realtime defaults align with PTT mode", () => {
		const out = qualitySettingsSchema.parse({});
		expect(out.enableRealtimeTranscription).toBe(true);
		expect(out.useMainModelForRealtime).toBe(false);
	});
});

describe("generalSettingsSchema", () => {
	test("recordingMode defaults to ptt", () => {
		expect(generalSettingsSchema.parse({}).recordingMode).toBe("ptt");
	});

	test("rejects invalid recordingMode", () => {
		expect(() => generalSettingsSchema.parse({ recordingMode: "scream" })).toThrow();
	});

	test("visualizerSize falls back to 'xs' for legacy integer values via .catch()", () => {
		// Old persisted format: a numeric pixel — schema should swallow and emit 'xs'
		const out = generalSettingsSchema.parse({ visualizerSize: 24 });
		expect(out.visualizerSize).toBe("xs");
	});

	test("visualizerSize accepts the canonical enum values", () => {
		for (const size of ["xs", "sm", "md", "lg", "xl"] as const) {
			expect(generalSettingsSchema.parse({ visualizerSize: size }).visualizerSize).toBe(size);
		}
	});

	test("visualizerColor must be a hex color", () => {
		expect(() => generalSettingsSchema.parse({ visualizerColor: "blue" })).toThrow();
		expect(generalSettingsSchema.parse({ visualizerColor: "#abcdef" }).visualizerColor).toBe(
			"#abcdef"
		);
	});

	test("visualizerBarCount bounded [3, 21]", () => {
		expect(generalSettingsSchema.parse({ visualizerBarCount: 3 }).visualizerBarCount).toBe(3);
		expect(generalSettingsSchema.parse({ visualizerBarCount: 21 }).visualizerBarCount).toBe(21);
		expect(() => generalSettingsSchema.parse({ visualizerBarCount: 2 })).toThrow();
		expect(() => generalSettingsSchema.parse({ visualizerBarCount: 22 })).toThrow();
	});

	test("rejects invalid fileTranscriptionFormat", () => {
		expect(() => generalSettingsSchema.parse({ fileTranscriptionFormat: "pdf" })).toThrow();
	});
});

describe("hotkeySettingsSchema", () => {
	test("default is LCtrl+LMeta", () => {
		expect(hotkeySettingsSchema.parse({}).pushToTalkKey).toBe("LCtrl+LMeta");
	});

	test("rejects empty pushToTalkKey", () => {
		expect(() => hotkeySettingsSchema.parse({ pushToTalkKey: "" })).toThrow();
	});
});

describe("dictionary & snippet schemas", () => {
	test("dictionaryEntrySchema requires id, find, replace", () => {
		const ok = dictionaryEntrySchema.parse({ id: "1", find: "a", replace: "b" });
		expect(ok.caseSensitive).toBe(false);
		expect(ok.wholeWord).toBe(false);
		expect(() => dictionaryEntrySchema.parse({ id: "", find: "a", replace: "b" })).toThrow();
		expect(() => dictionaryEntrySchema.parse({ id: "1", find: "", replace: "b" })).toThrow();
		expect(() => dictionaryEntrySchema.parse({ id: "1", find: "a", replace: "" })).toThrow();
	});

	test("addDictionaryEntrySchema trims whitespace and rejects blank input", () => {
		const ok = addDictionaryEntrySchema.parse({
			find: "  hello  ",
			replace: "  world  ",
			caseSensitive: true,
			wholeWord: false,
		});
		expect(ok.find).toBe("hello");
		expect(ok.replace).toBe("world");
		expect(() =>
			addDictionaryEntrySchema.parse({
				find: "   ",
				replace: "world",
				caseSensitive: false,
				wholeWord: false,
			})
		).toThrow();
	});

	test("snippet schemas behave similarly", () => {
		expect(snippetEntrySchema.parse({ id: "1", trigger: "/x", expansion: "X" })).toEqual({
			id: "1",
			trigger: "/x",
			expansion: "X",
		});
		const out = addSnippetEntrySchema.parse({ trigger: "  /x ", expansion: " X " });
		expect(out.trigger).toBe("/x");
		expect(out.expansion).toBe("X");
	});
});

describe("llmSettingsSchema", () => {
	test("endpoint must be a URL", () => {
		expect(() => llmSettingsSchema.parse({ endpoint: "not a url" })).toThrow();
	});

	test("timeout bounded [1000, 30000]", () => {
		expect(llmSettingsSchema.parse({ timeout: 1000 }).timeout).toBe(1000);
		expect(llmSettingsSchema.parse({ timeout: 30_000 }).timeout).toBe(30_000);
		expect(() => llmSettingsSchema.parse({ timeout: 999 })).toThrow();
		expect(() => llmSettingsSchema.parse({ timeout: 30_001 })).toThrow();
	});

	test("preset must be one of the canonical presets", () => {
		expect(llmSettingsSchema.parse({ preset: "neutral" }).preset).toBe("neutral");
		expect(() => llmSettingsSchema.parse({ preset: "spicy" })).toThrow();
	});

	test("provider must be ollama or openrouter", () => {
		expect(() => llmSettingsSchema.parse({ provider: "openai" })).toThrow();
	});
});

describe("appSettingsSchema (composed)", () => {
	test("empty object resolves to a fully-defaulted object", () => {
		const out = appSettingsSchema.parse({});
		expect(out.general.recordingMode).toBe("ptt");
		expect(out.model.model).toBe("large-v2");
		expect(out.audio.sampleRate).toBe(16_000);
		expect(out.dictionary).toEqual([]);
		expect(out.snippets).toEqual([]);
		expect(out.llm.enabled).toBe(false);
	});

	test("partial input fills defaults for missing branches", () => {
		const out = appSettingsSchema.parse({
			general: { recordingMode: "toggle" },
			llm: { enabled: true },
		});
		expect(out.general.recordingMode).toBe("toggle");
		expect(out.general.minimizeToTray).toBe(true); // default
		expect(out.llm.enabled).toBe(true);
		expect(out.llm.provider).toBe("ollama"); // default
	});
});
