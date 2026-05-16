import { describe, expect, test } from "bun:test";
import {
	addDictionaryEntrySchema,
	addSnippetEntrySchema,
	appSettingsSchema,
	audioSettingsSchema,
	BUILTIN_TRANSFORMS,
	dictionaryEntrySchema,
	generalSettingsSchema,
	hotkeySettingsSchema,
	llmSettingsSchema,
	modelSettingsSchema,
	qualitySettingsSchema,
	snippetEntrySchema,
	transformSchema,
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

	test("device enum accepts both 'auto' and 'cpu'", () => {
		// Locks down `["auto", "cpu"]` enum literals against StringLiteral
		// mutations — if either value mutates to "" the corresponding key
		// would be rejected here.
		expect(modelSettingsSchema.parse({ device: "auto" }).device).toBe("auto");
		expect(modelSettingsSchema.parse({ device: "cpu" }).device).toBe("cpu");
	});

	test("device enum rejects empty string (kills mutation of 'auto'/'cpu' to '')", () => {
		// Belt-and-braces — the StringLiteral mutation replaces an enum
		// option with "". Passing "" should still fail validation because
		// neither real option is "".
		expect(() => modelSettingsSchema.parse({ device: "" })).toThrow();
	});

	test("backend enum accepts both 'faster_whisper' and 'onnx_asr'", () => {
		expect(modelSettingsSchema.parse({ backend: "faster_whisper" }).backend).toBe("faster_whisper");
		expect(modelSettingsSchema.parse({ backend: "onnx_asr" }).backend).toBe("onnx_asr");
	});

	test("backend enum rejects empty string", () => {
		expect(() => modelSettingsSchema.parse({ backend: "" })).toThrow();
	});

	test("onnxQuantization defaults to an empty string (kills L13 default-literal mutation)", () => {
		// Locks the `default("")` for onnxQuantization. Mutating to a
		// non-empty default would surface a stale value to consumers.
		expect(modelSettingsSchema.parse({}).onnxQuantization).toBe("");
	});

	test("initialPrompt and initialPromptRealtime default to empty strings", () => {
		const out = modelSettingsSchema.parse({});
		expect(out.initialPrompt).toBe("");
		expect(out.initialPromptRealtime).toBe("");
	});

	test("beamSize enforces min(1) — zero is rejected, one is accepted", () => {
		// Locks `.min(1)` against `.max(1)` mutation. With max(1), 5 would
		// fail; with min(1), 0 fails and 5 passes. Cover both directions.
		expect(modelSettingsSchema.parse({ beamSize: 1 }).beamSize).toBe(1);
		expect(modelSettingsSchema.parse({ beamSize: 5 }).beamSize).toBe(5);
		expect(() => modelSettingsSchema.parse({ beamSize: 0 })).toThrow();
		expect(() => modelSettingsSchema.parse({ beamSize: -1 })).toThrow();
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

	test("presets must contain known preset keys", () => {
		expect(llmSettingsSchema.parse({ presets: [{ key: "neutral" as const }] }).presets).toEqual([
			{ key: "neutral" },
		]);
		expect(() => llmSettingsSchema.parse({ presets: [{ key: "spicy" }] })).toThrow();
	});

	test("provider must be ollama or openrouter", () => {
		expect(() => llmSettingsSchema.parse({ provider: "openai" })).toThrow();
	});
});

describe("qualitySettingsSchema defaults (lock-down)", () => {
	test("ensureSentenceStartingUppercase defaults to true", () => {
		expect(qualitySettingsSchema.parse({}).ensureSentenceStartingUppercase).toBe(true);
	});

	test("ensureSentenceEndsWithPeriod defaults to true", () => {
		expect(qualitySettingsSchema.parse({}).ensureSentenceEndsWithPeriod).toBe(true);
	});

	test("smartEndpoint defaults to false", () => {
		expect(qualitySettingsSchema.parse({}).smartEndpoint).toBe(false);
	});

	test("realtimeProcessingPause defaults to 0.02", () => {
		expect(qualitySettingsSchema.parse({}).realtimeProcessingPause).toBe(0.02);
	});

	test("initRealtimeAfterSeconds defaults to 0.2", () => {
		expect(qualitySettingsSchema.parse({}).initRealtimeAfterSeconds).toBe(0.2);
	});

	test("earlyTranscriptionOnSilence defaults to 0.2", () => {
		expect(qualitySettingsSchema.parse({}).earlyTranscriptionOnSilence).toBe(0.2);
	});

	test("batchSize and realtimeBatchSize default to 16", () => {
		const out = qualitySettingsSchema.parse({});
		expect(out.batchSize).toBe(16);
		expect(out.realtimeBatchSize).toBe(16);
	});

	test("smartEndpointSpeed defaults to 1.5", () => {
		expect(qualitySettingsSchema.parse({}).smartEndpointSpeed).toBe(1.5);
	});
});

describe("audioSettingsSchema defaults (lock-down)", () => {
	test("sampleRate defaults to 16000", () => {
		expect(audioSettingsSchema.parse({}).sampleRate).toBe(16_000);
	});

	test("bufferSize defaults to 512", () => {
		expect(audioSettingsSchema.parse({}).bufferSize).toBe(512);
	});

	test("sileroSensitivity defaults to 0.4", () => {
		expect(audioSettingsSchema.parse({}).sileroSensitivity).toBe(0.4);
	});

	test("sileroUseOnnx defaults to false", () => {
		expect(audioSettingsSchema.parse({}).sileroUseOnnx).toBe(false);
	});

	test("sileroDeactivityDetection defaults to true", () => {
		expect(audioSettingsSchema.parse({}).sileroDeactivityDetection).toBe(true);
	});

	test("webrtcSensitivity defaults to 3", () => {
		expect(audioSettingsSchema.parse({}).webrtcSensitivity).toBe(3);
	});

	test("postSpeechSilenceDuration defaults to 0.7", () => {
		expect(audioSettingsSchema.parse({}).postSpeechSilenceDuration).toBe(0.7);
	});

	test("minLengthOfRecording defaults to 1.1", () => {
		expect(audioSettingsSchema.parse({}).minLengthOfRecording).toBe(1.1);
	});

	test("minGapBetweenRecordings defaults to 0", () => {
		expect(audioSettingsSchema.parse({}).minGapBetweenRecordings).toBe(0);
	});

	test("preRecordingBufferDuration defaults to 1.0", () => {
		expect(audioSettingsSchema.parse({}).preRecordingBufferDuration).toBe(1.0);
	});
});

describe("generalSettingsSchema defaults (lock-down)", () => {
	test("autoStart defaults to false", () => {
		expect(generalSettingsSchema.parse({}).autoStart).toBe(false);
	});

	test("minimizeToTray defaults to true", () => {
		expect(generalSettingsSchema.parse({}).minimizeToTray).toBe(true);
	});

	test("startMinimized defaults to false", () => {
		expect(generalSettingsSchema.parse({}).startMinimized).toBe(false);
	});

	test("systemAudioReductionWhileDictating defaults to 0 (off)", () => {
		expect(generalSettingsSchema.parse({}).systemAudioReductionWhileDictating).toBe(0);
	});

	test("systemAudioReductionWhileDictating accepts an in-range percent", () => {
		expect(
			generalSettingsSchema.parse({ systemAudioReductionWhileDictating: 80 })
				.systemAudioReductionWhileDictating
		).toBe(80);
	});

	test("systemAudioReductionWhileDictating falls back to 0 on out-of-range / bad input", () => {
		expect(
			generalSettingsSchema.parse({ systemAudioReductionWhileDictating: 999 })
				.systemAudioReductionWhileDictating
		).toBe(0);
		expect(
			generalSettingsSchema.parse({ systemAudioReductionWhileDictating: "nope" })
				.systemAudioReductionWhileDictating
		).toBe(0);
	});

	test("recordingSound defaults to true", () => {
		expect(generalSettingsSchema.parse({}).recordingSound).toBe(true);
	});

	test("recordingSoundPath defaults to empty string", () => {
		expect(generalSettingsSchema.parse({}).recordingSoundPath).toBe("");
	});

	test("fileTranscriptionFormat enum accepts both 'txt' and 'srt' as INPUT (not just default)", () => {
		// Pass 'txt'/'srt' explicitly so the enum gating fires (Zod's default
		// does NOT validate the default against the enum, so passing nothing
		// would let mutated enum literals slip through).
		expect(
			generalSettingsSchema.parse({ fileTranscriptionFormat: "txt" }).fileTranscriptionFormat
		).toBe("txt");
		expect(
			generalSettingsSchema.parse({ fileTranscriptionFormat: "srt" }).fileTranscriptionFormat
		).toBe("srt");
	});

	test("fileTranscriptionSaveLocation enum accepts 'auto' and 'ask' as INPUT", () => {
		expect(
			generalSettingsSchema.parse({ fileTranscriptionSaveLocation: "auto" })
				.fileTranscriptionSaveLocation
		).toBe("auto");
		expect(
			generalSettingsSchema.parse({ fileTranscriptionSaveLocation: "ask" })
				.fileTranscriptionSaveLocation
		).toBe("ask");
	});

	test("fileTranscriptionSaveLocation rejects empty string", () => {
		expect(() => generalSettingsSchema.parse({ fileTranscriptionSaveLocation: "" })).toThrow();
	});

	test("recordingMode enum accepts ptt/toggle/listen", () => {
		expect(generalSettingsSchema.parse({ recordingMode: "ptt" }).recordingMode).toBe("ptt");
		expect(generalSettingsSchema.parse({ recordingMode: "toggle" }).recordingMode).toBe("toggle");
		expect(generalSettingsSchema.parse({ recordingMode: "listen" }).recordingMode).toBe("listen");
	});

	test("loopbackDeviceIndex defaults to null", () => {
		expect(generalSettingsSchema.parse({}).loopbackDeviceIndex).toBeNull();
	});

	test("showRecordingOverlay defaults to true", () => {
		expect(generalSettingsSchema.parse({}).showRecordingOverlay).toBe(true);
	});

	test("liveTranscriptionDisplay defaults to 'both'", () => {
		expect(generalSettingsSchema.parse({}).liveTranscriptionDisplay).toBe("both");
	});

	test("liveTranscriptionDisplay accepts each canonical option", () => {
		for (const v of ["none", "in-app", "in-pill", "both"] as const) {
			expect(
				generalSettingsSchema.parse({ liveTranscriptionDisplay: v }).liveTranscriptionDisplay
			).toBe(v);
		}
	});

	test("liveTranscriptionDisplay falls back to 'both' for unknown values (catch)", () => {
		// `.catch("both")` keeps a stale persisted value (e.g. a leftover boolean
		// from the pre-v6 schema) from wiping the rest of the general section.
		expect(
			generalSettingsSchema.parse({ liveTranscriptionDisplay: "garbage" }).liveTranscriptionDisplay
		).toBe("both");
	});

	test("visualizerType enum accepts each canonical type", () => {
		for (const t of ["bar", "grid", "radial", "wave", "aura"] as const) {
			expect(generalSettingsSchema.parse({ visualizerType: t }).visualizerType).toBe(t);
		}
	});

	test("visualizerType defaults to 'bar'", () => {
		expect(generalSettingsSchema.parse({}).visualizerType).toBe("bar");
	});

	test("visualizerColor defaults to '#58a6ff'", () => {
		expect(generalSettingsSchema.parse({}).visualizerColor).toBe("#58a6ff");
	});

	test("visualizerColor regex requires both leading # AND trailing $ anchors", () => {
		// Locks down both `^` and `$` anchors of the color regex /^#[0-9a-fA-F]{6}$/.
		// Mutants drop the `^` (allowing prefixes like "x#abcdef") or drop the `$`
		// (allowing suffixes like "#abcdef-extra").
		expect(() => generalSettingsSchema.parse({ visualizerColor: "x#abcdef" })).toThrow();
		expect(() => generalSettingsSchema.parse({ visualizerColor: "#abcdef-extra" })).toThrow();
	});
});

describe("hotkeySettingsSchema (lock-down)", () => {
	test("default 'LCtrl+LMeta' is preserved when no input", () => {
		expect(hotkeySettingsSchema.parse({}).pushToTalkKey).toBe("LCtrl+LMeta");
	});
});

describe("dictionaryEntrySchema enforces min(1)", () => {
	test("rejects empty id (kills L79 min(1) -> max(1) mutation)", () => {
		expect(() => dictionaryEntrySchema.parse({ id: "", find: "a", replace: "b" })).toThrow();
	});

	test("rejects empty find (kills L80 min(1) mutation)", () => {
		expect(() => dictionaryEntrySchema.parse({ id: "1", find: "", replace: "b" })).toThrow();
	});

	test("rejects empty replace (kills L81 min(1) mutation)", () => {
		expect(() => dictionaryEntrySchema.parse({ id: "1", find: "a", replace: "" })).toThrow();
	});

	test("accepts a single character for each min(1) field", () => {
		// Locks the boundary — min(1) allows length=1, max(1) would fail
		// here for any length>=2 we test elsewhere.
		const out = dictionaryEntrySchema.parse({ id: "x", find: "a", replace: "b" });
		expect(out.id).toBe("x");
		expect(out.find).toBe("a");
		expect(out.replace).toBe("b");
	});

	test("error message for empty find reads 'Required' (kills L80 string mutation)", () => {
		// Locks the literal "Required" used as the min(1) custom error message.
		// Mutating to "" would surface a blank validation error to the UI.
		try {
			dictionaryEntrySchema.parse({ id: "1", find: "", replace: "b" });
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues = (e as { issues?: Array<{ message: string }> }).issues ?? [];
			expect(issues.some((i) => i.message === "Required")).toBe(true);
		}
	});

	test("error message for empty replace reads 'Required' (kills L81 string mutation)", () => {
		try {
			dictionaryEntrySchema.parse({ id: "1", find: "a", replace: "" });
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues = (e as { issues?: Array<{ message: string }> }).issues ?? [];
			expect(issues.some((i) => i.message === "Required")).toBe(true);
		}
	});
});

describe("addDictionaryEntrySchema enforces min(1) on trim()'d input", () => {
	test("rejects empty find after trim", () => {
		expect(() =>
			addDictionaryEntrySchema.parse({
				find: "",
				replace: "x",
				caseSensitive: false,
				wholeWord: false,
			})
		).toThrow();
	});

	test("rejects empty replace after trim", () => {
		expect(() =>
			addDictionaryEntrySchema.parse({
				find: "x",
				replace: "",
				caseSensitive: false,
				wholeWord: false,
			})
		).toThrow();
	});

	test("error message for empty find/replace reads 'Required' (locks L87/L88 strings)", () => {
		try {
			addDictionaryEntrySchema.parse({
				find: "  ",
				replace: "  ",
				caseSensitive: false,
				wholeWord: false,
			});
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues = (e as { issues?: Array<{ message: string; path: unknown[] }> }).issues ?? [];
			const findIssue = issues.find((i) => i.path[0] === "find");
			const replaceIssue = issues.find((i) => i.path[0] === "replace");
			expect(findIssue?.message).toBe("Required");
			expect(replaceIssue?.message).toBe("Required");
		}
	});
});

describe("snippetEntrySchema enforces min(1)", () => {
	test("rejects empty id", () => {
		expect(() => snippetEntrySchema.parse({ id: "", trigger: "/x", expansion: "X" })).toThrow();
	});

	test("rejects empty trigger", () => {
		expect(() => snippetEntrySchema.parse({ id: "1", trigger: "", expansion: "X" })).toThrow();
	});

	test("rejects empty expansion", () => {
		expect(() => snippetEntrySchema.parse({ id: "1", trigger: "/x", expansion: "" })).toThrow();
	});

	test("error message reads 'Required' for empty trigger/expansion (locks L96/L97)", () => {
		try {
			snippetEntrySchema.parse({ id: "1", trigger: "", expansion: "" });
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues = (e as { issues?: Array<{ message: string; path: unknown[] }> }).issues ?? [];
			expect(issues.find((i) => i.path[0] === "trigger")?.message).toBe("Required");
			expect(issues.find((i) => i.path[0] === "expansion")?.message).toBe("Required");
		}
	});
});

describe("addSnippetEntrySchema trims and rejects whitespace-only", () => {
	test("rejects whitespace-only trigger", () => {
		expect(() => addSnippetEntrySchema.parse({ trigger: "   ", expansion: "X" })).toThrow();
	});

	test("rejects whitespace-only expansion", () => {
		expect(() => addSnippetEntrySchema.parse({ trigger: "/x", expansion: "   " })).toThrow();
	});

	test("error message reads 'Required' for whitespace-only input (locks L101/L102)", () => {
		try {
			addSnippetEntrySchema.parse({ trigger: "  ", expansion: "  " });
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues = (e as { issues?: Array<{ message: string; path: unknown[] }> }).issues ?? [];
			expect(issues.find((i) => i.path[0] === "trigger")?.message).toBe("Required");
			expect(issues.find((i) => i.path[0] === "expansion")?.message).toBe("Required");
		}
	});
});

describe("llmSettingsSchema defaults (lock-down)", () => {
	test("enabled defaults to false", () => {
		expect(llmSettingsSchema.parse({}).enabled).toBe(false);
	});

	test("provider enum accepts both 'ollama' and 'openrouter'", () => {
		expect(llmSettingsSchema.parse({}).provider).toBe("ollama");
		expect(llmSettingsSchema.parse({ provider: "openrouter" }).provider).toBe("openrouter");
	});

	test("provider rejects empty string", () => {
		expect(() => llmSettingsSchema.parse({ provider: "" })).toThrow();
	});

	test("endpoint defaults to http://localhost:11434", () => {
		expect(llmSettingsSchema.parse({}).endpoint).toBe("http://localhost:11434");
	});

	test("model, openrouter*, default to empty strings", () => {
		const out = llmSettingsSchema.parse({});
		expect(out.model).toBe("");
		expect(out.openrouterApiKey).toBe("");
		expect(out.openrouterModel).toBe("");
		expect(out.openrouterFallbackModel).toBe("");
	});

	test("presets enum accepts each of the ten canonical preset keys", () => {
		for (const p of [
			"neutral",
			"formal",
			"friendly",
			"technical",
			"casual",
			"concise",
			"summarize",
			"reorder",
			"restructure",
			"rewordForClarity",
		] as const) {
			expect(llmSettingsSchema.parse({ presets: [{ key: p }] }).presets).toEqual([{ key: p }]);
		}
	});

	test("presets rejects empty key", () => {
		expect(() => llmSettingsSchema.parse({ presets: [{ key: "" }] })).toThrow();
	});

	test("presets rejects two tone keys together", () => {
		expect(() =>
			llmSettingsSchema.parse({
				presets: [{ key: "formal" }, { key: "casual" }],
			})
		).toThrow();
	});

	test("presets rejects level on a preset that does not support levels", () => {
		expect(() =>
			llmSettingsSchema.parse({
				presets: [{ key: "neutral", level: "high" }],
			})
		).toThrow();
	});

	test("timeout defaults to 5000", () => {
		expect(llmSettingsSchema.parse({}).timeout).toBe(5000);
	});

	test("transforms default seeds from BUILTIN_TRANSFORMS, preserving order and values", () => {
		// Locks the L204 `.default([...BUILTIN_TRANSFORMS])` shape. The default
		// flows through `z.array(transformSchema)`, so each transform's own
		// `.default("")` / `.default(false)` fills in any optional fields.
		// We assert the full output equals the seeded built-ins after parsing —
		// any mutation that drops the spread or swaps the source array would
		// either change the count, the order, or the canonical field values.
		const out = llmSettingsSchema.parse({}).transforms;
		expect(out).toHaveLength(BUILTIN_TRANSFORMS.length);
		expect(out).toEqual(BUILTIN_TRANSFORMS.map((t) => transformSchema.parse(t)));
		// Re-assert the canonical built-in ids so the test fails closed if
		// someone reorders or renames an entry in BUILTIN_TRANSFORMS without
		// updating the rest of the codebase.
		expect(out.map((t) => t.id)).toEqual(["polish", "prompt-engineer"]);
		// Every default-seeded transform must report builtin: true so the UI
		// can hide the delete affordance.
		for (const t of out) {
			expect(t.builtin).toBe(true);
			expect(t.hotkey).toBe("");
			expect(typeof t.prompt).toBe("string");
			expect(t.prompt.length).toBeGreaterThan(0);
		}
	});

	test("transforms default is a fresh array each parse — mutating one parse leaves the next intact", () => {
		// Locks the L204 `[...BUILTIN_TRANSFORMS]` spread. Without it, every
		// parse would share the same array reference and consumers that mutate
		// (e.g. push a user-added transform) would leak across `parse({})`
		// calls, corrupting the default for the next reader.
		const a = llmSettingsSchema.parse({}).transforms;
		a.push({
			id: "leak",
			name: "leak",
			prompt: "",
			hotkey: "",
			builtin: false,
		});
		const b = llmSettingsSchema.parse({}).transforms;
		expect(b).toHaveLength(BUILTIN_TRANSFORMS.length);
		expect(b.find((t) => t.id === "leak")).toBeUndefined();
	});

	test("explicit transforms input is honoured (no double-defaulting)", () => {
		// Locks the L204 contract: passing transforms explicitly bypasses the
		// default but still flows through transformSchema (so each entry's
		// optional fields get their per-field defaults).
		const out = llmSettingsSchema.parse({
			transforms: [{ id: "custom", name: "Custom" }],
		}).transforms;
		expect(out).toEqual([{ id: "custom", name: "Custom", prompt: "", hotkey: "", builtin: false }]);
	});

	test("BUILTIN_TRANSFORMS entries each parse cleanly through transformSchema", () => {
		// Lock-down for the L175 BUILTIN_TRANSFORMS shape: if anyone shortens
		// `id`/`name` to "" or drops the `prompt` body, transformSchema
		// (.min(1) on id/name) will reject it here.
		for (const t of BUILTIN_TRANSFORMS) {
			const parsed = transformSchema.parse(t);
			expect(parsed.id).toBe(t.id);
			expect(parsed.name).toBe(t.name);
			expect(parsed.builtin).toBe(true);
		}
	});
});

describe("explicit parse-time validation (kills `.default()` mutations that bypass enum validation)", () => {
	test("beamSizeRealtime enforces min(1) — explicit value 3 accepted, 0 rejected", () => {
		// Locks `.min(1)` against `.max(1)` mutation on L15. With max(1), 3 would
		// fail; with min(1), 0 fails and 3 passes.
		expect(modelSettingsSchema.parse({ beamSizeRealtime: 1 }).beamSizeRealtime).toBe(1);
		expect(modelSettingsSchema.parse({ beamSizeRealtime: 3 }).beamSizeRealtime).toBe(3);
		expect(() => modelSettingsSchema.parse({ beamSizeRealtime: 0 })).toThrow();
		expect(() => modelSettingsSchema.parse({ beamSizeRealtime: -1 })).toThrow();
	});

	test("fileTranscriptionFormat default('txt') is exactly 'txt' (not '')", () => {
		// Locks `.default("txt")` on L55. Zod's `.default()` does NOT validate
		// the default against the enum, so a mutation to `.default("")` would
		// silently produce "" without throwing — only a strict equality check
		// catches it.
		const out = generalSettingsSchema.parse({});
		expect(out.fileTranscriptionFormat).toBe("txt");
		expect(out.fileTranscriptionFormat.length).toBeGreaterThan(0);
	});

	test("fileTranscriptionSaveLocation default('auto') is exactly 'auto' (not '')", () => {
		// Locks `.default("auto")` on L56. Same Zod default-bypass concern as
		// fileTranscriptionFormat.
		const out = generalSettingsSchema.parse({});
		expect(out.fileTranscriptionSaveLocation).toBe("auto");
		expect(out.fileTranscriptionSaveLocation.length).toBeGreaterThan(0);
	});

	test("visualizerSize default('xs') is exactly 'xs' (not '')", () => {
		// Locks `.default("xs")` on L63. The schema also has `.catch("xs")`,
		// but defaults run BEFORE catch, so a mutated default of "" would
		// surface as "" (the empty string is a valid output of default()).
		const out = generalSettingsSchema.parse({});
		expect(out.visualizerSize).toBe("xs");
		expect(out.visualizerSize.length).toBeGreaterThan(0);
	});

	test("visualizerSize enum first member is 'xs' — empty string falls back via .catch()", () => {
		// Locks the L63 first enum literal `"xs"` against StringLiteral mutation
		// to `""`. With the mutation, the enum becomes ["", "sm", ...] and
		// parsing visualizerSize: "" would PASS the enum and return "" — but
		// with the original enum, "" fails enum and `.catch("xs")` rescues it.
		expect(generalSettingsSchema.parse({ visualizerSize: "" }).visualizerSize).toBe("xs");
	});

	test("visualizerSize default literal is 'xs' — explicit 'xs' enum membership round-trips", () => {
		// Locks the L63 second `"xs"` (the default arg) AND first enum literal
		// against StringLiteral mutations. We assert that 'xs' is valid input
		// (so enum still contains "xs") AND that no input yields "xs".
		expect(generalSettingsSchema.parse({ visualizerSize: "xs" }).visualizerSize).toBe("xs");
		expect(generalSettingsSchema.parse({}).visualizerSize).toBe("xs");
	});

	test("llm presets default is [{key:'neutral'}]", () => {
		const out = llmSettingsSchema.parse({});
		expect(out.presets).toEqual([{ key: "neutral" }]);
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
