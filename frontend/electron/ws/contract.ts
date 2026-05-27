// Runtime contract validator for WebSocket data-channel events emitted by
// the Python STT server. Compile-time types from `spec/generated/ts/schema.d.ts`
// only catch shape drift at build time; this module is a defense-in-depth
// check at runtime. Schemas are NARROW (discriminator + required payload
// fields + the most-used optional fields) — they intentionally don't mirror
// every nullable extra in `spec/openapi.yaml`. The opt-in entry point is
// `validateServerEvent`; nothing in this folder calls it yet — see TESTING.md.
//
// Compile-time drift gate (see `_SpecCoverage` below): every event declared
// in `spec/openapi.yaml`'s `DataEvent` union MUST have a Zod schema here
// (modulo `SpecExclusion`). Adding a new event to the spec and forgetting
// the Zod schema fails `bun typecheck` with the missing literal in the
// error message — the same drift would otherwise only show up at runtime
// as `[ws/contract] rejected server event`. The complementary
// server-emit-vs-Zod drift is caught by `bun check:ws-contract`.

import type { components } from "@spec/schema";
import { z } from "zod";

// ── Per-event schemas ────────────────────────────────────────────────
//
// Each schema's `type` field is a literal so `z.discriminatedUnion("type",
// [...])` can route incoming payloads to the right validator in O(1). The
// set below is the most-trafficked subset of `DataEvent` in
// `spec/openapi.yaml` — adding more is a one-liner append to the union.

const realtimeTextSchema = z.object({
	type: z.literal("realtime"),
	text: z.string(),
});

const fullSentenceSchema = z.object({
	type: z.literal("fullSentence"),
	text: z.string(),
});

const recordingStartSchema = z.object({
	type: z.literal("recording_start"),
});

const recordingStopSchema = z.object({
	type: z.literal("recording_stop"),
});

const vadDetectStartSchema = z.object({
	type: z.literal("vad_detect_start"),
});

const vadDetectStopSchema = z.object({
	type: z.literal("vad_detect_stop"),
});

const audioLevelSchema = z.object({
	type: z.literal("audio_level"),
	level: z.number().min(0).max(1),
});

const modelDownloadProgressSchema = z.object({
	type: z.literal("model_download_progress"),
	model: z.string(),
	progress: z.number().min(0).max(1),
	downloaded_bytes: z.number().int().optional(),
	total_bytes: z.number().int().optional(),
	speed_bps: z.number().optional(),
	eta_seconds: z.number().optional(),
});

const wakewordDetectedSchema = z.object({
	type: z.literal("wakeword_detected"),
});

// Wakeword detection lifecycle markers — emitted automatically by the
// auto-derived simple-event mechanism for ``on_wakeword_detection_start`` /
// ``on_wakeword_detection_end`` callbacks (see
// ``stt_server/callbacks.py::_SIMPLE_EVENTS``). Bracket the listening
// window so the UI can render the wakeword "armed" indicator.
const wakewordDetectionStartSchema = z.object({
	type: z.literal("wakeword_detection_start"),
});

const wakewordDetectionEndSchema = z.object({
	type: z.literal("wakeword_detection_end"),
});

const modelSwapStartedSchema = z.object({
	type: z.literal("model_swap_started"),
	kind: z.enum(["main", "realtime"]),
	name: z.string(),
});

const modelSwapCompletedSchema = z.object({
	type: z.literal("model_swap_completed"),
	kind: z.enum(["main", "realtime"]),
	name: z.string(),
});

const modelSwapFailedSchema = z.object({
	type: z.literal("model_swap_failed"),
	kind: z.enum(["main", "realtime"]),
	name: z.string(),
	reason: z.string(),
	category: z.string().optional(),
	detail: z.string().optional(),
});

const modelCacheChangedSchema = z.object({
	type: z.literal("model_cache_changed"),
	model_id: z.string(),
});

const modelCatalogUpdatedSchema = z.object({
	type: z.literal("model_catalog_updated"),
	models: z.array(z.unknown()),
});

const diarizationToggleStartedSchema = z.object({
	type: z.literal("diarization_toggle_started"),
	enabled: z.boolean(),
});

const diarizationToggleCompletedSchema = z.object({
	type: z.literal("diarization_toggle_completed"),
	enabled: z.boolean(),
	message: z.string().optional(),
});

const diarizationToggleFailedSchema = z.object({
	type: z.literal("diarization_toggle_failed"),
	enabled: z.boolean(),
	reason: z.string(),
	category: z.string().optional(),
	detail: z.string().optional(),
});

// Sentence-completion / endpoint detector — emitted by the smart-endpoint
// pipeline (DistilBERT classifier or the punctuation-heuristic fallback) so
// the UI can render the "thinking, hold on" indicator while the post-speech
// silence is being judged.
const startTurnDetectionSchema = z.object({
	type: z.literal("start_turn_detection"),
});

const stopTurnDetectionSchema = z.object({
	type: z.literal("stop_turn_detection"),
});

// Fires the moment the main transcribe job begins (audio bytes already
// captured + queued). Carries the recorded PCM as a base64 blob so the
// frontend can persist a copy under `userData/recordings/` for the history
// feature without having to re-decode from disk.
const transcriptionStartSchema = z.object({
	type: z.literal("transcription_start"),
	audio_bytes_base64: z.string().optional(),
});

// PTT-release-with-no-speech signal: the user pressed the hotkey but the
// recording captured nothing the VAD considered speech. Emitted by the
// recorder service's `_handle_microphone_off` when state is LISTENING /
// INACTIVE on release. The renderer uses it to dismiss the recording pill
// without firing the "transcribing…" spinner.
const noAudioDetectedSchema = z.object({
	type: z.literal("no_audio_detected"),
});

// Adaptive-VAD feedback: the server has recalibrated its silence threshold
// from observed background noise vs. speech peaks. Emitted by
// ``on_vad_sensitivity_adapted`` (see server/src/stt_server/callbacks.py)
// after each calibration window. The renderer correlates with the currently
// selected mic and persists ``new_sensitivity`` under that device's name in
// ``audio.sileroSensitivityByDeviceName``.
const vadSensitivityAdaptedSchema = z.object({
	type: z.literal("vad_sensitivity_adapted"),
	new_sensitivity: z.number(),
	noise_floor_rms: z.number(),
	speech_peak_rms: z.number(),
});

// Device switch failed: the server tried to swap to a new input device but
// the PyAudio call rejected the index (unplugged, busy, wrong sample rate).
// Carries the requested index, the human-readable error, and the fallback
// index the server reverted to (or ``null`` if it stayed on the previous).
const deviceSwitchFailedSchema = z.object({
	type: z.literal("device_switch_failed"),
	requested_index: z.number().int(),
	error_message: z.string(),
	fallback_index: z.number().int().nullable(),
});

// Device hotplug: a previously-removed input device is back. Fires when
// the device watcher sees the index reappear so the picker can resurface it
// in the menu and the auto-switch policy can decide whether to take it.
const deviceBecameAvailableSchema = z.object({
	type: z.literal("device_became_available"),
	device_index: z.number().int(),
	device_name: z.string(),
});

// Model download lifecycle. ``model_download_start`` and
// ``model_download_complete`` bracket the progress stream; both carry the
// model id so the renderer can match against the active swap. ``complete``
// includes a ``cancelled`` flag so the UI can distinguish "finished" from
// "user aborted mid-download".
const modelDownloadStartSchema = z.object({
	type: z.literal("model_download_start"),
	model: z.string(),
});

const modelDownloadCompleteSchema = z.object({
	type: z.literal("model_download_complete"),
	model: z.string(),
	cancelled: z.boolean(),
});

// Real-time diarized subtitles — per-utterance speaker segments produced
// by the diarization stream. ``segments`` is the full per-speaker breakdown
// for the just-finished utterance window.
const speakerSegmentsSchema = z.object({
	type: z.literal("speaker_segments"),
	segments: z.array(
		z.object({
			speaker: z.string(),
			start: z.number(),
			end: z.number(),
			text: z.string().optional(),
		})
	),
});

// System-audio (loopback) listen mode. The server signals when the OS
// loopback capture is online so the UI can show the "listening to system
// audio" indicator and surface the resolved device name.
const loopbackStartedSchema = z.object({
	type: z.literal("loopback_started"),
	deviceName: z.string(),
});

const loopbackStoppedSchema = z.object({
	type: z.literal("loopback_stopped"),
});

// File-transcription progress / completion. Emitted by the
// ``file_transcribe`` worker for drag-drop and CLI-piped audio. Progress
// fires repeatedly with a 0..1 fraction; complete and error are terminal.
const fileTranscriptionProgressSchema = z.object({
	type: z.literal("file_transcription_progress"),
	job_id: z.string().optional(),
	progress: z.number(),
	stage: z.string().optional(),
});

const fileTranscriptionCompleteSchema = z.object({
	type: z.literal("file_transcription_complete"),
	job_id: z.string().optional(),
	text: z.string().optional(),
	output_path: z.string().optional(),
});

const fileTranscriptionErrorSchema = z.object({
	type: z.literal("file_transcription_error"),
	job_id: z.string().optional(),
	error: z.string(),
});

// ── TTS data-channel events ──────────────────────────────────────────
//
// All synthesis/install events for the Kokoro-ONNX TTS sibling. The PCM
// itself rides the binary channel as `tts_chunk` metadata + a float32
// payload (see ``server/src/stt_server/tts_handler.py::_make_chunk_frame``)
// and is not a JSON data-channel event, so it has no schema here. The
// JSON events below are handled by ``electron/ipc/tts.ts`` after passing
// through ``validateServerEvent`` — they previously sat in the
// ``KNOWN_NON_VALIDATED`` allowlist in ``scripts/check-ws-contract.ts``
// because the validator's union didn't know about them; that produced
// recurring ``[ws/contract] rejected server event`` warnings in the
// renderer. Now they validate properly.

const ttsCompleteSchema = z.object({
	type: z.literal("tts_complete"),
	request_id: z.string(),
	cancelled: z.boolean().optional(),
	elapsed_ms: z.number().int().optional(),
});

const ttsFailedSchema = z.object({
	type: z.literal("tts_failed"),
	request_id: z.string(),
	reason: z.string(),
	category: z.string().optional(),
});

const ttsModelDownloadStartSchema = z.object({
	type: z.literal("tts_model_download_start"),
});

const ttsModelDownloadProgressSchema = z.object({
	type: z.literal("tts_model_download_progress"),
	progress: z.number().min(0).max(1),
	downloaded_bytes: z.number().int().optional(),
	total_bytes: z.number().int().optional(),
});

const ttsModelDownloadCompleteSchema = z.object({
	type: z.literal("tts_model_download_complete"),
	cancelled: z.boolean().optional(),
});

const ttsInstallStatusSchema = z.object({
	type: z.literal("tts_install_status"),
	phase: z.string(),
});

const ttsInstallPausedSchema = z.object({
	type: z.literal("tts_install_paused"),
});

const ttsInstallResumedSchema = z.object({
	type: z.literal("tts_install_resumed"),
});

const ttsInstallFailedSchema = z.object({
	type: z.literal("tts_install_failed"),
	reason: z.string(),
	category: z.string().optional(),
});

// ── Union + public types ─────────────────────────────────────────────

const serverEventSchema = z.discriminatedUnion("type", [
	realtimeTextSchema,
	fullSentenceSchema,
	recordingStartSchema,
	recordingStopSchema,
	vadDetectStartSchema,
	vadDetectStopSchema,
	audioLevelSchema,
	modelDownloadProgressSchema,
	wakewordDetectedSchema,
	wakewordDetectionStartSchema,
	wakewordDetectionEndSchema,
	modelSwapStartedSchema,
	modelSwapCompletedSchema,
	modelSwapFailedSchema,
	modelCacheChangedSchema,
	modelCatalogUpdatedSchema,
	diarizationToggleStartedSchema,
	diarizationToggleCompletedSchema,
	diarizationToggleFailedSchema,
	startTurnDetectionSchema,
	stopTurnDetectionSchema,
	transcriptionStartSchema,
	noAudioDetectedSchema,
	vadSensitivityAdaptedSchema,
	deviceSwitchFailedSchema,
	deviceBecameAvailableSchema,
	modelDownloadStartSchema,
	modelDownloadCompleteSchema,
	speakerSegmentsSchema,
	loopbackStartedSchema,
	loopbackStoppedSchema,
	fileTranscriptionProgressSchema,
	fileTranscriptionCompleteSchema,
	fileTranscriptionErrorSchema,
	ttsCompleteSchema,
	ttsFailedSchema,
	ttsModelDownloadStartSchema,
	ttsModelDownloadProgressSchema,
	ttsModelDownloadCompleteSchema,
	ttsInstallStatusSchema,
	ttsInstallPausedSchema,
	ttsInstallResumedSchema,
	ttsInstallFailedSchema,
]);

export type WsServerEvent = z.infer<typeof serverEventSchema>;

/** Discriminator string of every variant in the WS server-event union. */
export type SupportedEventType = WsServerEvent["type"];

/**
 * All discriminator literals validated by this module.
 *
 * Derived at runtime from the Zod discriminated union's ``.options`` so a
 * new variant added to ``serverEventSchema`` automatically participates in
 * the registry — eliminating the recurring "server emits a new event type
 * but the renderer's hand-maintained array is stale" warning we saw in
 * the logs (the ``start_turn_detection`` / ``no_audio_detected`` drift).
 *
 * The ``satisfies`` clause pins the runtime array to the type union, so if
 * the derivation ever stops producing the full set TypeScript will flag it.
 */
export const SUPPORTED_EVENT_TYPES = serverEventSchema.options.map(
	(option) => option.shape.type.value
) as readonly SupportedEventType[];

// ── Compile-time spec coverage gate ──────────────────────────────────
//
// Tie the hand-maintained Zod union above to the OpenAPI-generated
// `DataEvent` union so adding an event to `spec/openapi.yaml` (and
// running `bun generate`) without adding a Zod schema here fails the
// type check rather than the runtime validator. The negative direction
// (Zod schema with no matching server emit) is covered by the
// `bun check:ws-contract` script.
//
// If `_SpecCoverage` fails to compile, the error message contains the
// exact missing discriminator literal — e.g.
//   Type 'true' is not assignable to type '"tts_model_download_progress"'.
// — telling you which schema to add below. After adding it, append the
// schema to `serverEventSchema`'s `z.discriminatedUnion(…)` array so it
// participates in `SupportedEventType` and the check passes again.

/**
 * Every discriminator value declared in `spec/openapi.yaml`'s `DataEvent`
 * union, derived from the generated TS types via `bun generate`.
 */
type SpecEventType = NonNullable<components["schemas"]["DataEvent"]>["type"];

/**
 * Spec-declared events that intentionally never reach `validateServerEvent`
 * and therefore don't need a Zod schema.
 *
 * - `tts_chunk` is the JSON header of a binary PCM frame produced by
 *   `_make_chunk_frame` in `server/src/stt_server/tts_handler.py`. The
 *   binary handler in `stt-client.ts` consumes the frame before any
 *   JSON-event dispatch, so it never hits the runtime validator.
 */
type SpecExclusion = "tts_chunk";

/**
 * Self-check on `SpecExclusion`: if someone lists a value that isn't
 * actually in the spec union (typo, removed event), this assertion
 * fails to compile.
 */
const _specExclusionIsValid: SpecExclusion extends SpecEventType ? true : never = true;

/**
 * Events declared in the spec that are NOT yet covered by a Zod schema.
 * `never` when in sync. When non-empty, the assertion below fails with
 * the missing literal in the error message.
 */
type _MissingFromZod = Exclude<Exclude<SpecEventType, SpecExclusion>, SupportedEventType>;

/**
 * Compile-time invariant: see the section comment above. Fails with a
 * `Type 'true' is not assignable to type '"<missing-event>"'` error when
 * the spec adds an event without a matching Zod schema.
 */
const _SpecCoverage: [_MissingFromZod] extends [never] ? true : _MissingFromZod = true;

// `void` references so noUnusedVariables doesn't trip on the asserts.
// biome-ignore lint/complexity/noVoid: discard for compile-time type-assert var
void _specExclusionIsValid;
// biome-ignore lint/complexity/noVoid: discard for compile-time type-assert var
void _SpecCoverage;

// ── Public entry point ───────────────────────────────────────────────

/**
 * Parse a raw value (typically `JSON.parse(frame.data)`) as one of the
 * known data-channel events. Returns the validated event on success or
 * `null` on any failure (non-object, unknown discriminator, missing/wrong
 * payload field). This function is TOTAL — it never throws, no matter how
 * malformed the input.
 *
 * Logging is intentionally minimal: a single `console.warn` per failure
 * with the offending discriminator (if any) so call sites can opt in
 * without dragging in the project's debug-log infrastructure.
 */
function isObjectWithType(raw: unknown): raw is { type: unknown } {
	return typeof raw === "object" && raw !== null && "type" in raw;
}

function readEventDiscriminator(raw: unknown): string {
	if (!isObjectWithType(raw)) {
		return "<no-type>";
	}
	return String(raw.type);
}

export function validateServerEvent(raw: unknown): WsServerEvent | null {
	const parsed = serverEventSchema.safeParse(raw);
	if (parsed.success) {
		return parsed.data;
	}
	const discriminator = readEventDiscriminator(raw);
	console.warn(
		`[ws/contract] rejected server event (type=${discriminator}): ${parsed.error.message}`
	);
	return null;
}
