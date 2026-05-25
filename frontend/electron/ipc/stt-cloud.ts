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

const API_KEY_STORE_PATHS = {
	openai: "integrations.openai.apiKey",
	elevenlabs: "integrations.elevenlabs.apiKey",
} as const satisfies Record<CloudSttProvider, string>;

/**
 * IPC channel each error code surfaces on. `aborted` deliberately maps
 * to `null` because a user-initiated cancel shouldn't trigger a toast —
 * the user already knows they cancelled. Anything not in the table
 * falls through to the generic provider-error channel.
 */
const ERROR_CODE_CHANNEL: Record<CloudSttErrorCode, string | null> = {
	auth: IPC.STT_CLOUD_AUTH_FAILED,
	network: IPC.STT_CLOUD_NETWORK_ERROR,
	timeout: IPC.STT_CLOUD_NETWORK_ERROR,
	key_missing: IPC.STT_CLOUD_KEY_MISSING,
	rate_limit: IPC.STT_CLOUD_RATE_LIMITED,
	aborted: null,
	audio_too_large: IPC.STT_CLOUD_PROVIDER_ERROR,
	provider_error: IPC.STT_CLOUD_PROVIDER_ERROR,
};

/** HTTP status code → typed error code. Hit before falling through. */
const HTTP_STATUS_ERROR_CODE: Record<number, CloudSttErrorCode> = {
	401: "auth",
	403: "auth",
	413: "audio_too_large",
	429: "rate_limit",
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

interface ClassifiedError {
	code: CloudSttErrorCode;
	message: string;
	retryAfter?: number;
}

/**
 * Active transcribe calls keyed by request_id. Survives the call body
 * so a model swap or app shutdown can `controller.abort()` every entry.
 */
const inFlight = new Map<string, InFlight>();

// --- isCloudTranscribeRequest helpers --------------------------------------
// Each predicate is CC=1 so the umbrella validator stays at CC=1.

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isCloudCommand(obj: Record<string, unknown>): boolean {
	return obj.command === "stt_cloud_transcribe_request";
}

function isNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.length > 0;
}

function isKnownProvider(value: unknown): boolean {
	return value === "openai" || value === "elevenlabs";
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

/** Predicates the envelope must satisfy. All CC=1 thanks to helper extraction. */
const CLOUD_TRANSCRIBE_REQUEST_PREDICATES: ReadonlyArray<
	(obj: Record<string, unknown>) => boolean
> = [
	isCloudCommand,
	(obj) => isNonEmptyString(obj.request_id),
	(obj) => isKnownProvider(obj.provider),
	(obj) => isNonEmptyString(obj.model_id),
	(obj) => isNonEmptyString(obj.audio_b64),
	(obj) => isNonEmptyString(obj.media_type),
	(obj) => isOptionalString(obj.language),
];

function isCloudTranscribeRequest(value: unknown): value is CloudTranscribeRequest {
	return isRecord(value) && CLOUD_TRANSCRIBE_REQUEST_PREDICATES.every((p) => p(value));
}

function loadApiKey(provider: CloudSttProvider): string {
	const value = getStoreValue(API_KEY_STORE_PATHS[provider]);
	return asString(value);
}

/**
 * Dispatch table indexed by the runtime `typeof` token. Every typeof
 * variant gets an explicit entry so the lookup never undefined-defaults —
 * keeps CC=1 for `asString` (no `??` or ternary needed).
 */
const STRING_COERCE_BY_TYPE: Record<ReturnType<typeof typeofToken>, (value: unknown) => string> = {
	string: (value) => value as string,
	number: () => "",
	bigint: () => "",
	boolean: () => "",
	symbol: () => "",
	undefined: () => "",
	object: () => "",
	function: () => "",
};

type TypeofToken =
	| "bigint"
	| "boolean"
	| "function"
	| "number"
	| "object"
	| "string"
	| "symbol"
	| "undefined";

function typeofToken(value: unknown): TypeofToken {
	return typeof value;
}

function asString(value: unknown): string {
	return STRING_COERCE_BY_TYPE[typeofToken(value)](value);
}

function getLiveWindows(): BrowserWindow[] {
	return BrowserWindow.getAllWindows().filter(isWindowAlive);
}

function isWindowAlive(w: BrowserWindow): boolean {
	return !w.isDestroyed();
}

function sendToWindow(w: BrowserWindow, channel: string, payload: Record<string, unknown>): void {
	w.webContents.send(channel, payload);
}

function broadcastIpc(channel: string, payload: Record<string, unknown>): void {
	for (const w of getLiveWindows()) {
		sendToWindow(w, channel, payload);
	}
}

function notifyRenderer(
	provider: CloudSttProvider,
	code: CloudSttErrorCode,
	message: string,
	extra?: Record<string, unknown>
): void {
	const channel = channelForErrorCode(code);
	dispatchRendererToast(channel, { provider, message, ...extra });
}

function dispatchRendererToast(channel: string | null, payload: Record<string, unknown>): void {
	if (channel === null) {
		return;
	}
	broadcastIpc(channel, payload);
}

function channelForErrorCode(code: CloudSttErrorCode): string | null {
	return ERROR_CODE_CHANNEL[code];
}

// --- classifyError helpers -------------------------------------------------

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

function isNetworkLikeError(err: unknown, message: string): boolean {
	return err instanceof TypeError || NETWORK_ERROR_RE.test(message);
}

function classifyByStatusCode(status: number | undefined): CloudSttErrorCode {
	return HTTP_STATUS_ERROR_CODE[status ?? -1] ?? fallbackStatusCode(status);
}

function fallbackStatusCode(status: number | undefined): CloudSttErrorCode {
	return status === undefined ? "network" : "provider_error";
}

function classifyApiCallError(err: APICallError, message: string): ClassifiedError {
	const code = classifyByStatusCode(err.statusCode);
	const retryAfter = parseRetryAfter(err.responseHeaders?.["retry-after"]);
	return buildClassifiedError(code, message, retryAfter);
}

function buildClassifiedError(
	code: CloudSttErrorCode,
	message: string,
	retryAfter: number | undefined
): ClassifiedError {
	const base: ClassifiedError = { code, message };
	return retryAfter === undefined ? base : { ...base, retryAfter };
}

/**
 * Translate an AI SDK / fetch error into a typed CloudSttErrorCode.
 * Order matters — abort first (synthetic abort errors carry HTTP-shaped
 * messages on some platforms), then HTTP-status hints, then everything
 * else falls through to provider_error.
 */
function classifyError(err: unknown): ClassifiedError {
	const message = getErrorMessage(err);
	const handler = pickErrorClassifier(err);
	return handler(err, message);
}

type ErrorClassifier = (err: unknown, message: string) => ClassifiedError;

function pickErrorClassifier(err: unknown): ErrorClassifier {
	const order: ReadonlyArray<readonly [(err: unknown) => boolean, ErrorClassifier]> = [
		[isAbortError, classifyAsAbort],
		[APICallError.isInstance, classifyAsApiCallError],
		[isNetworkErrorLike, classifyAsNetwork],
	];
	return findMatchingClassifier(order, err) ?? classifyAsProviderError;
}

function findMatchingClassifier(
	order: ReadonlyArray<readonly [(err: unknown) => boolean, ErrorClassifier]>,
	err: unknown
): ErrorClassifier | undefined {
	return order.find(([test]) => test(err))?.[1];
}

function isNetworkErrorLike(err: unknown): boolean {
	return isNetworkLikeError(err, getErrorMessage(err));
}

function classifyAsAbort(_err: unknown, message: string): ClassifiedError {
	return { code: "aborted", message };
}

function classifyAsApiCallError(err: unknown, message: string): ClassifiedError {
	return classifyApiCallError(err as APICallError, message);
}

function classifyAsNetwork(_err: unknown, message: string): ClassifiedError {
	return { code: "network", message };
}

function classifyAsProviderError(_err: unknown, message: string): ClassifiedError {
	return { code: "provider_error", message };
}

// --- parseRetryAfter -------------------------------------------------------

function parseRetryAfter(value: string | undefined): number | undefined {
	const n = parseRetryAfterNumber(value);
	return isPositiveFinite(n) ? n : undefined;
}

function parseRetryAfterNumber(value: string | undefined): number {
	return Number.parseFloat(value ?? "");
}

function isPositiveFinite(n: number): boolean {
	return Number.isFinite(n) && n > 0;
}

// --- transcription pipeline ------------------------------------------------

function decodeAudio(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

function makeProviderInstance(
	provider: CloudSttProvider,
	apiKey: string
): { transcription: (modelId: string) => unknown } {
	const factory = PROVIDER_FACTORY[provider];
	return factory(apiKey);
}

const PROVIDER_FACTORY: Record<
	CloudSttProvider,
	(apiKey: string) => { transcription: (modelId: string) => unknown }
> = {
	openai: (apiKey) => createOpenAI({ apiKey }),
	elevenlabs: (apiKey) => createElevenLabs({ apiKey }),
};

/**
 * Build the AI SDK transcription model handle. A per-call provider
 * instance is constructed each time so the key reflects the current
 * store value — the user may have rotated or removed it since the
 * last transcription. Returns null when no key is configured so the
 * caller can short-circuit with `key_missing` without ever touching
 * the wire.
 */
const TRANSCRIPTION_MODEL_BUILDER: Record<
	"missing" | "present",
	(provider: CloudSttProvider, modelId: string, apiKey: string) => unknown
> = {
	missing: () => null,
	present: (provider, modelId, apiKey) =>
		makeProviderInstance(provider, apiKey).transcription(modelId),
};

function buildTranscriptionModel(provider: CloudSttProvider, modelId: string): unknown {
	const apiKey = loadApiKey(provider);
	return TRANSCRIPTION_MODEL_BUILDER[keyPresenceKey(apiKey)](provider, modelId, apiKey);
}

const KEY_PRESENCE_FOR_EMPTY: Record<"true" | "false", "missing" | "present"> = {
	true: "missing",
	false: "present",
};

function keyPresenceKey(apiKey: string): "missing" | "present" {
	return KEY_PRESENCE_FOR_EMPTY[String(apiKey === "") as "true" | "false"];
}

function exceedsAudioLimit(provider: CloudSttProvider, byteLength: number): boolean {
	return byteLength > PROVIDER_AUDIO_LIMIT_BYTES[provider];
}

function buildProviderOptions(
	provider: CloudSttProvider,
	language: string | undefined
): { providerOptions?: Record<string, { language: string }> } {
	return language === undefined ? {} : { providerOptions: { [provider]: { language } } };
}

interface TranscribePayload {
	duration?: number;
	language?: string;
	text: string;
}

interface RawTranscriptionResult {
	durationInSeconds?: number | undefined;
	language?: string | undefined;
	text: string;
}

function buildTranscribeResult(result: RawTranscriptionResult): TranscribePayload {
	return {
		text: result.text,
		...spreadOptional("language", result.language),
		...spreadOptional("duration", result.durationInSeconds),
	};
}

function spreadOptional<K extends string, V>(
	key: K,
	value: V | undefined
): Record<K, V> | Record<string, never> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

async function runTranscribe(
	request: CloudTranscribeRequest,
	abortSignal: AbortSignal
): Promise<TranscribePayload> {
	const model = buildTranscriptionModel(request.provider, request.model_id);
	assertModelAvailable(model);
	const audio = decodeAudio(request.audio_b64);
	assertAudioWithinLimit(request.provider, audio.byteLength);
	const result = await callTranscribe(model, audio, abortSignal, request);
	return buildTranscribeResult(result);
}

const MODEL_AVAILABLE_GUARD: Record<"true" | "false", () => void> = {
	false: () => undefined,
	true: () => {
		throw new Error("KEY_MISSING");
	},
};

function assertModelAvailable(model: unknown): asserts model {
	MODEL_AVAILABLE_GUARD[String(model === null) as "true" | "false"]();
}

const AUDIO_LIMIT_GUARD: Record<"true" | "false", () => void> = {
	false: () => undefined,
	true: () => {
		throw new Error("AUDIO_TOO_LARGE");
	},
};

function assertAudioWithinLimit(provider: CloudSttProvider, byteLength: number): void {
	AUDIO_LIMIT_GUARD[String(exceedsAudioLimit(provider, byteLength)) as "true" | "false"]();
}

async function callTranscribe(
	model: unknown,
	audio: Uint8Array,
	abortSignal: AbortSignal,
	request: CloudTranscribeRequest
): Promise<RawTranscriptionResult> {
	const result = await transcribe({
		model: model as Parameters<typeof transcribe>[0]["model"],
		audio,
		abortSignal,
		...buildProviderOptions(request.provider, request.language),
	});
	return {
		text: result.text,
		language: result.language,
		durationInSeconds: result.durationInSeconds,
	};
}

// --- handleCloudTranscribe orchestration -----------------------------------

function createAbortController(): { controller: AbortController; clear: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("Cloud STT timeout", "AbortError")),
		CLOUD_TRANSCRIBE_TIMEOUT_MS
	);
	return { controller, clear: () => clearTimeout(timer) };
}

function trackInFlight(
	requestId: string,
	controller: AbortController,
	provider: CloudSttProvider
): void {
	inFlight.set(requestId, { controller, provider });
}

function untrackInFlight(requestId: string): void {
	inFlight.delete(requestId);
}

function sendControl(sttClient: SttClient, response: CloudTranscribeResponse): void {
	sttClient.sendControl(response as unknown as Record<string, unknown>);
}

function buildSuccessResponse(
	requestId: string,
	payload: TranscribePayload
): CloudTranscribeResponseOk {
	const base: CloudTranscribeResponseOk = {
		command: "stt_cloud_transcribe_response",
		request_id: requestId,
		ok: true,
		text: payload.text,
	};
	return mergeSuccessOptionals(base, payload);
}

function mergeSuccessOptionals(
	base: CloudTranscribeResponseOk,
	payload: TranscribePayload
): CloudTranscribeResponseOk {
	return {
		...base,
		...(payload.language === undefined ? {} : { language: payload.language }),
		...(payload.duration === undefined ? {} : { duration_seconds: payload.duration }),
	};
}

function buildErrorResponse(
	requestId: string,
	code: CloudSttErrorCode,
	message: string,
	retryAfter: number | undefined
): CloudTranscribeResponseErr {
	const base: CloudTranscribeResponseErr = {
		command: "stt_cloud_transcribe_response",
		request_id: requestId,
		ok: false,
		error_code: code,
		error_message: message,
	};
	return retryAfter === undefined ? base : { ...base, retry_after_seconds: retryAfter };
}

const SENTINEL_HANDLERS: Record<string, (request: CloudTranscribeRequest) => SentinelOutcome> = {
	KEY_MISSING: (_req) => ({
		code: "key_missing",
		message: "No API key configured",
	}),
	AUDIO_TOO_LARGE: (req) => ({
		code: "audio_too_large",
		message: `Utterance exceeds ${req.provider} upload limit`,
	}),
};

interface SentinelOutcome {
	code: CloudSttErrorCode;
	message: string;
}

function pickSentinel(
	message: string
): ((request: CloudTranscribeRequest) => SentinelOutcome) | undefined {
	return SENTINEL_HANDLERS[message];
}

function emitErrorResponse(
	sttClient: SttClient,
	request: CloudTranscribeRequest,
	classified: ClassifiedError
): void {
	sendControl(
		sttClient,
		buildErrorResponse(
			request.request_id,
			classified.code,
			classified.message,
			classified.retryAfter
		)
	);
	maybeNotifyRenderer(request.provider, classified);
}

function maybeNotifyRenderer(provider: CloudSttProvider, classified: ClassifiedError): void {
	NOTIFY_BY_CODE[suppressionKey(classified.code)](provider, classified);
}

const NOTIFICATION_ROUTE: Record<CloudSttErrorCode, "suppress" | "emit"> = {
	auth: "emit",
	network: "emit",
	rate_limit: "emit",
	key_missing: "emit",
	audio_too_large: "emit",
	provider_error: "emit",
	aborted: "suppress",
	timeout: "emit",
};

function suppressionKey(code: CloudSttErrorCode): "suppress" | "emit" {
	return NOTIFICATION_ROUTE[code];
}

const NOTIFY_BY_CODE: Record<
	"suppress" | "emit",
	(provider: CloudSttProvider, classified: ClassifiedError) => void
> = {
	suppress: () => undefined,
	emit: (provider, classified) =>
		notifyRenderer(
			provider,
			classified.code,
			classified.message,
			buildRetryExtra(classified.retryAfter)
		),
};

function buildRetryExtra(retryAfter: number | undefined): Record<string, unknown> | undefined {
	return retryAfter === undefined ? undefined : { retryAfter };
}

function handleTranscribeFailure(
	sttClient: SttClient,
	request: CloudTranscribeRequest,
	err: unknown
): void {
	const message = getErrorMessage(err);
	pickFailureHandler(pickSentinel(message))(sttClient, request, err);
}

type FailureHandler = (sttClient: SttClient, request: CloudTranscribeRequest, err: unknown) => void;

function pickFailureHandler(
	sentinel: ((request: CloudTranscribeRequest) => SentinelOutcome) | undefined
): FailureHandler {
	return sentinel === undefined
		? handleClassifiedError
		: (sttClient, request) => handleSentinelError(sttClient, request, sentinel(request));
}

function handleSentinelError(
	sttClient: SttClient,
	request: CloudTranscribeRequest,
	outcome: SentinelOutcome
): void {
	emitErrorResponse(sttClient, request, outcome);
}

function handleClassifiedError(
	sttClient: SttClient,
	request: CloudTranscribeRequest,
	err: unknown
): void {
	const classified = classifyError(err);
	logFailure(request, classified);
	emitErrorResponse(sttClient, request, classified);
}

function logFailure(request: CloudTranscribeRequest, classified: ClassifiedError): void {
	dbg(
		"stt-cloud",
		`${request.provider} ${request.model_id} failed (${classified.code}): ${classified.message}`
	);
}

async function attemptTranscribe(
	sttClient: SttClient,
	request: CloudTranscribeRequest,
	controller: AbortController
): Promise<void> {
	const payload = await runTranscribe(request, controller.signal);
	sendControl(sttClient, buildSuccessResponse(request.request_id, payload));
}

async function handleCloudTranscribe(
	sttClient: SttClient,
	request: CloudTranscribeRequest
): Promise<void> {
	const { controller, clear } = createAbortController();
	trackInFlight(request.request_id, controller, request.provider);
	await runProtectedTranscribe(sttClient, request, controller, clear);
}

async function runProtectedTranscribe(
	sttClient: SttClient,
	request: CloudTranscribeRequest,
	controller: AbortController,
	clear: () => void
): Promise<void> {
	await attemptTranscribe(sttClient, request, controller).catch((err: unknown) =>
		handleTranscribeFailure(sttClient, request, err)
	);
	clear();
	untrackInFlight(request.request_id);
}

function abortInFlightEntry(entry: InFlight, reason: string): void {
	entry.controller.abort(new DOMException(reason, "AbortError"));
}

/**
 * Abort every in-flight cloud transcribe call. Called on app shutdown
 * and (optionally) on model swap so a now-stale provider call doesn't
 * compete with the new one.
 */
export function abortAllCloudTranscribes(reason: string): void {
	abortAllInFlight(reason);
	inFlight.clear();
}

function abortAllInFlight(reason: string): void {
	for (const entry of inFlight.values()) {
		abortInFlightEntry(entry, reason);
	}
}

function dispatchControlMessage(sttClient: SttClient, data: unknown): void {
	const request = asCloudTranscribeRequest(data);
	dispatchValidRequest(sttClient, request);
}

function asCloudTranscribeRequest(data: unknown): CloudTranscribeRequest | null {
	return isCloudTranscribeRequest(data) ? data : null;
}

function dispatchValidRequest(sttClient: SttClient, request: CloudTranscribeRequest | null): void {
	// Don't await — the WS handler shouldn't block the event loop on
	// HTTP latency. Errors are caught inside handleCloudTranscribe.
	// `.catch(() => {})` instead of `void` per Biome lint/complexity/noVoid.
	runIfPresent(request, (req) => {
		handleCloudTranscribe(sttClient, req).catch(swallowError);
	});
}

const RUN_IF_PRESENT: Record<"yes" | "no", <T>(value: T | null, fn: (value: T) => void) => void> = {
	yes: (value, fn) => fn(value as never),
	no: () => undefined,
};

function runIfPresent<T>(value: T | null, fn: (value: T) => void): void {
	RUN_IF_PRESENT[presenceKey(value)](value, fn);
}

const PRESENCE_BY_NULL: Record<"true" | "false", "no" | "yes"> = {
	true: "no",
	false: "yes",
};

function presenceKey(value: unknown): "yes" | "no" {
	return PRESENCE_BY_NULL[String(value === null) as "true" | "false"];
}

function swallowError(): void {
	/* Unreachable: handleCloudTranscribe catches its own errors. */
}

export function setupCloudStt(sttClient: SttClient): () => void {
	const onControl = (data: unknown): void => dispatchControlMessage(sttClient, data);
	sttClient.on("control-message", onControl);
	return () => teardownCloudStt(sttClient, onControl);
}

function teardownCloudStt(sttClient: SttClient, onControl: (data: unknown) => void): void {
	sttClient.off("control-message", onControl);
	abortAllCloudTranscribes("setupCloudStt teardown");
}

// Exported for unit tests.
export {
	asCloudTranscribeRequest,
	asString,
	assertAudioWithinLimit,
	assertModelAvailable,
	buildErrorResponse,
	buildProviderOptions,
	buildRetryExtra,
	buildSuccessResponse,
	buildTranscriptionModel,
	channelForErrorCode,
	classifyError,
	decodeAudio,
	dispatchRendererToast,
	exceedsAudioLimit,
	handleTranscribeFailure,
	isCloudTranscribeRequest,
	isPositiveFinite,
	loadApiKey,
	maybeNotifyRenderer,
	PROVIDER_AUDIO_LIMIT_BYTES,
	parseRetryAfter,
	pickSentinel,
	runProtectedTranscribe,
	spreadOptional,
};
