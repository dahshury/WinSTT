/**
 * Cloud TTS bridge — Electron main process.
 *
 * The output-direction mirror of `stt-cloud.ts`. When the user picks the
 * cloud TTS source (`tts.source === "cloud"`), synthesis is served by
 * ElevenLabs entirely from the main process — no Python, no WebSocket. Both
 * cloud directions go through the **Vercel AI SDK** ElevenLabs provider:
 * `stt-cloud.ts` uses `experimental_transcribe` with `provider.transcription`,
 * and this module uses `experimental_generateSpeech` with `provider.speech`.
 *
 *   1. Pull the ElevenLabs API key + cloud tuning params from the encrypted
 *      settings store via `getStoreValue` (the key never leaves main).
 *   2. Call `generateSpeech` with the elevenlabs speech model, requesting raw
 *      `pcm_24000` (S16LE PCM @ 24 kHz mono) via `outputFormat` so no mp3
 *      decode is needed on this side.
 *   3. Convert the returned int16 buffer → float32 (`v / 32768`) and fan it out
 *      as `format:"f32le"` TTS_CHUNK frames — the SAME contract the local
 *      Kokoro path and the renderer playback queue (`features/tts-playback`)
 *      already speak, so playback is identical regardless of source.
 *   4. On completion / error, the caller's `onDone` / `onError` handlers fan
 *      out the TTS_COMPLETED / TTS_FAILED broadcast.
 *
 * `generateSpeech` is one-shot (non-streaming); we slice its buffer into ~1s
 * frames so the queue can start scheduling promptly. In-flight requests are
 * tracked in a `Map<requestId, AbortController>` so a stop gesture, model swap,
 * or app exit cancels the call instead of playing now-stale audio.
 *
 * The voice catalog (`GET /v2/voices`) is a plain `fetch` — the AI SDK exposes
 * no voice-listing API, only speech/transcription generation. It's catalog
 * discovery, not synthesis, so a direct call is appropriate here.
 */

import { createElevenLabs } from "@ai-sdk/elevenlabs";
import { APICallError, experimental_generateSpeech as generateSpeech } from "ai";
import type { CloudTtsVoiceCatalog } from "../../src/shared/api/ipc-client";
import { getErrorMessage } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
import { getStoreValue } from "../lib/store";

/** 10s ceiling for the voice-catalog round-trip (single GET, no audio). */
const LIST_VOICES_TIMEOUT_MS = 10_000;

/**
 * AI SDK `outputFormat` the elevenlabs provider maps to `mp3_44100_128`. mp3 is
 * the ONLY output available on every ElevenLabs tier — raw PCM (`pcm_24000` …)
 * is gated behind a paid plan and returns HTTP 402 on free / starter keys. The
 * renderer decodes the mp3 via Web Audio (`decodeAudioData`), so no decoder is
 * needed on this side. Streaming isn't a goal here — the whole utterance comes
 * back in one buffer and is emitted as a single chunk.
 */
const CLOUD_TTS_OUTPUT_FORMAT = "mp3";

/** Playback-queue format tag marking an encoded (container) chunk the renderer
 *  must decode via Web Audio, vs the raw `"f32le"` the local Kokoro path emits. */
const CLOUD_TTS_CHUNK_FORMAT = "mp3";

/** ElevenLabs voice-settings tuning read from the store per synthesis call. */
interface CloudTtsSettings {
	apiKey: string;
	model: string;
	similarity: number;
	speakerBoost: boolean;
	speed: number;
	stability: number;
	style: number;
}

interface SynthesizeOpts {
	requestId: string;
	/** Per-call speed override (read-aloud sentences); falls back to the stored
	 *  `tts.cloud.speed` when omitted. */
	speed?: number;
	text: string;
	voiceId: string;
}

interface SynthesizeHandlers {
	onChunk: (payload: Record<string, unknown>) => void;
	onDone: () => void;
	onError: (reason: string) => void;
}

/**
 * Active synthesis calls keyed by requestId. Survives the call body so a stop
 * gesture / model swap / app shutdown can `controller.abort()` an entry.
 */
const inFlight = new Map<string, AbortController>();

// --- store-backed settings -------------------------------------------------

function loadCloudSettings(): CloudTtsSettings {
	return {
		apiKey: getStoreValue("integrations.elevenlabs.apiKey"),
		model: getStoreValue("tts.cloud.model"),
		stability: getStoreValue("tts.cloud.stability"),
		similarity: getStoreValue("tts.cloud.similarity"),
		style: getStoreValue("tts.cloud.style"),
		speed: getStoreValue("tts.cloud.speed"),
		speakerBoost: getStoreValue("tts.cloud.speakerBoost"),
	};
}

// --- error classification --------------------------------------------------

const HTTP_STATUS_MESSAGE: Record<number, string> = {
	401: "ElevenLabs: invalid API key",
	403: "ElevenLabs: invalid API key",
	// 402 on synthesis is almost always a cloned/professional voice (or an
	// output format) that needs a paid plan; on the free tier premade voices work.
	402: "ElevenLabs: this voice needs a paid plan (cloned & professional voices require a subscription)",
	429: "ElevenLabs: rate limited",
};

/**
 * Map an HTTP status to a human-readable reason. 401/403 → auth, 429 → rate
 * limit, everything else → generic HTTP. Used by the AI SDK speech path, which
 * exposes only a status code. The voice-catalog fetch has the body too and
 * uses {@link classifyVoiceCatalogError} for a more precise scoped-key message.
 */
function classifyHttpError(status: number): string {
	return HTTP_STATUS_MESSAGE[status] ?? `ElevenLabs error: HTTP ${status}`;
}

/** Parsed shape of an ElevenLabs error body: `{"detail":{"status","message"}}`. */
function parseElevenLabsDetail(
	bodyText: string
): { status: string | undefined; message: string | undefined } | null {
	try {
		const parsed = JSON.parse(bodyText) as {
			detail?: { status?: unknown; message?: unknown };
		};
		const detail = parsed?.detail;
		if (detail === undefined || detail === null || typeof detail !== "object") {
			return null;
		}
		return {
			status: typeof detail.status === "string" ? detail.status : undefined,
			message: typeof detail.message === "string" ? detail.message : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Classify a failed `/v2/voices` response, reading the body so a scoped-key
 * 401 (`missing_permissions`) is reported as the precise missing permission —
 * NOT the misleading "invalid API key". ElevenLabs mints permission-scoped
 * keys; a key without `voices_read` can still synthesize speech, so reporting
 * it as invalid is wrong and confuses users (same false signal the verify
 * probe used to give — see ipc/credentials.ts). A genuinely bad key
 * (`invalid_api_key`) keeps the invalid-key message.
 */
async function classifyVoiceCatalogError(response: Response): Promise<string> {
	let bodyText = "";
	try {
		bodyText = await response.text();
	} catch {
		// Body unreadable — fall back to status-only classification.
	}
	if (response.status === 401 || response.status === 403) {
		const detail = parseElevenLabsDetail(bodyText);
		if (detail?.status === "missing_permissions") {
			const reason = detail.message ?? "this API key is missing the voices_read permission.";
			return `ElevenLabs: ${reason} Regenerate the key with voice read access.`;
		}
	}
	return classifyHttpError(response.status);
}

/**
 * ElevenLabs `detail.status` → precise synthesis-failure reason. The status in
 * the error body is more specific than the HTTP code (a 401 can be a bad key OR
 * an exhausted quota OR a missing scope), so prefer it when present.
 */
const CLOUD_DETAIL_MESSAGE: Record<string, string> = {
	quota_exceeded: "ElevenLabs: out of credits — upgrade your plan or wait for the monthly reset",
	missing_permissions: "ElevenLabs: this key is missing the text-to-speech permission",
	invalid_api_key: "ElevenLabs: invalid API key",
	needs_authorization: "ElevenLabs: invalid API key",
	voice_not_found: "ElevenLabs: that voice no longer exists — pick another",
};

/**
 * Map an AI SDK speech error to a human reason. Prefers ElevenLabs' `detail.status`
 * from the response body (quota / missing-scope / deleted-voice are all surfaced
 * as 401/402 otherwise), then the HTTP status, then the raw error text.
 */
function classifyAiSdkError(err: unknown): string {
	if (!APICallError.isInstance(err)) {
		return getErrorMessage(err);
	}
	const body = typeof err.responseBody === "string" ? err.responseBody : "";
	const status = parseElevenLabsDetail(body)?.status;
	if (status && CLOUD_DETAIL_MESSAGE[status]) {
		return CLOUD_DETAIL_MESSAGE[status];
	}
	if (err.statusCode !== undefined) {
		return classifyHttpError(err.statusCode);
	}
	return getErrorMessage(err);
}

/**
 * Extra failure context from an AI SDK `APICallError`: the HTTP status plus the
 * provider's raw response body (truncated). The body carries ElevenLabs' real
 * reason for a 402 / 4xx (e.g. `quota_exceeded`, a plan/format restriction),
 * which the bare status code doesn't. Returns "" for non-APICallErrors.
 */
function describeApiError(err: unknown): string {
	if (!APICallError.isInstance(err)) {
		return "";
	}
	const status = err.statusCode === undefined ? "?" : String(err.statusCode);
	const body = typeof err.responseBody === "string" ? err.responseBody.slice(0, 300) : "";
	return body ? ` [HTTP ${status}: ${body}]` : ` [HTTP ${status}]`;
}

// --- voice settings --------------------------------------------------------

/**
 * Build the AI SDK elevenlabs `voiceSettings` provider-option from the stored
 * tuning. The SDK uses camelCase keys (`similarityBoost`, `useSpeakerBoost`)
 * and maps them to ElevenLabs' snake_case `voice_settings` on the wire. `speed`
 * is passed as the top-level `generateSpeech` arg (the SDK folds it into
 * `voice_settings.speed`), so it's intentionally absent here.
 */
function buildVoiceSettings(settings: CloudTtsSettings): {
	similarityBoost: number;
	stability: number;
	style: number;
	useSpeakerBoost: boolean;
} {
	return {
		stability: settings.stability,
		similarityBoost: settings.similarity,
		style: settings.style,
		useSpeakerBoost: settings.speakerBoost,
	};
}

// --- emit -------------------------------------------------------------------

/**
 * Emit the one-shot encoded (mp3) buffer `generateSpeech` returns as a SINGLE
 * TTS_CHUNK tagged `format: "mp3"`. The renderer's playback queue decodes it via
 * Web Audio (`decodeAudioData`) — no PCM conversion on this side. A zero-byte
 * buffer emits nothing (the caller's onDone still completes the request).
 */
function emitEncoded(bytes: Uint8Array, requestId: string, handlers: SynthesizeHandlers): void {
	if (bytes.byteLength === 0) {
		return;
	}
	// Copy into an owned ArrayBuffer so the IPC structured clone carries only
	// this payload (the source Uint8Array may be a view over a larger buffer).
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	handlers.onChunk({
		requestId,
		// sampleRate / channels are ignored for an encoded chunk — the container
		// carries them and the renderer reads them out while decoding.
		sampleRate: 0,
		seq: 0,
		isFinal: true,
		format: CLOUD_TTS_CHUNK_FORMAT,
		channels: 1,
		pcm: copy.buffer,
	});
}

// --- synthesis -------------------------------------------------------------

function untrack(requestId: string): void {
	inFlight.delete(requestId);
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

async function runSynthesis(
	opts: SynthesizeOpts,
	settings: CloudTtsSettings,
	controller: AbortController,
	handlers: SynthesizeHandlers
): Promise<void> {
	try {
		// A per-call provider instance reflects the current stored key — the user
		// may have rotated or removed it since the last synthesis.
		const provider = createElevenLabs({ apiKey: settings.apiKey });
		const result = await generateSpeech({
			model: provider.speech(settings.model),
			text: opts.text,
			voice: opts.voiceId,
			outputFormat: CLOUD_TTS_OUTPUT_FORMAT,
			speed: opts.speed ?? settings.speed,
			providerOptions: { elevenlabs: { voiceSettings: buildVoiceSettings(settings) } },
			abortSignal: controller.signal,
		});
		const audioBytes = result.audio.uint8Array;
		// Diagnostic: byte count + media type confirm ElevenLabs returned audio in
		// the requested format. A 0-byte buffer or unexpected mediaType points at a
		// format / subscription-tier issue rather than our wiring.
		dbg(
			"tts-cloud",
			`synthesized ${opts.requestId} (model=${settings.model}, format=${CLOUD_TTS_OUTPUT_FORMAT}): ${audioBytes.byteLength} bytes (mediaType=${result.audio.mediaType})`
		);
		emitEncoded(audioBytes, opts.requestId, handlers);
		handlers.onDone();
	} catch (err) {
		// An abort means the canceller already broadcast completion — stay silent.
		if (controller.signal.aborted || isAbortError(err)) {
			return;
		}
		const message = classifyAiSdkError(err);
		// Log the requested model/format AND ElevenLabs' raw error body so a 402
		// ("payment required") is diagnosable — the body says WHY (e.g.
		// quota_exceeded vs a plan/format restriction), which the status hides.
		dbg(
			"tts-cloud",
			`synthesis ${opts.requestId} failed (model=${settings.model}, format=${CLOUD_TTS_OUTPUT_FORMAT}): ${message}${describeApiError(err)}`
		);
		handlers.onError(message);
	} finally {
		untrack(opts.requestId);
	}
}

/**
 * Synthesize `opts.text` via the AI SDK ElevenLabs speech model and fan each
 * PCM frame out through `handlers.onChunk`. Returns immediately — the call runs
 * in a detached async IIFE so the IPC handler (`handleSpeak`) doesn't block the
 * event loop on HTTP latency, mirroring stt-cloud's "don't block the loop" rule.
 */
export function synthesizeCloud(opts: SynthesizeOpts, handlers: SynthesizeHandlers): void {
	const settings = loadCloudSettings();
	if (settings.apiKey === "") {
		handlers.onError("ElevenLabs API key not configured");
		return;
	}
	if (opts.voiceId === "") {
		handlers.onError("No ElevenLabs voice selected");
		return;
	}
	const controller = new AbortController();
	inFlight.set(opts.requestId, controller);
	// Detached — don't await. `.catch` keeps Biome's noFloatingPromises /
	// useUndefined happy; runSynthesis already catches its own errors.
	runSynthesis(opts, settings, controller, handlers).catch(() => undefined);
}

/**
 * Fetch a voice's pre-generated preview clip (`preview_url` from /v2/voices — a
 * static mp3 on a CDN). A DOWNLOAD, not a synthesis, so it costs no ElevenLabs
 * character credits. Throws on a non-https URL, non-OK response, or abort; the
 * caller maps that to a TTS_FAILED.
 */
async function fetchVoicePreview(previewUrl: string, signal: AbortSignal): Promise<Uint8Array> {
	// Only ever fetch an https URL. The value comes from our own /v2/voices map,
	// but it crosses the renderer→main boundary, so refuse anything else.
	if (!previewUrl.startsWith("https://")) {
		throw new Error("Invalid preview URL");
	}
	const response = await fetch(previewUrl, { signal });
	if (!response.ok) {
		throw new Error(`preview HTTP ${response.status}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

async function runPreview(
	opts: { previewUrl: string; requestId: string },
	controller: AbortController,
	handlers: SynthesizeHandlers
): Promise<void> {
	try {
		const bytes = await fetchVoicePreview(opts.previewUrl, controller.signal);
		emitEncoded(bytes, opts.requestId, handlers);
		handlers.onDone();
	} catch (err) {
		if (controller.signal.aborted || isAbortError(err)) {
			return;
		}
		dbg("tts-cloud", `voice preview ${opts.requestId} failed: ${getErrorMessage(err)}`);
		handlers.onError("Couldn't load the voice preview");
	} finally {
		untrack(opts.requestId);
	}
}

/**
 * Play a voice's FREE preview clip through the same chunk pipeline as synthesis
 * (one encoded mp3 chunk → the renderer decodes it). Tracked in `inFlight` so a
 * cancel / rapid voice-switch aborts the download, mirroring synthesizeCloud.
 */
export function previewCloudClip(
	opts: { previewUrl: string; requestId: string },
	handlers: SynthesizeHandlers
): void {
	const controller = new AbortController();
	inFlight.set(opts.requestId, controller);
	runPreview(opts, controller, handlers).catch(() => undefined);
}

function abortEntry(controller: AbortController): void {
	controller.abort(new DOMException("Cloud TTS cancelled", "AbortError"));
}

/**
 * Abort a single in-flight cloud synthesis. No-op when `requestId` is absent
 * or not tracked — the no-id "cancel everything" path is {@link abortAllCloudTts}.
 */
export function abortCloudTts(requestId?: string): void {
	if (requestId === undefined) {
		return;
	}
	const controller = inFlight.get(requestId);
	if (controller === undefined) {
		return;
	}
	abortEntry(controller);
	untrack(requestId);
}

/** Abort every in-flight cloud synthesis and clear the tracking map. */
export function abortAllCloudTts(): void {
	for (const controller of inFlight.values()) {
		abortEntry(controller);
	}
	inFlight.clear();
}

// --- voice catalog (GET /v2/voices) ----------------------------------------

interface RawVoice {
	category?: unknown;
	fine_tuning?: { language?: unknown } | null;
	labels?: { language?: unknown } | null;
	name?: unknown;
	preview_url?: unknown;
	voice_id?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Resolve a voice's display language, preferring labels over fine-tuning. */
function pickLanguage(voice: RawVoice): string | null {
	const labelLang = asStringOrNull(voice.labels?.language);
	if (labelLang !== null) {
		return labelLang;
	}
	return asStringOrNull(voice.fine_tuning?.language);
}

/**
 * Map one raw `/v2/voices` entry to a `CloudTtsVoice`. Returns `null` when the
 * entry lacks a usable `voice_id` (defensive — the payload crosses a trust
 * boundary). `category` defaults to `"premade"` to match the picker's grouping.
 */
function mapVoice(raw: unknown): CloudTtsVoiceCatalog["voices"][number] | null {
	if (!isRecord(raw)) {
		return null;
	}
	const voice = raw as RawVoice;
	const id = asStringOrNull(voice.voice_id);
	if (id === null) {
		return null;
	}
	return {
		id,
		name: asStringOrNull(voice.name) ?? id,
		language: pickLanguage(voice),
		category: asStringOrNull(voice.category) ?? "premade",
		previewUrl: asStringOrNull(voice.preview_url),
	};
}

function mapVoices(raw: unknown): CloudTtsVoiceCatalog["voices"] {
	if (!(isRecord(raw) && Array.isArray(raw.voices))) {
		return [];
	}
	return raw.voices.flatMap((v) => {
		const mapped = mapVoice(v);
		return mapped === null ? [] : [mapped];
	});
}

/**
 * Fetch the live ElevenLabs voice catalog (`GET /v2/voices`, includes cloned
 * voices on the account). Returns `{ voices: [], error }` when the key is
 * missing or the request fails — never throws across the IPC boundary. The AI
 * SDK has no voice-listing API, so this stays a direct call.
 */
export async function handleCloudListVoices(): Promise<CloudTtsVoiceCatalog> {
	const apiKey = getStoreValue("integrations.elevenlabs.apiKey");
	if (apiKey === "") {
		return { voices: [], error: "ElevenLabs API key not configured" };
	}
	try {
		const response = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
			method: "GET",
			headers: { "xi-api-key": apiKey },
			signal: AbortSignal.timeout(LIST_VOICES_TIMEOUT_MS),
		});
		if (!response.ok) {
			return { voices: [], error: await classifyVoiceCatalogError(response) };
		}
		const json: unknown = await response.json();
		return { voices: mapVoices(json), error: null };
	} catch (err) {
		const message = getErrorMessage(err);
		dbg("tts-cloud", `listVoices failed: ${message}`);
		return { voices: [], error: message };
	}
}

/** Subscription snapshot used to gate the cloud TTS picker. */
interface CloudSubscriptionInfo {
	/** True when the monthly character quota is used up and can't overflow —
	 *  cloud TTS is disabled regardless of tier. False when unknown (can't tell). */
	creditsExhausted: boolean;
	/** Plan name (`"free"`, `"starter"`, …) or null when undeterminable. */
	tier: string | null;
}

/**
 * True when the plan's character quota is spent AND can't extend (overage off).
 * `character_count` is used, `character_limit` is the cap. Unknown fields → not
 * exhausted (never disable cloud on a field we couldn't read).
 */
function computeCreditsExhausted(json: Record<string, unknown>): boolean {
	const used = typeof json.character_count === "number" ? json.character_count : null;
	const limit = typeof json.character_limit === "number" ? json.character_limit : null;
	const canExtend = json.can_extend_character_limit === true;
	return used !== null && limit !== null && used >= limit && !canExtend;
}

/**
 * Read the ElevenLabs key's subscription (`GET /v1/user/subscription`): plan tier
 * + whether the character quota is exhausted. `tier` drives premium-voice
 * locking; `creditsExhausted` disables cloud TTS entirely (free OR paid). Both
 * default to "unknown/false" when the key lacks user-read scope or the request
 * fails, so we never wrongly block on missing data — the 402 path is the backstop.
 */
export async function handleCloudSubscription(): Promise<CloudSubscriptionInfo> {
	const apiKey = getStoreValue("integrations.elevenlabs.apiKey");
	if (apiKey === "") {
		return { tier: null, creditsExhausted: false };
	}
	try {
		const response = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
			method: "GET",
			headers: { "xi-api-key": apiKey },
			signal: AbortSignal.timeout(LIST_VOICES_TIMEOUT_MS),
		});
		if (!response.ok) {
			return { tier: null, creditsExhausted: false };
		}
		const json: unknown = await response.json();
		if (!isRecord(json)) {
			return { tier: null, creditsExhausted: false };
		}
		return {
			tier: typeof json.tier === "string" ? json.tier : null,
			creditsExhausted: computeCreditsExhausted(json),
		};
	} catch (err) {
		dbg("tts-cloud", `subscription probe failed: ${getErrorMessage(err)}`);
		return { tier: null, creditsExhausted: false };
	}
}

// Exported for unit tests.
export {
	asStringOrNull,
	buildVoiceSettings,
	classifyAiSdkError,
	classifyHttpError,
	classifyVoiceCatalogError,
	computeCreditsExhausted,
	describeApiError,
	fetchVoicePreview,
	mapVoice,
	mapVoices,
	parseElevenLabsDetail,
	pickLanguage,
};
