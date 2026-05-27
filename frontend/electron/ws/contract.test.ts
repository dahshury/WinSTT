import { describe, expect, mock, test } from "bun:test";

// Suppress `console.warn` noise from the validator — every negative test
// triggers one warning by design, and we don't need to clutter test output.
const originalWarn = console.warn;
console.warn = mock(() => undefined);

import { SUPPORTED_EVENT_TYPES, validateServerEvent } from "./contract";

// Restore for any later tests in the same process.
process.on("exit", () => {
	console.warn = originalWarn;
});

// ── Positive: one valid payload per event type ───────────────────────

describe("validateServerEvent — positive cases", () => {
	test("accepts a valid realtime event", () => {
		const event = validateServerEvent({ type: "realtime", text: "hello" });
		expect(event).toEqual({ type: "realtime", text: "hello" });
	});

	test("accepts a valid fullSentence event", () => {
		const event = validateServerEvent({ type: "fullSentence", text: "hi there." });
		expect(event).toEqual({ type: "fullSentence", text: "hi there." });
	});

	test("accepts a valid recording_start event", () => {
		expect(validateServerEvent({ type: "recording_start" })).toEqual({
			type: "recording_start",
		});
	});

	test("accepts a valid recording_stop event", () => {
		expect(validateServerEvent({ type: "recording_stop" })).toEqual({
			type: "recording_stop",
		});
	});

	test("accepts a valid vad_detect_start event", () => {
		expect(validateServerEvent({ type: "vad_detect_start" })).toEqual({
			type: "vad_detect_start",
		});
	});

	test("accepts a valid vad_detect_stop event", () => {
		expect(validateServerEvent({ type: "vad_detect_stop" })).toEqual({
			type: "vad_detect_stop",
		});
	});

	test("accepts a valid audio_level event", () => {
		expect(validateServerEvent({ type: "audio_level", level: 0.42 })).toEqual({
			type: "audio_level",
			level: 0.42,
		});
	});

	test("accepts a valid model_download_progress with only required fields", () => {
		const event = validateServerEvent({
			type: "model_download_progress",
			model: "whisper-tiny",
			progress: 0.5,
		});
		expect(event).toEqual({
			type: "model_download_progress",
			model: "whisper-tiny",
			progress: 0.5,
		});
	});

	test("accepts a valid model_download_progress with all optional fields", () => {
		const event = validateServerEvent({
			type: "model_download_progress",
			model: "whisper-tiny",
			progress: 0.5,
			downloaded_bytes: 1024,
			total_bytes: 2048,
			speed_bps: 512,
			eta_seconds: 2,
		});
		expect(event).toMatchObject({ progress: 0.5, downloaded_bytes: 1024 });
	});

	test("accepts a valid wakeword_detected event", () => {
		expect(validateServerEvent({ type: "wakeword_detected" })).toEqual({
			type: "wakeword_detected",
		});
	});
});

// ── Negative: missing required field per event type ──────────────────

describe("validateServerEvent — missing required field", () => {
	test("rejects realtime without text", () => {
		expect(validateServerEvent({ type: "realtime" })).toBeNull();
	});

	test("rejects fullSentence without text", () => {
		expect(validateServerEvent({ type: "fullSentence" })).toBeNull();
	});

	test("rejects audio_level without level", () => {
		expect(validateServerEvent({ type: "audio_level" })).toBeNull();
	});

	test("rejects model_download_progress without progress", () => {
		expect(validateServerEvent({ type: "model_download_progress", model: "x" })).toBeNull();
	});

	test("rejects model_download_progress without model", () => {
		expect(validateServerEvent({ type: "model_download_progress", progress: 0.5 })).toBeNull();
	});
});

// ── Negative: wrong type for a known field ───────────────────────────

describe("validateServerEvent — wrong field type", () => {
	test("rejects realtime with non-string text", () => {
		expect(validateServerEvent({ type: "realtime", text: 42 })).toBeNull();
	});

	test("rejects fullSentence with text=null", () => {
		expect(validateServerEvent({ type: "fullSentence", text: null })).toBeNull();
	});

	test("rejects audio_level with string level", () => {
		expect(validateServerEvent({ type: "audio_level", level: "loud" })).toBeNull();
	});

	test("rejects audio_level with level above 1", () => {
		expect(validateServerEvent({ type: "audio_level", level: 1.5 })).toBeNull();
	});

	test("rejects audio_level with negative level", () => {
		expect(validateServerEvent({ type: "audio_level", level: -0.1 })).toBeNull();
	});

	test("rejects model_download_progress with string progress", () => {
		expect(
			validateServerEvent({
				type: "model_download_progress",
				model: "x",
				progress: "fifty",
			})
		).toBeNull();
	});
});

// ── Negative: discriminator and shape failures ───────────────────────

describe("validateServerEvent — structural rejections", () => {
	test("returns null on unknown discriminator", () => {
		expect(validateServerEvent({ type: "totally_made_up", text: "hi" })).toBeNull();
	});

	test("returns null on missing discriminator", () => {
		expect(validateServerEvent({ text: "hi" })).toBeNull();
	});

	test("returns null on non-object input — null", () => {
		expect(validateServerEvent(null)).toBeNull();
	});

	test("returns null on non-object input — undefined", () => {
		expect(validateServerEvent(undefined)).toBeNull();
	});

	test("returns null on non-object input — string", () => {
		expect(validateServerEvent("hello")).toBeNull();
	});

	test("returns null on non-object input — number", () => {
		expect(validateServerEvent(42)).toBeNull();
	});

	test("returns null on non-object input — array", () => {
		expect(validateServerEvent(["realtime", "text"])).toBeNull();
	});

	test("returns null on empty object", () => {
		expect(validateServerEvent({})).toBeNull();
	});
});

// ── Smoke check that the exported list matches the union ─────────────

describe("SUPPORTED_EVENT_TYPES", () => {
	test("each listed type accepts at least one minimal payload", () => {
		// Hand-built minimal payloads per type. If you add a new event to the
		// union you must extend this map — the iteration below will surface
		// the omission as a hard failure.
		const minimal: Record<(typeof SUPPORTED_EVENT_TYPES)[number], unknown> = {
			realtime: { type: "realtime", text: "" },
			fullSentence: { type: "fullSentence", text: "" },
			recording_start: { type: "recording_start" },
			recording_stop: { type: "recording_stop" },
			vad_detect_start: { type: "vad_detect_start" },
			vad_detect_stop: { type: "vad_detect_stop" },
			audio_level: { type: "audio_level", level: 0 },
			model_download_progress: {
				type: "model_download_progress",
				model: "m",
				progress: 0,
			},
			wakeword_detected: { type: "wakeword_detected" },
			wakeword_detection_start: { type: "wakeword_detection_start" },
			wakeword_detection_end: { type: "wakeword_detection_end" },
			model_swap_started: { type: "model_swap_started", kind: "main", name: "m" },
			model_swap_completed: { type: "model_swap_completed", kind: "main", name: "m" },
			model_swap_failed: {
				type: "model_swap_failed",
				kind: "main",
				name: "m",
				reason: "boom",
			},
			model_cache_changed: { type: "model_cache_changed", model_id: "m" },
			model_catalog_updated: { type: "model_catalog_updated", models: [] },
			diarization_toggle_started: {
				type: "diarization_toggle_started",
				enabled: true,
			},
			diarization_toggle_completed: {
				type: "diarization_toggle_completed",
				enabled: false,
			},
			diarization_toggle_failed: {
				type: "diarization_toggle_failed",
				enabled: true,
				reason: "boom",
			},
			start_turn_detection: { type: "start_turn_detection" },
			stop_turn_detection: { type: "stop_turn_detection" },
			transcription_start: { type: "transcription_start" },
			no_audio_detected: { type: "no_audio_detected" },
			vad_sensitivity_adapted: {
				type: "vad_sensitivity_adapted",
				new_sensitivity: 0.5,
				noise_floor_rms: 0.001,
				speech_peak_rms: 0.1,
			},
			device_switch_failed: {
				type: "device_switch_failed",
				requested_index: 3,
				error_message: "device busy",
				fallback_index: 1,
			},
			device_became_available: {
				type: "device_became_available",
				device_index: 2,
				device_name: "USB Mic",
			},
			model_download_start: { type: "model_download_start", model: "m" },
			model_download_complete: {
				type: "model_download_complete",
				model: "m",
				cancelled: false,
			},
			speaker_segments: { type: "speaker_segments", segments: [] },
			loopback_started: { type: "loopback_started", deviceName: "Speakers" },
			loopback_stopped: { type: "loopback_stopped" },
			file_transcription_progress: { type: "file_transcription_progress", progress: 0 },
			file_transcription_complete: { type: "file_transcription_complete" },
			file_transcription_error: { type: "file_transcription_error", error: "boom" },
			tts_complete: { type: "tts_complete", request_id: "r1" },
			tts_failed: { type: "tts_failed", request_id: "r1", reason: "boom" },
			tts_model_download_start: { type: "tts_model_download_start" },
			tts_model_download_progress: { type: "tts_model_download_progress", progress: 0 },
			tts_model_download_complete: { type: "tts_model_download_complete" },
			tts_install_status: { type: "tts_install_status", phase: "ready" },
			tts_install_paused: { type: "tts_install_paused" },
			tts_install_resumed: { type: "tts_install_resumed" },
			tts_install_failed: { type: "tts_install_failed", reason: "boom" },
		};
		for (const t of SUPPORTED_EVENT_TYPES) {
			expect(validateServerEvent(minimal[t])).not.toBeNull();
		}
	});
});
