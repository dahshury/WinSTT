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
	ttsSettingsSchema,
} from "./settings-schema";

describe("modelSettingsSchema defaults", () => {
	test("produces all defaults from empty input", () => {
		const out = modelSettingsSchema.parse({});
		expect(out.model).toBe("tiny");
		expect(out.realtimeModel).toBe("tiny");
		expect(out.language).toBe("en");
		expect(out.autoDetectLanguage).toBe(false);
		expect(out.languageCandidates).toEqual([]);
		expect(out.device).toBe("auto");
		expect(out.backend).toBe("faster_whisper");
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
		expect(
			modelSettingsSchema.parse({ backend: "faster_whisper" }).backend,
		).toBe("faster_whisper");
		expect(modelSettingsSchema.parse({ backend: "onnx_asr" }).backend).toBe(
			"onnx_asr",
		);
	});

	test("backend enum rejects empty string", () => {
		expect(() => modelSettingsSchema.parse({ backend: "" })).toThrow();
	});

	test("onnxQuantization defaults to 'auto' (RAM/VRAM-aware recommended precision)", () => {
		// Locks the `default("auto")` for onnxQuantization. "auto" resolves to
		// the hardware-aware recommended precision (fit_aware_auto_quant); ""
		// now means EXPLICIT fp32, not "auto". Mutating this default would
		// surface a stale value to consumers.
		expect(modelSettingsSchema.parse({}).onnxQuantization).toBe("auto");
	});

	test("initialPrompt and initialPromptRealtime default to empty strings", () => {
		const out = modelSettingsSchema.parse({});
		expect(out.initialPrompt).toBe("");
		expect(out.initialPromptRealtime).toBe("");
	});

	test("does not expose the unload timeout as a model-scoped setting", () => {
		const out = modelSettingsSchema.parse({ modelUnloadTimeout: "hour1" });
		expect("modelUnloadTimeout" in out).toBe(false);
	});
});

describe("global model lifetime settings", () => {
	test("defaults the shared unload timeout to 15 minutes", () => {
		const out = appSettingsSchema.parse({});
		expect(
			(out as { global?: { modelUnloadTimeout?: string } }).global
				?.modelUnloadTimeout,
		).toBe("min15");
	});

	test("migrates legacy model.modelUnloadTimeout into the global section", () => {
		const out = appSettingsSchema.parse({
			model: { modelUnloadTimeout: "hour1" },
		});
		expect(
			(out as { global?: { modelUnloadTimeout?: string } }).global
				?.modelUnloadTimeout,
		).toBe("hour1");
		expect("modelUnloadTimeout" in out.model).toBe(false);
	});
});

describe("audioSettingsSchema bounds", () => {
	test("clamps allowed sileroSensitivity range [0,1]", () => {
		const ok = audioSettingsSchema.parse({ sileroSensitivity: 0.5 });
		expect(ok.sileroSensitivity).toBe(0.5);
		expect(() =>
			audioSettingsSchema.parse({ sileroSensitivity: 1.5 }),
		).toThrow();
		expect(() =>
			audioSettingsSchema.parse({ sileroSensitivity: -0.1 }),
		).toThrow();
	});

	test("clamps allowed webrtcSensitivity range [0,3]", () => {
		expect(
			audioSettingsSchema.parse({ webrtcSensitivity: 0 }).webrtcSensitivity,
		).toBe(0);
		expect(
			audioSettingsSchema.parse({ webrtcSensitivity: 3 }).webrtcSensitivity,
		).toBe(3);
		expect(() => audioSettingsSchema.parse({ webrtcSensitivity: 4 })).toThrow();
	});

	test("inputDeviceIndex accepts null", () => {
		expect(
			audioSettingsSchema.parse({ inputDeviceIndex: null }).inputDeviceIndex,
		).toBeNull();
	});
});

describe("qualitySettingsSchema", () => {
	test("smartEndpointSpeed bounded [0.5, 3.0]", () => {
		expect(
			qualitySettingsSchema.parse({ smartEndpointSpeed: 1 }).smartEndpointSpeed,
		).toBe(1);
		expect(() =>
			qualitySettingsSchema.parse({ smartEndpointSpeed: 0.4 }),
		).toThrow();
		expect(() =>
			qualitySettingsSchema.parse({ smartEndpointSpeed: 3.5 }),
		).toThrow();
	});

	test("realtime defaults align with PTT mode", () => {
		const out = qualitySettingsSchema.parse({});
		expect(out.useMainModelForRealtime).toBe(false);
	});
});

describe("generalSettingsSchema", () => {
	test("recordingMode defaults to ptt", () => {
		expect(generalSettingsSchema.parse({}).recordingMode).toBe("ptt");
	});

	test("rejects invalid recordingMode", () => {
		expect(() =>
			generalSettingsSchema.parse({ recordingMode: "scream" }),
		).toThrow();
	});

	test("repasteHotkey defaults to LCtrl+LShift+V", () => {
		expect(generalSettingsSchema.parse({}).repasteHotkey).toBe(
			"LCtrl+LShift+V",
		);
	});

	test("repasteHotkey rejects empty input but rescues via .catch() to default", () => {
		// Empty would silently disable the re-paste shortcut and bypass the
		// conflict detector — both undesirable. `.min(1).catch(default)`
		// rehydrates corrupt persisted state instead of throwing.
		expect(
			generalSettingsSchema.parse({ repasteHotkey: "" }).repasteHotkey,
		).toBe("LCtrl+LShift+V");
	});

	test("repasteHotkey accepts a valid combo verbatim", () => {
		expect(
			generalSettingsSchema.parse({ repasteHotkey: "LCtrl+LAlt+R" })
				.repasteHotkey,
		).toBe("LCtrl+LAlt+R");
	});

	test("visualizerSize falls back to 'xs' for legacy integer values via .catch()", () => {
		// Old persisted format: a numeric pixel — schema should swallow and emit 'xs'
		const out = generalSettingsSchema.parse({ visualizerSize: 24 });
		expect(out.visualizerSize).toBe("xs");
	});

	test("visualizerSize accepts the canonical enum values", () => {
		for (const size of ["xs", "sm", "md", "lg", "xl"] as const) {
			expect(
				generalSettingsSchema.parse({ visualizerSize: size }).visualizerSize,
			).toBe(size);
		}
	});

	test("visualizerBarCount bounded [3, 21]", () => {
		expect(
			generalSettingsSchema.parse({ visualizerBarCount: 3 }).visualizerBarCount,
		).toBe(3);
		expect(
			generalSettingsSchema.parse({ visualizerBarCount: 21 })
				.visualizerBarCount,
		).toBe(21);
	});

	test("visualizerBarCount falls back to default on out-of-range stale value", () => {
		// An earlier slider bug persisted out-of-range values like 22. Without
		// `.catch(9)`, parsing them would throw and `decodeSettingsPayload`
		// would wipe the entire settings object back to defaults.
		expect(
			generalSettingsSchema.parse({ visualizerBarCount: 22 })
				.visualizerBarCount,
		).toBe(9);
		expect(
			generalSettingsSchema.parse({ visualizerBarCount: 2 }).visualizerBarCount,
		).toBe(9);
	});

	test("rejects invalid fileTranscriptionFormat", () => {
		expect(() =>
			generalSettingsSchema.parse({ fileTranscriptionFormat: "pdf" }),
		).toThrow();
	});

	test("context app mode defaults to the legacy deny-list behavior", () => {
		expect(generalSettingsSchema.parse({}).contextAppMode).toBe(
			"all-except-denied",
		);
		expect(
			generalSettingsSchema.parse({ contextAppMode: "selected-only" })
				.contextAppMode,
		).toBe("selected-only");
		expect(
			generalSettingsSchema.parse({ contextAppMode: "everything" })
				.contextAppMode,
		).toBe("all-except-denied");
	});
});

describe("hotkeySettingsSchema", () => {
	test("default is LCtrl+LMeta", () => {
		// `LCtrl+LMeta` (Ctrl+Win) is the original WinSTT PTT default. The Win key
		// is disguised at the hook level so it doesn't pop the Start menu (see
		// shortcut/handy_keys.rs); press/release dispatch normally.
		expect(hotkeySettingsSchema.parse({}).pushToTalkKey).toBe("LCtrl+LMeta");
	});

	test("rescues empty pushToTalkKey via .catch() to default", () => {
		// `.min(1)` would throw on empty input; `.catch()` swallows the failure
		// and reverts to the documented default. Without the catch, a single
		// bad row in settings.json would wipe the entire `hotkey` section.
		expect(
			hotkeySettingsSchema.parse({ pushToTalkKey: "" }).pushToTalkKey,
		).toBe("LCtrl+LMeta");
	});
});

describe("dictionary & snippet schemas", () => {
	test("dictionaryEntrySchema requires id and term", () => {
		const ok = dictionaryEntrySchema.parse({ id: "1", term: "Kubernetes" });
		expect(ok).toEqual({ id: "1", term: "Kubernetes" });
		const auto = dictionaryEntrySchema.parse({
			id: "2",
			term: "WinSTT",
			autoAdded: true,
		});
		expect(auto.autoAdded).toBe(true);
		expect(() =>
			dictionaryEntrySchema.parse({ id: "", term: "Kubernetes" }),
		).toThrow();
		expect(() => dictionaryEntrySchema.parse({ id: "1", term: "" })).toThrow();
	});

	test("addDictionaryEntrySchema trims whitespace and rejects blank input", () => {
		const ok = addDictionaryEntrySchema.parse({ term: "  Kubernetes  " });
		expect(ok.term).toBe("Kubernetes");
		expect(() => addDictionaryEntrySchema.parse({ term: "   " })).toThrow();
	});

	test("snippet schemas behave similarly", () => {
		expect(
			snippetEntrySchema.parse({ id: "1", trigger: "/x", expansion: "X" }),
		).toEqual({
			id: "1",
			trigger: "/x",
			expansion: "X",
		});
		const out = addSnippetEntrySchema.parse({
			trigger: "  /x ",
			expansion: " X ",
		});
		expect(out.trigger).toBe("/x");
		expect(out.expansion).toBe("X");
	});
});

describe("llmSettingsSchema", () => {
	test("endpoint must be a URL", () => {
		expect(() => llmSettingsSchema.parse({ endpoint: "not a url" })).toThrow();
	});

	test("dictation.presets must contain known preset keys", () => {
		expect(
			llmSettingsSchema.parse({
				dictation: { presets: [{ key: "neutral" as const }] },
			}).dictation.presets,
		).toEqual([{ key: "neutral" }]);
		expect(() =>
			llmSettingsSchema.parse({ dictation: { presets: [{ key: "spicy" }] } }),
		).toThrow();
	});

	test("dictation.provider must be ollama or openrouter", () => {
		expect(() =>
			llmSettingsSchema.parse({ dictation: { provider: "openai" } }),
		).toThrow();
	});

	test("transforms.provider must be ollama or openrouter", () => {
		expect(() =>
			llmSettingsSchema.parse({ transforms: { provider: "openai" } }),
		).toThrow();
	});
});

describe("qualitySettingsSchema defaults (lock-down)", () => {
	test("smartEndpoint defaults to true", () => {
		expect(qualitySettingsSchema.parse({}).smartEndpoint).toBe(true);
	});

	test("unknownSentenceDetectionPause defaults to 1.3", () => {
		expect(qualitySettingsSchema.parse({}).unknownSentenceDetectionPause).toBe(
			1.3,
		);
	});

	test("realtimeProcessingPause defaults to 0.02", () => {
		expect(qualitySettingsSchema.parse({}).realtimeProcessingPause).toBe(0.02);
	});

	test("initRealtimeAfterSeconds defaults to 0.2", () => {
		expect(qualitySettingsSchema.parse({}).initRealtimeAfterSeconds).toBe(0.2);
	});

	test("earlyTranscriptionOnSilence defaults to 0.2", () => {
		expect(qualitySettingsSchema.parse({}).earlyTranscriptionOnSilence).toBe(
			0.2,
		);
	});

	test("smartEndpointSpeed defaults to 2.0 (matches RealtimeSTT reference)", () => {
		expect(qualitySettingsSchema.parse({}).smartEndpointSpeed).toBe(2.0);
	});
});

describe("audioSettingsSchema defaults (lock-down)", () => {
	test("sampleRate defaults to 16000", () => {
		expect(audioSettingsSchema.parse({}).sampleRate).toBe(16_000);
	});

	test("bufferSize defaults to 512", () => {
		expect(audioSettingsSchema.parse({}).bufferSize).toBe(512);
	});

	test("sileroSensitivity defaults to 0.7 (trip threshold 0.3)", () => {
		expect(audioSettingsSchema.parse({}).sileroSensitivity).toBe(0.7);
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

	test("sendCrashReports defaults to true (opt-out model)", () => {
		expect(generalSettingsSchema.parse({}).sendCrashReports).toBe(true);
	});

	test("systemAudioReductionWhileDictating defaults to 60 (percent reduction)", () => {
		expect(
			generalSettingsSchema.parse({}).systemAudioReductionWhileDictating,
		).toBe(60);
	});

	test("systemAudioReductionWhileDictating accepts an in-range percent", () => {
		expect(
			generalSettingsSchema.parse({ systemAudioReductionWhileDictating: 80 })
				.systemAudioReductionWhileDictating,
		).toBe(80);
	});

	test("systemAudioReductionWhileDictating falls back to 60 on out-of-range / bad input", () => {
		// `.catch(60)` rehydrates a corrupt/out-of-range persisted value to the
		// default instead of failing the whole `general` parse.
		expect(
			generalSettingsSchema.parse({ systemAudioReductionWhileDictating: 999 })
				.systemAudioReductionWhileDictating,
		).toBe(60);
		expect(
			generalSettingsSchema.parse({
				systemAudioReductionWhileDictating: "nope",
			}).systemAudioReductionWhileDictating,
		).toBe(60);
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
			generalSettingsSchema.parse({ fileTranscriptionFormat: "txt" })
				.fileTranscriptionFormat,
		).toBe("txt");
		expect(
			generalSettingsSchema.parse({ fileTranscriptionFormat: "srt" })
				.fileTranscriptionFormat,
		).toBe("srt");
	});

	test("fileTranscriptionSaveLocation enum accepts 'auto' and 'ask' as INPUT", () => {
		expect(
			generalSettingsSchema.parse({ fileTranscriptionSaveLocation: "auto" })
				.fileTranscriptionSaveLocation,
		).toBe("auto");
		expect(
			generalSettingsSchema.parse({ fileTranscriptionSaveLocation: "ask" })
				.fileTranscriptionSaveLocation,
		).toBe("ask");
	});

	test("fileTranscriptionSaveLocation rejects empty string", () => {
		expect(() =>
			generalSettingsSchema.parse({ fileTranscriptionSaveLocation: "" }),
		).toThrow();
	});

	test("recordingMode enum accepts ptt/toggle/listen", () => {
		expect(
			generalSettingsSchema.parse({ recordingMode: "ptt" }).recordingMode,
		).toBe("ptt");
		expect(
			generalSettingsSchema.parse({ recordingMode: "toggle" }).recordingMode,
		).toBe("toggle");
		expect(
			generalSettingsSchema.parse({ recordingMode: "listen" }).recordingMode,
		).toBe("listen");
	});

	test("customWakeWords defaults to an empty saved custom phrase list", () => {
		expect(generalSettingsSchema.parse({}).customWakeWords).toEqual([]);
		expect(
			generalSettingsSchema.parse({ customWakeWords: ["hey codex"] })
				.customWakeWords,
		).toEqual(["hey codex"]);
	});

	test("loopbackDeviceIndex defaults to null", () => {
		expect(generalSettingsSchema.parse({}).loopbackDeviceIndex).toBeNull();
	});

	test("showRecordingOverlay defaults to true", () => {
		expect(generalSettingsSchema.parse({}).showRecordingOverlay).toBe(true);
	});

	test("overlayMode defaults to dynamic-island", () => {
		expect(generalSettingsSchema.parse({}).overlayMode).toBe("dynamic-island");
	});

	test("overlayMode accepts both layout options", () => {
		for (const mode of ["floating-bottom", "dynamic-island"] as const) {
			expect(
				generalSettingsSchema.parse({ overlayMode: mode }).overlayMode,
			).toBe(mode);
		}
	});

	test("overlayMode falls back to dynamic-island for unknown values (catch)", () => {
		expect(
			generalSettingsSchema.parse({ overlayMode: "floating-parapet" })
				.overlayMode,
		).toBe("dynamic-island");
	});

	test("liveTranscriptionDisplay defaults to 'both'", () => {
		expect(generalSettingsSchema.parse({}).liveTranscriptionDisplay).toBe(
			"both",
		);
	});

	test("liveTranscriptionDisplay accepts each canonical option", () => {
		for (const v of ["none", "in-app", "in-pill", "both"] as const) {
			expect(
				generalSettingsSchema.parse({ liveTranscriptionDisplay: v })
					.liveTranscriptionDisplay,
			).toBe(v);
		}
	});

	test("liveTranscriptionDisplay falls back to 'both' for unknown values (catch)", () => {
		// `.catch("both")` keeps a stale persisted value (e.g. a leftover boolean
		// from the pre-v6 schema) from wiping the rest of the general section.
		expect(
			generalSettingsSchema.parse({ liveTranscriptionDisplay: "garbage" })
				.liveTranscriptionDisplay,
		).toBe("both");
	});

	test("wordByWordPasting defaults off and rescues corrupt values", () => {
		expect(generalSettingsSchema.parse({}).wordByWordPasting).toBe(false);
		expect(
			generalSettingsSchema.parse({ wordByWordPasting: true })
				.wordByWordPasting,
		).toBe(true);
		expect(
			generalSettingsSchema.parse({ wordByWordPasting: "yes" })
				.wordByWordPasting,
		).toBe(false);
	});

	test("context allow-list defaults to empty and rescues corrupt values", () => {
		expect(generalSettingsSchema.parse({}).contextAllowList).toEqual([]);
		expect(
			generalSettingsSchema.parse({ contextAllowList: ["chrome.exe"] })
				.contextAllowList,
		).toEqual(["chrome.exe"]);
		expect(
			generalSettingsSchema.parse({ contextAllowList: "chrome.exe" })
				.contextAllowList,
		).toEqual([]);
	});

	test("visualizerType enum accepts each canonical type", () => {
		for (const t of ["bar", "grid", "radial", "wave", "aura"] as const) {
			expect(
				generalSettingsSchema.parse({ visualizerType: t }).visualizerType,
			).toBe(t);
		}
	});

	test("visualizerType defaults to 'bar'", () => {
		expect(generalSettingsSchema.parse({}).visualizerType).toBe("bar");
	});
});

describe("hotkeySettingsSchema (lock-down)", () => {
	test("default 'LCtrl+LMeta' is preserved when no input", () => {
		expect(hotkeySettingsSchema.parse({}).pushToTalkKey).toBe("LCtrl+LMeta");
	});
});

describe("ttsSettingsSchema hotkey", () => {
	test("defaults to LCtrl+Space (must always be non-empty)", () => {
		expect(ttsSettingsSchema.parse({}).hotkey).toBe("LCtrl+Space");
	});

	test("rescues empty hotkey via .catch() to default", () => {
		expect(ttsSettingsSchema.parse({ hotkey: "" }).hotkey).toBe("LCtrl+Space");
	});

	test("accepts a valid combo verbatim", () => {
		expect(ttsSettingsSchema.parse({ hotkey: "LCtrl+LAlt+T" }).hotkey).toBe(
			"LCtrl+LAlt+T",
		);
	});
});

describe("appSettingsSchema — no hotkey field is ever empty", () => {
	test("all four hotkeys resolve to non-empty defaults from an empty input", () => {
		const out = appSettingsSchema.parse({});
		expect(out.hotkey.pushToTalkKey.length).toBeGreaterThan(0);
		expect(out.general.repasteHotkey.length).toBeGreaterThan(0);
		expect(out.tts.hotkey.length).toBeGreaterThan(0);
		expect(out.llm.transforms.hotkey.length).toBeGreaterThan(0);
	});

	test("all four hotkeys rehydrate to non-empty even when persisted as empty strings", () => {
		const out = appSettingsSchema.parse({
			hotkey: { pushToTalkKey: "" },
			general: { repasteHotkey: "" },
			tts: { hotkey: "" },
			llm: { transforms: { hotkey: "" } },
		});
		expect(out.hotkey.pushToTalkKey).toBe("LCtrl+LMeta");
		expect(out.general.repasteHotkey).toBe("LCtrl+LShift+V");
		expect(out.tts.hotkey).toBe("LCtrl+Space");
		expect(out.llm.transforms.hotkey).toBe("LCtrl+LShift+T");
	});
});

describe("dictionaryEntrySchema enforces min(1)", () => {
	test("rejects empty id", () => {
		expect(() => dictionaryEntrySchema.parse({ id: "", term: "a" })).toThrow();
	});

	test("rejects empty term", () => {
		expect(() => dictionaryEntrySchema.parse({ id: "1", term: "" })).toThrow();
	});

	test("accepts a single character for each min(1) field", () => {
		const out = dictionaryEntrySchema.parse({ id: "x", term: "K" });
		expect(out.id).toBe("x");
		expect(out.term).toBe("K");
	});

	test("error message for empty term reads 'Required'", () => {
		try {
			dictionaryEntrySchema.parse({ id: "1", term: "" });
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues =
				(e as { issues?: Array<{ message: string }> }).issues ?? [];
			expect(issues.some((i) => i.message === "Required")).toBe(true);
		}
	});
});

describe("addDictionaryEntrySchema enforces min(1) on trim()'d input", () => {
	test("rejects empty term after trim", () => {
		expect(() => addDictionaryEntrySchema.parse({ term: "" })).toThrow();
		expect(() => addDictionaryEntrySchema.parse({ term: "   " })).toThrow();
	});

	test("error message for empty term reads 'Required'", () => {
		try {
			addDictionaryEntrySchema.parse({ term: "  " });
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues =
				(e as { issues?: Array<{ message: string; path: unknown[] }> })
					.issues ?? [];
			const termIssue = issues.find((i) => i.path[0] === "term");
			expect(termIssue?.message).toBe("Required");
		}
	});
});

describe("snippetEntrySchema enforces min(1)", () => {
	test("rejects empty id", () => {
		expect(() =>
			snippetEntrySchema.parse({ id: "", trigger: "/x", expansion: "X" }),
		).toThrow();
	});

	test("rejects empty trigger", () => {
		expect(() =>
			snippetEntrySchema.parse({ id: "1", trigger: "", expansion: "X" }),
		).toThrow();
	});

	test("rejects empty expansion", () => {
		expect(() =>
			snippetEntrySchema.parse({ id: "1", trigger: "/x", expansion: "" }),
		).toThrow();
	});

	test("error message reads 'Required' for empty trigger/expansion (locks L96/L97)", () => {
		try {
			snippetEntrySchema.parse({ id: "1", trigger: "", expansion: "" });
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues =
				(e as { issues?: Array<{ message: string; path: unknown[] }> })
					.issues ?? [];
			expect(issues.find((i) => i.path[0] === "trigger")?.message).toBe(
				"Required",
			);
			expect(issues.find((i) => i.path[0] === "expansion")?.message).toBe(
				"Required",
			);
		}
	});
});

describe("addSnippetEntrySchema trims and rejects whitespace-only", () => {
	test("rejects whitespace-only trigger", () => {
		expect(() =>
			addSnippetEntrySchema.parse({ trigger: "   ", expansion: "X" }),
		).toThrow();
	});

	test("rejects whitespace-only expansion", () => {
		expect(() =>
			addSnippetEntrySchema.parse({ trigger: "/x", expansion: "   " }),
		).toThrow();
	});

	test("error message reads 'Required' for whitespace-only input (locks L101/L102)", () => {
		try {
			addSnippetEntrySchema.parse({ trigger: "  ", expansion: "  " });
			throw new Error("expected to throw");
		} catch (e: unknown) {
			const issues =
				(e as { issues?: Array<{ message: string; path: unknown[] }> })
					.issues ?? [];
			expect(issues.find((i) => i.path[0] === "trigger")?.message).toBe(
				"Required",
			);
			expect(issues.find((i) => i.path[0] === "expansion")?.message).toBe(
				"Required",
			);
		}
	});
});

describe("llmSettingsSchema defaults (lock-down)", () => {
	test("dictation.enabled defaults to false", () => {
		expect(llmSettingsSchema.parse({}).dictation.enabled).toBe(false);
	});

	test("transforms.enabled defaults to false", () => {
		expect(llmSettingsSchema.parse({}).transforms.enabled).toBe(false);
	});

	test("dictation.provider enum accepts both 'ollama' and 'openrouter'", () => {
		expect(llmSettingsSchema.parse({}).dictation.provider).toBe("ollama");
		expect(
			llmSettingsSchema.parse({ dictation: { provider: "openrouter" } })
				.dictation.provider,
		).toBe("openrouter");
	});

	test("dictation.provider rejects empty string", () => {
		expect(() =>
			llmSettingsSchema.parse({ dictation: { provider: "" } }),
		).toThrow();
	});

	test("transforms.provider rejects empty string", () => {
		expect(() =>
			llmSettingsSchema.parse({ transforms: { provider: "" } }),
		).toThrow();
	});

	test("endpoint defaults to http://localhost:11434", () => {
		expect(llmSettingsSchema.parse({}).endpoint).toBe("http://localhost:11434");
	});

	test("openrouterApiKey defaults to empty string (shared)", () => {
		expect(llmSettingsSchema.parse({}).openrouterApiKey).toBe("");
	});

	test("dictation.model / openrouter* default to empty strings", () => {
		const out = llmSettingsSchema.parse({}).dictation;
		expect(out.model).toBe("");
		expect(out.openrouterModel).toBe("");
		expect(out.openrouterFallbackModel).toBe("");
	});

	test("transforms.model / openrouter* default to empty strings", () => {
		const out = llmSettingsSchema.parse({}).transforms;
		expect(out.model).toBe("");
		expect(out.openrouterModel).toBe("");
		expect(out.openrouterFallbackModel).toBe("");
	});

	test("dictation.presets enum accepts each of the canonical preset keys", () => {
		for (const p of [
			"neutral",
			"formal",
			"friendly",
			"technical",
			"concise",
			"summarize",
			"reorder",
			"restructure",
			"rewordForClarity",
		] as const) {
			expect(
				llmSettingsSchema.parse({ dictation: { presets: [{ key: p }] } })
					.dictation.presets,
			).toEqual([{ key: p }]);
		}
	});

	test("dictation.presets rejects empty key", () => {
		expect(() =>
			llmSettingsSchema.parse({ dictation: { presets: [{ key: "" }] } }),
		).toThrow();
	});

	test("dictation.presets rejects two tone keys together", () => {
		expect(() =>
			llmSettingsSchema.parse({
				dictation: { presets: [{ key: "formal" }, { key: "friendly" }] },
			}),
		).toThrow();
	});

	test("dictation.presets rejects level on a preset that does not support levels", () => {
		expect(() =>
			llmSettingsSchema.parse({
				dictation: { presets: [{ key: "neutral", level: "high" }] },
			}),
		).toThrow();
	});

	test("transforms defaults mirror dictation: neutral preset, no modifiers, default Ctrl+Shift+T hotkey", () => {
		const out = llmSettingsSchema.parse({}).transforms;
		expect(out.presets).toEqual([{ key: "neutral" }]);
		expect(out.customModifiers).toEqual([]);
		// Always non-empty: mirrors the TTS hotkey rule so the conflict checker
		// can compare against it and the recorder UI never renders an empty chip.
		expect(out.hotkey).toBe("LCtrl+LShift+T");
	});

	test("transforms.hotkey rescues empty via .catch() to default", () => {
		expect(
			llmSettingsSchema.parse({ transforms: { hotkey: "" } }).transforms.hotkey,
		).toBe("LCtrl+LShift+T");
	});

	test("transforms.presets shares the same composition rules as dictation.presets", () => {
		// Same schema (`presetsSchema`) backs both — the dictation tests above
		// cover the rule surface; here we just confirm transforms rejects the
		// same shapes (level on a non-leveled preset).
		expect(() =>
			llmSettingsSchema.parse({
				transforms: { presets: [{ key: "neutral", level: "high" }] },
			}),
		).toThrow();
	});

	test("transforms.hotkey accepts arbitrary string (validation deferred to the IPC parser)", () => {
		const out = llmSettingsSchema.parse({
			transforms: { hotkey: "LCtrl+LShift+T" },
		}).transforms;
		expect(out.hotkey).toBe("LCtrl+LShift+T");
	});
});

describe("explicit parse-time validation (kills `.default()` mutations that bypass enum validation)", () => {
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
		expect(
			generalSettingsSchema.parse({ visualizerSize: "" }).visualizerSize,
		).toBe("xs");
	});

	test("visualizerSize default literal is 'xs' — explicit 'xs' enum membership round-trips", () => {
		// Locks the L63 second `"xs"` (the default arg) AND first enum literal
		// against StringLiteral mutations. We assert that 'xs' is valid input
		// (so enum still contains "xs") AND that no input yields "xs".
		expect(
			generalSettingsSchema.parse({ visualizerSize: "xs" }).visualizerSize,
		).toBe("xs");
		expect(generalSettingsSchema.parse({}).visualizerSize).toBe("xs");
	});

	test("llm.dictation.presets defaults to neutral plus clarity modifiers", () => {
		const out = llmSettingsSchema.parse({});
		expect(out.dictation.presets).toEqual([
			{ key: "neutral" },
			{ key: "reorder" },
			{ key: "restructure" },
			{ key: "rewordForClarity" },
		]);
	});

	test("llm thinking effort defaults to off for both feature configs", () => {
		const out = llmSettingsSchema.parse({});
		expect(out.dictation.thinkingEffort).toBe("off");
		expect(out.transforms.thinkingEffort).toBe("off");
	});

	test("llm dictionary auto-add defaults to disabled", () => {
		const out = llmSettingsSchema.parse({});
		expect(out.dictation.dictionaryAutoAddEnabled).toBe(false);
	});
});

describe("appSettingsSchema (composed)", () => {
	test("empty object resolves to a fully-defaulted object", () => {
		const out = appSettingsSchema.parse({});
		expect(out.general.recordingMode).toBe("ptt");
		expect(out.model.model).toBe("tiny");
		expect(out.audio.sampleRate).toBe(16_000);
		expect(out.dictionary).toEqual([]);
		expect(out.snippets).toEqual([]);
		expect(out.llm.dictation.enabled).toBe(false);
		expect(out.llm.transforms.enabled).toBe(false);
	});

	test("partial input fills defaults for missing branches", () => {
		const out = appSettingsSchema.parse({
			general: { recordingMode: "toggle" },
			llm: { dictation: { enabled: true } },
		});
		expect(out.general.recordingMode).toBe("toggle");
		expect(out.general.minimizeToTray).toBe(true); // default
		expect(out.llm.dictation.enabled).toBe(true);
		expect(out.llm.dictation.provider).toBe("ollama"); // default
		expect(out.llm.transforms.enabled).toBe(false); // independent
	});
});
