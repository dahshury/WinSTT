/**
 * Cloud STT bridge — Electron main process.
 *
 * Reverses the normal STT data flow. When the user picks a cloud model
 * (e.g. `openai:gpt-4o-mini-transcribe`) the python pipeline instantiates
 * a `RemoteTranscriber` adapter (see
 * `server/src/recorder/infrastructure/remote_transcriber.py`). At
 * silence-end, that adapter sends a `stt_cloud_transcribe_request`
 * control message over the existing WS to this module, which:
 *
 *   1. Pulls the API key from the encrypted settings store via the
 *      secret-storage layer (key never leaves the main process).
 *   2. Decodes the base64 WAV payload into a Uint8Array.
 *   3. Calls the AI SDK `transcribe()` helper with the matching provider
 *      adapter (`@ai-sdk/openai` or `@ai-sdk/elevenlabs`).
 *   4. Sends a `stt_cloud_transcribe_response` back, carrying the text
 *      on success or a typed error code + message on failure.
 *   5. On failure, ALSO emits an IPC event to the renderer
 *      (`STT_CLOUD_AUTH_FAILED` / `_NETWORK_ERROR` / `_RATE_LIMITED` /
 *      `_PROVIDER_ERROR`) so the verify-credentials feature can surface
 *      a toast and put the recorder in the correct error state.
 *
 * In-flight requests are tracked in a map keyed by `request_id`; an
 * abort signal is wired into the AI SDK call so a model swap or app
 * exit cancels the call instead of letting it complete and paste a
 * now-stale result.
 */

import { createElevenLabs } from "@ai-sdk/elevenlabs";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, experimental_transcribe as transcribe } from "ai";
import { BrowserWindow } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { getErrorMessage } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
import { getStoreValue } from "../lib/store";
import type { SttClient } from "../ws/stt-client";

export type CloudSttProvider = "openai" | "elevenlabs";

export type CloudSttErrorCode =
	| "auth"
	| "network"
	| "rate_limit"
	| "key_missing"
	| "audio_too_large"
	| "provider_error"
	| "aborted"
	| "timeout";

/**
 * 90s ceiling for a single transcribe round-trip. OpenAI and ElevenLabs
 * usually return in 1–5s for a 10s utterance; the cap is a hedge against
 * a stuck connection. The python pipeline has its own per-request
 * timeout that's slightly longer so the electron side errors first with
 * a typed code rather than the server's generic "remote transcriber
 * timed out" message.
 */
const CLOUD_TRANSCRIBE_TIMEOUT_MS = 90_000;

/** Hoisted at module scope per Biome lint/performance/useTopLevelRegex. */
const NETWORK_ERROR_RE = /ENETUNREACH|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed/i;

/**
 * Provider hard limits (uncompressed audio bytes). These are upstream
 * constraints — sending more results in a 413 / "audio file too large"
 * error. Bail BEFORE shipping bytes over the wire so the failure is
 * fast and free.
 *
 *   - OpenAI:     25 MB across whisper-1 and gpt-4o-*-transcribe
 *   - ElevenLabs: 1 GB for scribe_v1 (file is multipart-uploaded)
 *
 * Honour the smaller of the two so the error message is consistent
 * across providers — listen-mode users hitting this should split into
 * per-utterance segments anyway.
 */
const PROVIDER_AUDIO_LIMIT_BYTES: Record<CloudSttProvider, number> = {
	openai: 25 * 1024 * 1024,
	elevenlabs: 1024 * 1024 * 1024,
};

interface CloudTranscribeRequest {
	audio_b64: string;
	command: "stt_cloud_transcribe_request";
	language?: string;
	media_type: string;
	model_id: string;
	provider: CloudSttProvider;
	request_id: string;
}

interface CloudTranscribeResponseOk {
	command: "stt_cloud_transcribe_response";
	duration_seconds?: number;
	language?: string;
	ok: true;
	request_id: string;
	text: string;
}

interface CloudTranscribeResponseErr {
	command: "stt_cloud_transcribe_response";
	error_code: CloudSttErrorCode;
	error_message: string;
	ok: false;
	request_id: string;
	retry_after_seconds?: number;
}

type CloudTranscribeResponse = CloudTranscribeResponseOk | CloudTranscribeResponseErr;

interface InFlight {
	controller: AbortController;
	provider: CloudSttProvider;
}

/**
 * Active transcribe calls keyed by request_id. Survives the call body
 * so a model swap or app shutdown can `controller.abort()` every entry.
 */
const inFlight = new Map<string, InFlight>();

function isCloudTranscribeRequest(value: unknown): value is CloudTranscribeRequest {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	if (obj.command !== "stt_cloud_transcribe_request") {
		return false;
	}
	if (typeof obj.request_id !== "string") {
		return false;
	}
	if (obj.provider !== "openai" && obj.provider !== "elevenlabs") {
		return false;
	}
	if (typeof obj.model_id !== "string" || obj.model_id === "") {
		return false;
	}
	if (typeof obj.audio_b64 !== "string" || obj.audio_b64 === "") {
		return false;
	}
	if (typeof obj.media_type !== "string" || obj.media_type === "") {
		return false;
	}
	if (obj.language !== undefined && typeof obj.language !== "string") {
		return false;
	}
	return true;
}

function loadApiKey(provider: CloudSttProvider): string {
	const dotPath =
		provider === "openai" ? "integrations.openai.apiKey" : "integrations.elevenlabs.apiKey";
	const value = getStoreValue(dotPath);
	return typeof value === "string" ? value : "";
}

function broadcastIpc(channel: string, payload: Record<string, unknown>): void {
	const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
	for (const w of windows) {
		w.webContents.send(channel, payload);
	}
}

function notifyRenderer(
	provider: CloudSttProvider,
	code: CloudSttErrorCode,
	message: string,
	extra?: Record<string, unknown>
): void {
	const channel = channelForErrorCode(code);
	if (channel) {
		broadcastIpc(channel, { provider, message, ...extra });
	}
}

function channelForErrorCode(code: CloudSttErrorCode): string | null {
	if (code === "auth") {
		return IPC.STT_CLOUD_AUTH_FAILED;
	}
	if (code === "network" || code === "timeout") {
		return IPC.STT_CLOUD_NETWORK_ERROR;
	}
	if (code === "key_missing") {
		return IPC.STT_CLOUD_KEY_MISSING;
	}
	if (code === "rate_limit") {
		return IPC.STT_CLOUD_RATE_LIMITED;
	}
	if (code === "aborted") {
		return null;
	}
	return IPC.STT_CLOUD_PROVIDER_ERROR;
}

/**
 * Translate an AI SDK / fetch error into a typed CloudSttErrorCode.
 * Order matters — abort first (synthetic abort errors carry HTTP-shaped
 * messages on some platforms), then HTTP-status hints, then everything
 * else falls through to provider_error.
 */
function classifyError(err: unknown): {
	code: CloudSttErrorCode;
	message: string;
	retryAfter?: number;
} {
	const message = getErrorMessage(err);
	if (err instanceof Error && err.name === "AbortError") {
		return { code: "aborted", message };
	}
	if (APICallError.isInstance(err)) {
		const status = err.statusCode;
		if (status === 401 || status === 403) {
			return { code: "auth", message };
		}
		if (status === 429) {
			const retryAfter = parseRetryAfter(err.responseHeaders?.["retry-after"]);
			return retryAfter === undefined
				? { code: "rate_limit", message }
				: { code: "rate_limit", message, retryAfter };
		}
		if (status === 413) {
			return { code: "audio_too_large", message };
		}
		if (status === undefined) {
			return { code: "network", message };
		}
		return { code: "provider_error", message };
	}
	if (err instanceof TypeError || NETWORK_ERROR_RE.test(message)) {
		return { code: "network", message };
	}
	return { code: "provider_error", message };
}

function parseRetryAfter(value: string | undefined): number | undefined {
	if (!value) {
		return;
	}
	const n = Number.parseFloat(value);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function decodeAudio(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

/**
 * Build the AI SDK transcription model handle. A per-call provider
 * instance is constructed each time so the key reflects the current
 * store value — the user may have rotated or removed it since the
 * last transcription. Returns null when no key is configured so the
 * caller can short-circuit with `key_missing` without ever touching
 * the wire.
 */
function buildTranscriptionModel(provider: CloudSttProvider, modelId: string) {
	const apiKey = loadApiKey(provider);
	if (!apiKey) {
		return null;
	}
	if (provider === "openai") {
		const openai = createOpenAI({ apiKey });
		return openai.transcription(modelId);
	}
	const elevenlabs = createElevenLabs({ apiKey });
	return elevenlabs.transcription(modelId);
}

async function runTranscribe(
	request: CloudTranscribeRequest,
	abortSignal: AbortSignal
): Promise<{ text: string; language?: string; duration?: number }> {
	const model = buildTranscriptionModel(request.provider, request.model_id);
	if (!model) {
		throw new Error("KEY_MISSING");
	}
	const audio = decodeAudio(request.audio_b64);
	if (audio.byteLength > PROVIDER_AUDIO_LIMIT_BYTES[request.provider]) {
		throw new Error("AUDIO_TOO_LARGE");
	}
	const result = await transcribe({
		model,
		audio,
		abortSignal,
		...(request.language && {
			providerOptions: { [request.provider]: { language: request.language } },
		}),
	});
	const payload: { text: string; language?: string; duration?: number } = { text: result.text };
	if (result.language !== undefined) {
		payload.language = result.language;
	}
	if (result.durationInSeconds !== undefined) {
		payload.duration = result.durationInSeconds;
	}
	return payload;
}

async function handleCloudTranscribe(
	sttClient: SttClient,
	request: CloudTranscribeRequest
): Promise<void> {
	const controller = new AbortController();
	const timeoutTimer = setTimeout(
		() => controller.abort(new DOMException("Cloud STT timeout", "AbortError")),
		CLOUD_TRANSCRIBE_TIMEOUT_MS
	);
	inFlight.set(request.request_id, { controller, provider: request.provider });
	const respond = (response: CloudTranscribeResponse): void => {
		sttClient.sendControl(response as unknown as Record<string, unknown>);
	};
	try {
		const { text, language, duration } = await runTranscribe(request, controller.signal);
		respond({
			command: "stt_cloud_transcribe_response",
			request_id: request.request_id,
			ok: true,
			text,
			...(language !== undefined && { language }),
			...(duration !== undefined && { duration_seconds: duration }),
		});
	} catch (err) {
		const message = getErrorMessage(err);
		// Short-circuit sentinels thrown by `runTranscribe` for the two
		// states we detect locally (no AI SDK call ever reached the wire).
		if (message === "KEY_MISSING") {
			respond({
				command: "stt_cloud_transcribe_response",
				request_id: request.request_id,
				ok: false,
				error_code: "key_missing",
				error_message: "No API key configured",
			});
			notifyRenderer(request.provider, "key_missing", "No API key configured");
			return;
		}
		if (message === "AUDIO_TOO_LARGE") {
			respond({
				command: "stt_cloud_transcribe_response",
				request_id: request.request_id,
				ok: false,
				error_code: "audio_too_large",
				error_message: `Utterance exceeds ${request.provider} upload limit`,
			});
			notifyRenderer(
				request.provider,
				"audio_too_large",
				`Utterance exceeds ${request.provider} upload limit`
			);
			return;
		}
		const { code, message: errMessage, retryAfter } = classifyError(err);
		dbg("stt-cloud", `${request.provider} ${request.model_id} failed (${code}): ${errMessage}`);
		respond({
			command: "stt_cloud_transcribe_response",
			request_id: request.request_id,
			ok: false,
			error_code: code,
			error_message: errMessage,
			...(retryAfter !== undefined && { retry_after_seconds: retryAfter }),
		});
		if (code !== "aborted") {
			notifyRenderer(
				request.provider,
				code,
				errMessage,
				retryAfter === undefined ? undefined : { retryAfter }
			);
		}
	} finally {
		clearTimeout(timeoutTimer);
		inFlight.delete(request.request_id);
	}
}

/**
 * Abort every in-flight cloud transcribe call. Called on app shutdown
 * and (optionally) on model swap so a now-stale provider call doesn't
 * compete with the new one.
 */
export function abortAllCloudTranscribes(reason: string): void {
	for (const [, entry] of inFlight) {
		entry.controller.abort(new DOMException(reason, "AbortError"));
	}
	inFlight.clear();
}

export function setupCloudStt(sttClient: SttClient): () => void {
	const onControl = (data: unknown): void => {
		if (!isCloudTranscribeRequest(data)) {
			return;
		}
		// Don't await — the WS handler shouldn't block the event loop on
		// HTTP latency. Errors are caught inside handleCloudTranscribe.
		// `.catch(() => {})` instead of `void` per Biome lint/complexity/noVoid.
		handleCloudTranscribe(sttClient, data).catch(() => {
			/* Unreachable: handleCloudTranscribe catches its own errors. */
		});
	};
	sttClient.on("control-message", onControl);
	return () => {
		sttClient.off("control-message", onControl);
		abortAllCloudTranscribes("setupCloudStt teardown");
	};
}

// Exported for unit tests.
export {
	CLOUD_TRANSCRIBE_TIMEOUT_MS,
	channelForErrorCode,
	classifyError,
	decodeAudio,
	isCloudTranscribeRequest,
	PROVIDER_AUDIO_LIMIT_BYTES,
	parseRetryAfter,
};
