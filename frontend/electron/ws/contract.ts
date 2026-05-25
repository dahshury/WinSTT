// Runtime contract validator for WebSocket data-channel events emitted by
// the Python STT server. Compile-time types from `spec/generated/ts/schema.d.ts`
// only catch shape drift at build time; this module is a defense-in-depth
// check at runtime. Schemas are NARROW (discriminator + required payload
// fields + the most-used optional fields) — they intentionally don't mirror
// every nullable extra in `spec/openapi.yaml`. The opt-in entry point is
// `validateServerEvent`; nothing in this folder calls it yet — see TESTING.md.
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
]);

export type WsServerEvent = z.infer<typeof serverEventSchema>;

/** All discriminator literals validated by this module. Exported for tests. */
export const SUPPORTED_EVENT_TYPES = [
	"realtime",
	"fullSentence",
	"recording_start",
	"recording_stop",
	"vad_detect_start",
	"vad_detect_stop",
	"audio_level",
	"model_download_progress",
	"wakeword_detected",
] as const;

export type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

const eventSchemas = {
	realtime: realtimeTextSchema,
	fullSentence: fullSentenceSchema,
	recording_start: recordingStartSchema,
	recording_stop: recordingStopSchema,
	vad_detect_start: vadDetectStartSchema,
	vad_detect_stop: vadDetectStopSchema,
	audio_level: audioLevelSchema,
	model_download_progress: modelDownloadProgressSchema,
	wakeword_detected: wakewordDetectedSchema,
} as const satisfies Record<SupportedEventType, z.ZodTypeAny>;

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
