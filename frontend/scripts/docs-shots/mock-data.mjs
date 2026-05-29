// Builds the canned IPC response map that hydrates the real WinSTT renderer
// with authentic-looking data for documentation screenshots. The renderer
// gates almost every call through `invokeOrDefault`, so a focused set of
// responses produces a fully-populated UI without a live Electron/Python stack.
//
// Source of truth for the model list is the server's real catalog.json.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(here, "../../../server/src/recorder/domain/catalog.json");

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function loadCatalog() {
	const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
	const models = Array.isArray(raw) ? raw : (raw.models ?? Object.values(raw)[0]);
	return models;
}

function humanParams(n) {
	if (!n) return "";
	if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
	return `${Math.round(n / 1e6)}M`;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Mirror the server's normalization so the picker's speed/accuracy bars render.
function speedScore(rtfx) {
	if (!rtfx) return 0.5;
	return clamp01((Math.log10(rtfx) - Math.log10(50)) / (Math.log10(2000) - Math.log10(50)));
}
function accuracyScore(wer) {
	if (wer == null) return 0.5;
	return clamp01(1 - (wer - 5) / 20);
}

// catalog.json is the on-disk seed; the server enriches it into the wire shape
// the renderer's `rawModelInfoSchema` expects (adds backend / size_label /
// perf scores). Replicate that enrichment here.
function toWire(m) {
	return {
		id: m.id,
		display_name: m.display_name,
		family: m.family,
		backend: "onnx_asr",
		languages: m.languages ?? ["en"],
		supports_language_detection: m.supports_language_detection ?? false,
		supports_realtime: m.supports_realtime ?? false,
		onnx_model_name: m.onnx_model_name ?? null,
		description: m.description ?? "",
		size_label: humanParams(m.param_count),
		available_quantizations: m.available_quantizations ?? [""],
		size_bytes_by_quantization: m.size_bytes_by_quantization ?? {},
		available: true,
		error_message: "",
		local_path: null,
		speed_score: speedScore(m.rtfx),
		accuracy_score: accuracyScore(m.wer),
	};
}

// Which models look "downloaded" / "partial" in the picker, to make the
// download UX legible in screenshots.
const CACHED = new Set(["tiny", "large-v3-turbo", "nemo-parakeet-tdt-0.6b-v3"]);
const PARTIAL = new Map([["cohere-transcribe", 0.62]]);

function stateFor(model) {
	const id = model.id;
	const quants = model.available_quantizations ?? [""];
	const estimated = model.param_count ? Math.max(model.param_count * 2, 40 * MB) : 200 * MB;
	let cache;
	if (CACHED.has(id)) {
		cache = { state: "cached", progress: 1, downloaded_bytes: estimated, total_bytes: estimated };
	} else if (PARTIAL.has(id)) {
		const p = PARTIAL.get(id);
		cache = {
			state: "partial",
			progress: p,
			downloaded_bytes: Math.round(estimated * p),
			total_bytes: estimated,
		};
	} else {
		cache = { state: "not_cached", progress: 0, downloaded_bytes: 0, total_bytes: estimated };
	}
	const cache_by_quantization = {};
	for (const q of quants) {
		cache_by_quantization[q] =
			q === "" || q === "q4"
				? cache
				: { state: "not_cached", progress: 0, downloaded_bytes: 0, total_bytes: estimated };
	}
	return {
		id,
		available_quantizations: quants,
		cache,
		cache_by_quantization,
		comfortable_on_cpu: estimated < 1.2 * GB,
		comfortable_on_gpu: true,
		estimated_bytes: estimated,
	};
}

function buildHistory() {
	// A week of realistic dictations spread across days for the heatmap + table.
	const DAY = 86_400_000;
	const base = 1_748_000_000_000; // fixed epoch so screenshots are deterministic
	const samples = [
		{
			text: "Schedule the design review for Thursday afternoon and loop in the platform team.",
			llm: "qwen2.5:7b",
		},
		{
			text: "The DirectML execution provider runs whisper-tiny-q4 at about eighty-five milliseconds p50.",
			llm: null,
		},
		{
			text: "Refactor the recorder state machine so the abort path resets to inactive on short taps.",
			llm: "qwen2.5:7b",
		},
		{
			text: "Remember to verify the minisign signature before publishing the release artifacts.",
			llm: null,
		},
		{
			text: "Push to talk feels instant now that the microphone stream stays warm between presses.",
			llm: null,
		},
		{
			text: "Translate this paragraph to English and keep the markdown formatting intact.",
			llm: "llama3.1:8b",
		},
		{ text: "Add a fuzzy correction entry mapping kubernetes to the proper spelling.", llm: null },
		{
			text: "Listen mode captured both speakers cleanly over the loopback device.",
			llm: "qwen2.5:7b",
		},
		{
			text: "The dynamic island overlay morphs as the live transcription preview grows.",
			llm: null,
		},
		{ text: "Export the meeting notes as an SRT subtitle file with timestamps.", llm: null },
	];
	const entries = [];
	for (let i = 0; i < 64; i++) {
		const s = samples[i % samples.length];
		const dayOffset = Math.floor(i / 2.2);
		const ts = base - dayOffset * DAY - (i % 5) * 3_600_000;
		const words = s.text.split(/\s+/).length;
		entries.push({
			id: `h${i}`,
			text: s.text,
			timestamp: ts,
			durationMs: 1500 + words * 320,
			wordCount: words,
			...(s.llm ? { llmModel: s.llm, originalText: s.text } : {}),
			audioFilePath: i % 3 === 0 ? `C:/Users/you/AppData/WinSTT/recordings/${i}.wav` : undefined,
		});
	}
	return entries;
}

function isObj(v) {
	return v && typeof v === "object" && !Array.isArray(v);
}
function deepMerge(base, over) {
	if (!isObj(over)) return over === undefined ? base : over;
	const out = Array.isArray(base) ? [...base] : { ...base };
	for (const k of Object.keys(over)) {
		out[k] = isObj(out[k]) && isObj(over[k]) ? deepMerge(out[k], over[k]) : over[k];
	}
	return out;
}

// opts: { settings?: deep-merge override, recording?: bool, audioLevel?: number,
//         realtimeText?: string }
export function buildMockMap(opts = {}) {
	const rawModels = loadCatalog();
	const models = rawModels.map(toWire);
	const states = rawModels.map(stateFor);
	const system_info = {
		gpus: [{ name: "NVIDIA GeForce RTX 3080 Ti", total_vram_bytes: 12 * GB }],
		total_ram_bytes: 32 * GB,
	};

	const runtimeInfo = {
		device: "DmlExecutionProvider",
		is_gpu: true,
		model: "large-v3-turbo",
		realtime_model: "tiny",
		providers: ["DmlExecutionProvider", "CPUExecutionProvider"],
	};

	const settings = {
		model: {
			model: "large-v3-turbo",
			realtimeModel: "tiny",
			language: "en",
			device: "auto",
			onnxQuantization: "q4",
			translateToEnglish: false,
			modelUnloadTimeout: "min5",
		},
		general: {
			recordingMode: "ptt",
			recordingSound: true,
			systemAudioReductionWhileDictating: 40,
			visualizerType: "bar",
			visualizerBarCount: 9,
			visualizerSize: "md",
			liveTranscriptionDisplay: "both",
			overlayMode: "dynamic-island",
			showRecordingOverlay: true,
			contextAwareness: true,
			minimizeToTray: true,
			autoSubmit: false,
			filterFillers: true,
			recordingSoundLibrary: [
				{ id: "s1", name: "Soft Pop", path: "C:/Users/you/AppData/WinSTT/sounds/soft-pop.wav" },
				{ id: "s2", name: "Chime", path: "C:/Users/you/AppData/WinSTT/sounds/chime.wav" },
			],
		},
		llm: {
			endpoint: "http://localhost:11434",
			dictation: {
				enabled: true,
				provider: "ollama",
				model: "qwen2.5:7b",
				presets: [{ key: "neutral" }, { key: "concise", level: "medium" }],
				customModifiers: [
					{
						id: "m1",
						name: "Slack tone",
						prompt: "Rewrite casually for a Slack message.",
						enabled: true,
						levelsEnabled: false,
					},
				],
			},
			transforms: {
				enabled: true,
				provider: "ollama",
				model: "llama3.1:8b",
				hotkey: "LCtrl+LShift+T",
				presets: [{ key: "summarize", level: "medium" }],
				customModifiers: [],
				prompts: [],
			},
		},
		tts: { enabled: true, voice: "af_heart", lang: "en-us", speed: 1.0 },
		dictionary: [
			{ id: "d1", term: "Kubernetes" },
			{ id: "d2", term: "WinSTT" },
			{ id: "d3", term: "kuber netes", replacement: "Kubernetes" },
			{ id: "d4", term: "win s t t", replacement: "WinSTT" },
			{ id: "d5", term: "DirectML" },
		],
		snippets: [
			{ id: "p1", trigger: "@@addr", expansion: "1600 Amphitheatre Parkway, Mountain View, CA" },
			{ id: "p2", trigger: "@@sig", expansion: "Best regards,\nAlex" },
			{ id: "p3", trigger: "@@meet", expansion: "Let's sync at 2pm — here's the agenda:" },
		],
		integrations: {
			openai: {
				apiKey: "sk-proj-************************",
				verified: true,
				lastVerifiedAt: 1_748_000_000_000,
			},
			elevenlabs: { apiKey: "", verified: null, lastVerifiedAt: null },
		},
	};

	const ttsVoices = {
		languages: [
			{ code: "en-us", label: "English (US)" },
			{ code: "en-gb", label: "English (UK)" },
			{ code: "es", label: "Spanish" },
			{ code: "fr-fr", label: "French" },
		],
		voices: [
			{ id: "af_heart", label: "Heart", language: "en-us", gender: "female" },
			{ id: "af_bella", label: "Bella", language: "en-us", gender: "female" },
			{ id: "am_michael", label: "Michael", language: "en-us", gender: "male" },
			{ id: "bf_emma", label: "Emma", language: "en-gb", gender: "female" },
		],
	};

	const ollamaScan = {
		reachable: true,
		models: [
			{ name: "qwen2.5:7b", size: 4_700_000_000, parameterSize: "7.6B", quantization: "Q4_K_M" },
			{ name: "llama3.1:8b", size: 4_900_000_000, parameterSize: "8.0B", quantization: "Q4_K_M" },
			{ name: "gemma2:2b", size: 1_600_000_000, parameterSize: "2.6B", quantization: "Q4_0" },
		],
	};

	const aboutInfo = {
		version: "1.0.0",
		electronVersion: "42.0.0",
		nodeVersion: "24.0.0",
		copyright: "© 2026 WinSTT — MIT License",
	};

	const mergedSettings = deepMerge(settings, opts.settings ?? {});

	const invoke = {
		"settings:load": mergedSettings,
		"stt:get-model-catalog": models,
		"stt:list-models-with-state": { models, states, system_info },
		"stt:get-runtime-info": runtimeInfo,
		"stt:is-connected": true,
		"stt-server:status": "running",
		"stt:get-live-resources": {
			cpu_count_logical: 24,
			cpu_count_physical: 12,
			cpu_percent: 14,
			gpus: [
				{
					name: "NVIDIA GeForce RTX 3080 Ti",
					total_vram_bytes: 12 * GB,
					used_vram_bytes: 2.1 * GB,
					free_vram_bytes: 9.9 * GB,
					utilization_percent: 18,
				},
			],
			ram_total_bytes: 32 * GB,
			ram_available_bytes: 19 * GB,
		},
		"autostart:get": false,
		"audio:get-devices": [
			{ index: 0, name: "Microphone (Shure MV7)", maxInputChannels: 1, defaultSampleRate: 48000 },
			{
				index: 1,
				name: "Headset (Sony WH-1000XM5)",
				maxInputChannels: 1,
				defaultSampleRate: 16000,
			},
			{ index: 2, name: "Realtek HD Audio Mic", maxInputChannels: 2, defaultSampleRate: 44100 },
		],
		"gpu:get-info": { name: "NVIDIA GeForce RTX 3080 Ti", vendor: "NVIDIA", vramBytes: 12 * GB },
		"app:get-system-locale": "en-US",
		"loopback:list-devices": [
			{
				index: 10,
				name: "Speakers (Realtek) [Loopback]",
				defaultSampleRate: 48000,
				maxOutputChannels: 2,
			},
			{ index: 11, name: "VB-Audio Virtual Cable", defaultSampleRate: 48000, maxOutputChannels: 2 },
		],
		"tts:list-voices": ttsVoices,
		"history:get-all": buildHistory(),
		"llm:scan-models": ollamaScan,
		"llm:detect-ollama": { installed: true, running: true },
		"about:get-app-info": aboutInfo,
		"about:get-license":
			"MIT License\n\nCopyright (c) 2026 WinSTT\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...",
		"about:get-notices":
			"Third-party notices:\n\n- OpenAI Whisper (MIT)\n- NVIDIA NeMo (Apache-2.0)\n- ONNX Runtime (MIT)\n- Kokoro-82M (Apache-2.0)\n- Silero VAD (MIT)\n- Picovoice Porcupine (Apache-2.0)",
	};

	// Channels delivered via `on(...)` subscriptions that some stores rely on
	// for first paint. Payload shapes match the renderer's extract functions.
	const emit = {
		"stt:model-catalog": { models },
		"stt:runtime-info": runtimeInfo,
		"stt:connection-change": { connected: true },
		"stt:server-status": { status: "running" },
		"llm:catalog": { models: ollamaScan.models },
		// Windows that hydrate settings only via the push event (e.g. the
		// overlay) need this — they never call settings:load themselves.
		"settings:changed": { settings: mergedSettings },
	};

	// Recording-state simulation — drives the overlay pill + the live
	// in-app/in-overlay transcription preview + the audio visualizer.
	if (opts.recording) {
		emit["stt:recording-start"] = {};
		emit["stt:vad-start"] = {};
		emit["stt:transcription-start"] = {};
		emit["stt:realtime-text"] = {
			text: opts.realtimeText ?? "the quick brown fox jumps over the lazy dog",
		};
		emit["stt:audio-level"] = { level: opts.audioLevel ?? 0.72 };
	}

	const secure = {
		"clipboard:operate": { operation: "readText", text: "" },
		"updater:get-status-history": [],
	};

	return { invoke, emit, secure };
}
