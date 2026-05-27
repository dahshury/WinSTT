import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { ConnectionError } from "../../src/shared/lib/errors";
import { markSessionAborted } from "../lib/abort-state";
import { dbg, dbgVerbose } from "../lib/debug-log";
import { isRecord } from "../lib/ipc-helpers";
import { getStoreValue } from "../lib/store";
import type { SttClient } from "../ws/stt-client";
import { abortActiveOllamaChats } from "./llm";
import { hideOverlay } from "./overlay";

/**
 * "Server not connected" rejections are expected during the cold-boot
 * window — the renderer mounts windows and fires settings/picker queries
 * before the WS handshake completes. The handler contract already returns
 * null on error so the renderer behavior is unchanged; this just keeps the
 * `[+N ms] startup` log readable. Any other failure (server crash, payload
 * validation, etc.) still warns as before.
 */
function logSttRequestFailure(tag: string, err: unknown): void {
	if (err instanceof ConnectionError) {
		return;
	}
	console.warn(`[${tag}] request failed:`, err);
}

/**
 * Cross-window in-flight dedup for read-only WS queries.
 *
 * Each renderer (main, settings, model-picker, …) mounts its own copy of
 * the stores that fetch ``list_models_with_state`` / ``get_live_resources``
 * / ``audio:get-devices`` on first paint. With three windows alive, the
 * server received three identical requests in quick succession — visible in
 * debug.log as 3× identical control responses 1-50ms apart.
 *
 * This map collapses those into a single in-flight WS request: subsequent
 * IPC calls with the same key await the same promise. Entries clear on
 * settle so a later fresh call (e.g. after a model swap invalidation) still
 * fetches new data.
 */
const inflightReadOnly = new Map<string, Promise<unknown>>();

function dedupeInflight<T>(key: string, factory: () => Promise<T>): Promise<T> {
	const existing = inflightReadOnly.get(key);
	if (existing !== undefined) {
		return existing as Promise<T>;
	}
	const promise = factory().finally(() => {
		// Guard against the rare race where a new request slipped in under
		// the same key while the previous one was still settling.
		if (inflightReadOnly.get(key) === promise) {
			inflightReadOnly.delete(key);
		}
	});
	inflightReadOnly.set(key, promise);
	return promise;
}

/** Test hook — flush in-flight dedup state so each test starts clean. */
export function __resetInflightDedupForTesting__(): void {
	inflightReadOnly.clear();
}

/**
 * Cross-window dedup for ``set_parameter`` pushes.
 *
 * Every renderer that mounts ``useSyncSettings`` (main, settings,
 * model-picker, …) does its OWN initial settings sync the moment the
 * server reports ``status=running``. The renderer-side
 * ``shouldSendOnChange`` only suppresses unchanged values when it has a
 * ``prev`` snapshot — but each new window has ``prev=undefined`` on first
 * mount, so it pushes ALL parameters again. The server responds
 * ``Parameter X unchanged`` to each one, polluting debug.log with ~9
 * redundant control responses per window open.
 *
 * This map tracks the last value sent to the server for each parameter.
 * A matching push is collapsed at the IPC boundary; the server never sees
 * the redundant request. Cleared on disconnect so a reconnect (which is
 * always preceded by a server restart in our flow) re-syncs the full set.
 */
const lastSentParameterValue = new Map<string, string>();

/** Method-call dedup for the small set of methods whose repeat is a no-op. */
const lastSentMethodValue = new Map<string, string>();

/**
 * Methods whose argument-equal repeat is a true no-op (server is already in
 * the requested state). NOT generally true for all methods — e.g.
 * ``set_microphone(true)`` after ``set_microphone(false)`` after
 * ``set_microphone(true)`` is the natural PTT cycle and must fire every
 * time. Only methods listed here are subject to value-equality dedup.
 */
const IDEMPOTENT_METHODS = new Set(["request_diarization_toggle"]);

export function __resetCommandDedupForTesting__(): void {
	lastSentParameterValue.clear();
	lastSentMethodValue.clear();
}

/** Wire disconnect-triggered cleanup of the dedup caches. */
export function attachCommandDedupReset(sttClient: SttClient): () => void {
	const onDisconnect = (): void => {
		lastSentParameterValue.clear();
		lastSentMethodValue.clear();
	};
	sttClient.on("disconnected", onDisconnect);
	return () => sttClient.off("disconnected", onDisconnect);
}

/**
 * Allowlists for STT parameters and methods that the renderer may invoke.
 * Must stay in sync with the OpenAPI spec (AllowedParameter / AllowedMethod).
 */
const ALLOWED_PARAMETERS = new Set([
	"model",
	"language",
	"silero_sensitivity",
	"wake_word_activation_delay",
	"post_speech_silence_duration",
	"listen_start",
	"recording_stop_time",
	"last_transcription_bytes",
	"last_transcription_bytes_b64",
	"speech_end_silence_start",
	"is_recording",
	"use_wake_words",
	"silence_timing",
	"silence_endpoint_enabled",
	"smart_endpoint_enabled",
	"detection_speed",
	"input_device_index",
	"end_of_sentence_detection_pause",
	"mid_sentence_detection_pause",
	"unknown_sentence_detection_pause",
	// Deterministic post-ASR fuzzy corrector. List[str] / float — the
	// renderer pushes the live dictionary terms (no `replacement` set)
	// here so the server can correct misrecognitions BEFORE the LLM
	// modifier pipeline runs in this main process.
	"custom_words",
	"word_correction_threshold",
]);

const ALLOWED_METHODS = new Set([
	"set_microphone",
	"abort",
	"stop",
	"clear_audio_queue",
	"wakeup",
	"shutdown",
	"text",
	"request_diarization_toggle",
]);

interface ParamPayload {
	parameter: string;
	value?: unknown;
}

interface MethodPayload {
	args?: unknown[];
	method: string;
}

function hasStringField<K extends string>(payload: unknown, key: K): payload is Record<K, string> {
	return Boolean(payload) && typeof (payload as Record<K, unknown>)[key] === "string";
}

type ParamReason = "invalid" | "disallowed" | "disconnected";

function checkParameterField(payload: unknown): ParamReason | { parameter: string } {
	if (!hasStringField(payload, "parameter")) {
		return "invalid";
	}
	return { parameter: payload.parameter };
}

function checkParameterAllowed(parameter: string): ParamReason | null {
	return ALLOWED_PARAMETERS.has(parameter) ? null : "disallowed";
}

function checkConnected(sttClient: Pick<SttClient, "isConnected">): ParamReason | null {
	return sttClient.isConnected ? null : "disconnected";
}

/**
 * Validate a set/get-parameter payload. Returns the rejection reason or null on success.
 */
function validateParameterPayload(
	payload: unknown,
	sttClient: Pick<SttClient, "isConnected">
): ParamReason | null {
	const fieldCheck = checkParameterField(payload);
	if (typeof fieldCheck === "string") {
		return fieldCheck;
	}
	return checkParameterAllowed(fieldCheck.parameter) ?? checkConnected(sttClient);
}

function handleSetParameter(
	sttClient: SttClient,
	payload: { parameter: string; value: unknown }
): void {
	const reason = validateParameterPayload(payload, sttClient);
	if (reason) {
		logSetParamRejection(reason, payload);
		return;
	}
	// Cross-window dedup — see `lastSentParameterValue`'s docstring.
	const serialized = JSON.stringify(payload.value);
	if (lastSentParameterValue.get(payload.parameter) === serialized) {
		// Stryker disable next-line StringLiteral: log-only diagnostic at verbose level
		dbgVerbose("stt-cmd", "set-parameter SKIPPED (unchanged):", payload.parameter);
		return;
	}
	lastSentParameterValue.set(payload.parameter, serialized);
	// Stryker disable next-line StringLiteral: log-only side-effect; dbgVerbose is mocked to no-op in tests.
	dbgVerbose("stt-cmd", "set-parameter:", payload.parameter, "=", serialized);
	sttClient.setParameter(payload.parameter, payload.value);
}

// Stryker disable ObjectLiteral,ArrowFunction,StringLiteral,BlockStatement: log-message factory used only by dbg() which is mocked to no-op in tests; precise message text is not asserted.
const SET_PARAM_LOG_MESSAGES: Record<
	"invalid" | "disallowed" | "disconnected",
	(p: ParamPayload) => string
> = {
	invalid: () => "set-parameter REJECTED (invalid payload)",
	disallowed: (p) => `set-parameter REJECTED (disallowed): ${p.parameter}`,
	disconnected: (p) => `set-parameter DROPPED (not connected): ${p.parameter}`,
};

function logSetParamRejection(
	reason: "invalid" | "disallowed" | "disconnected",
	payload: ParamPayload
): void {
	// `disconnected` fires routinely during the cold-boot window before the
	// WS handshake completes — demote to verbose so it doesn't spam the
	// terminal. `invalid` / `disallowed` indicate a real programming bug and
	// stay at standard log level.
	const emit = reason === "disconnected" ? dbgVerbose : dbg;
	emit("stt-cmd", SET_PARAM_LOG_MESSAGES[reason](payload));
}
// Stryker restore ObjectLiteral,ArrowFunction,StringLiteral,BlockStatement

const GET_PARAM_ERRORS: Record<
	"invalid" | "disallowed" | "disconnected",
	(p: ParamPayload) => Error
> = {
	invalid: () => new Error("Invalid payload: parameter must be a string"),
	disallowed: (p) => new Error(`Disallowed parameter: ${p.parameter}`),
	disconnected: () => new Error("STT client is not connected"),
};

function handleGetParameter(
	sttClient: SttClient,
	payload: { parameter: string }
): Promise<unknown> {
	const reason = validateParameterPayload(payload, sttClient);
	if (reason) {
		return Promise.reject(GET_PARAM_ERRORS[reason](payload));
	}
	return sttClient.getParameter(payload.parameter);
}

type CallMethodReason = "invalid" | "disallowed" | "bad-args" | "disconnected";

function checkMethodField(payload: unknown): CallMethodReason | { method: string } {
	if (!hasStringField(payload, "method")) {
		return "invalid";
	}
	return { method: payload.method };
}

function checkMethodAllowed(method: string): CallMethodReason | null {
	return ALLOWED_METHODS.has(method) ? null : "disallowed";
}

function checkMethodArgs(payload: unknown): CallMethodReason | null {
	return areMethodArgsValid((payload as MethodPayload).args) ? null : "bad-args";
}

function checkMethodConnected(sttClient: Pick<SttClient, "isConnected">): CallMethodReason | null {
	return sttClient.isConnected ? null : "disconnected";
}

function firstReason<R>(checks: Array<() => R | null>): R | null {
	for (const check of checks) {
		const result = check();
		if (result !== null) {
			return result;
		}
	}
	return null;
}

function validateMethodPayload(
	payload: unknown,
	sttClient: Pick<SttClient, "isConnected">
): CallMethodReason | null {
	const fieldCheck = checkMethodField(payload);
	if (typeof fieldCheck === "string") {
		return fieldCheck;
	}
	return firstReason<CallMethodReason>([
		() => checkMethodAllowed(fieldCheck.method),
		() => checkMethodArgs(payload),
		() => checkMethodConnected(sttClient),
	]);
}

function areMethodArgsValid(args: unknown): boolean {
	return args === undefined || Array.isArray(args);
}

// Stryker disable ObjectLiteral,ArrowFunction,StringLiteral,BlockStatement: log-message factory used only by dbg() which is mocked to no-op in tests.
const CALL_METHOD_LOG_MESSAGES: Record<CallMethodReason, (p: MethodPayload) => string> = {
	invalid: () => "call-method REJECTED (invalid payload)",
	disallowed: (p) => `call-method REJECTED (disallowed): ${p.method}`,
	"bad-args": (p) => `call-method REJECTED (args must be array): ${p.method}`,
	disconnected: (p) => `call-method DROPPED (not connected): ${p.method}`,
};

function logCallMethodRejection(reason: CallMethodReason, payload: MethodPayload): void {
	// Same boot-window rationale as :func:`logSetParamRejection`.
	const emit = reason === "disconnected" ? dbgVerbose : dbg;
	emit("stt-cmd", CALL_METHOD_LOG_MESSAGES[reason](payload));
}
// Stryker restore ObjectLiteral,ArrowFunction,StringLiteral,BlockStatement

function handleCallMethod(sttClient: SttClient, payload: MethodPayload): void {
	const reason = validateMethodPayload(payload, sttClient);
	if (reason) {
		logCallMethodRejection(reason, payload);
		return;
	}
	const serializedArgs = JSON.stringify(payload.args ?? []);
	// Idempotent-method dedup — only methods in IDEMPOTENT_METHODS are
	// gated. set_microphone(true)→(false)→(true) is the natural PTT cycle
	// and must fire every call, so most methods bypass this branch.
	if (
		IDEMPOTENT_METHODS.has(payload.method) &&
		lastSentMethodValue.get(payload.method) === serializedArgs
	) {
		// Stryker disable next-line StringLiteral: log-only diagnostic at verbose level
		dbgVerbose("stt-cmd", "call-method SKIPPED (unchanged):", payload.method);
		return;
	}
	lastSentMethodValue.set(payload.method, serializedArgs);
	// Stryker disable next-line StringLiteral,LogicalOperator,ArrayDeclaration: log-only debug emission; observable behavior is verified by the call-method tests asserting sttClient.callMethod was invoked with the right args.
	dbgVerbose("stt-cmd", "call-method:", payload.method, serializedArgs);
	sttClient.callMethod(payload.method, payload.args);
}

// Stryker disable BlockStatement,StringLiteral,ArrayDeclaration,ObjectLiteral,BooleanLiteral,LogicalOperator,MethodExpression,OptionalChaining: spawns nvidia-smi via child_process; cannot be mocked from this test file (electron mock + IPC handler tests don't override node:child_process). The catch branch is exercised in test environments where nvidia-smi is absent — the test asserts only the shape (name:string, available:boolean), not exact values.
async function handleGetGpuInfo(): Promise<{ name: string; available: boolean }> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		const { stdout } = await execFileAsync(
			"nvidia-smi",
			["--query-gpu=name", "--format=csv,noheader,nounits"],
			{ windowsHide: true, timeout: 5000 }
		);
		const output = stdout.trim();
		const name = output.split("\n")[0]?.trim() ?? "NVIDIA GPU";
		return { name, available: true };
	} catch {
		return { name: "No NVIDIA GPU", available: false };
	}
}
// Stryker restore BlockStatement,StringLiteral,ArrayDeclaration,ObjectLiteral,BooleanLiteral,LogicalOperator,MethodExpression,OptionalChaining

interface AudioDevice {
	index: number;
	isDefault: boolean;
	name: string;
}

function hasAudioDeviceFields(obj: Record<string, unknown>): boolean {
	return (
		typeof obj.index === "number" &&
		typeof obj.name === "string" &&
		typeof obj.isDefault === "boolean"
	);
}

function isAudioDeviceObject(d: unknown): d is AudioDevice {
	// Stryker disable next-line ConditionalExpression: equivalent — when d is null, hasAudioDeviceFields(null) would safely return false (null.index is undefined → typeof !== "number"), but TypeScript narrowing requires the explicit non-null guard.
	return typeof d === "object" && d !== null && hasAudioDeviceFields(d as Record<string, unknown>);
}

function parseAudioDevices(value: unknown): AudioDevice[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(isAudioDeviceObject);
}

async function handleGetAudioDevices(sttClient: SttClient): Promise<AudioDevice[]> {
	// Indices must come from PyAudio (the recorder's index space). Listing via
	// the OS (Windows MMDevice or Web Audio enumerateDevices) returns indices
	// from a different space that PyAudio's pa.open(input_device_index=...)
	// would map to the wrong device — that mismatch was the root cause of
	// "switching the device in Settings doesn't change which mic the app
	// listens to". Returning [] when the server is offline lets the renderer
	// retry on `devicechange` once the server connects.
	if (!sttClient.isConnected) {
		return [];
	}
	try {
		const value = await sttClient.listInputDevices();
		return parseAudioDevices(value);
	} catch (err) {
		// Stryker disable next-line StringLiteral: log-only console.warn; observable behavior (returning [] on error) is verified by the dedicated catch-branch test.
		console.warn("[audio] Failed to enumerate input devices via STT server:", err);
		return [];
	}
}

type ReloadModelKind = "main" | "realtime";

interface ReloadModelPayload {
	kind: ReloadModelKind;
	name: string;
}

const RELOAD_MODEL_COMMAND: Record<ReloadModelKind, "reload_main_model" | "reload_realtime_model"> =
	{
		main: "reload_main_model",
		realtime: "reload_realtime_model",
	};

function parseReloadModelKind(value: unknown): ReloadModelKind | null {
	return value === "main" || value === "realtime" ? value : null;
}

function parseReloadModelName(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function buildReloadModelPayload(
	kind: ReloadModelKind | null,
	name: string | null
): ReloadModelPayload | null {
	if (!(kind && name)) {
		return null;
	}
	return { kind, name };
}

function parseReloadModelPayload(payload: unknown): ReloadModelPayload | null {
	if (!isRecord(payload)) {
		return null;
	}
	return buildReloadModelPayload(
		parseReloadModelKind(payload.kind),
		parseReloadModelName(payload.name)
	);
}

function handleReloadModel(sttClient: SttClient, payload: unknown): void {
	const parsed = parseReloadModelPayload(payload);
	if (!parsed) {
		// Stryker disable next-line StringLiteral: log-only console.warn; observable behavior (no sendControl call) is verified by the dedicated invalid-payload tests.
		console.warn("[stt:reload-model] rejected invalid payload", payload);
		return;
	}
	sttClient.sendControl({
		command: RELOAD_MODEL_COMMAND[parsed.kind],
		model: parsed.name,
	});
}

async function handleListModelsWithState(sttClient: SttClient): Promise<unknown> {
	try {
		return await sttClient.listModelsWithState();
	} catch (err) {
		// Stryker disable next-line StringLiteral: log-only console.warn; observable behavior (returning null on error) is verified by the dedicated catch-branch test.
		logSttRequestFailure("stt:list-models-with-state", err);
		return null;
	}
}

function readForceRefresh(payload: unknown): boolean {
	return Boolean(isRecord(payload) && payload.forceRefresh === true);
}

async function safeGetLiveResources(sttClient: SttClient, force: boolean): Promise<unknown> {
	try {
		return await sttClient.getLiveResources(force);
	} catch (err) {
		logSttRequestFailure("stt:get-live-resources", err);
		return null;
	}
}

function handleGetLiveResources(sttClient: SttClient, payload: unknown): Promise<unknown> {
	return safeGetLiveResources(sttClient, readForceRefresh(payload));
}

interface AssessDictationFitPayload {
	device: string | null;
	modelId: string;
	quantization: string;
}

function readModelIdString(payload: Record<string, unknown>): string | null {
	const modelId = payload.modelId;
	return typeof modelId === "string" && modelId ? modelId : null;
}

function readOptionalString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function readOptionalStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function parseAssessDictationFitPayload(payload: unknown): AssessDictationFitPayload | null {
	if (!isRecord(payload)) {
		return null;
	}
	const modelId = readModelIdString(payload);
	if (!modelId) {
		return null;
	}
	return {
		modelId,
		quantization: readOptionalString(payload.quantization, ""),
		device: readOptionalStringOrNull(payload.device),
	};
}

async function safeAssessDictationFit(
	sttClient: SttClient,
	parsed: AssessDictationFitPayload
): Promise<unknown> {
	try {
		return await sttClient.assessDictationFit(parsed.modelId, parsed.quantization, parsed.device);
	} catch (err) {
		logSttRequestFailure("stt:assess-dictation-fit", err);
		return null;
	}
}

function handleAssessDictationFit(sttClient: SttClient, payload: unknown): Promise<unknown> {
	const parsed = parseAssessDictationFitPayload(payload);
	return parsed ? safeAssessDictationFit(sttClient, parsed) : Promise.resolve(null);
}

/**
 * Cancel the user's in-flight dictation pass. Triggered by the
 * `hotkey + Backspace` combo (detected in `hotkey.ts`) while the pill is
 * showing realtime captions or the LLM thinking indicator.
 *
 * Five things happen, in this order:
 *
 *   1. `markSessionAborted()` flips the relay's gate so EVERY downstream
 *      event for the current session is silently dropped — no realtime
 *      caption, no fullSentence broadcast, no paste, no history entry,
 *      no LLM cleanup. The gate covers the two leak paths that the
 *      individual aborts below cannot close on their own (see
 *      `abort-state.ts` for the full rationale).
 *   2. Active Ollama chats are aborted via `AbortController.abort()`.
 *      The streaming `/api/chat` request bails so the model stops
 *      generating and Ollama's per-model serializer releases.
 *   3. The server-side recorder is told to `abort` AND `clear_audio_queue`.
 *      `abort` flips the state machine to INACTIVE and stops accepting
 *      new audio; `clear_audio_queue` drops any frames already buffered
 *      so they don't get transcribed after we return.
 *   4. The overlay BrowserWindow hides so the user gets instant visual
 *      feedback even before the server side has finished cleaning up.
 *   5. (Implicit) The relay's `clearSessionAborted()` will run on the
 *      next `recording_start`, so a fresh dictation begins clean.
 *
 * Safe to call when nothing is in flight — every step short-circuits
 * silently if there's nothing to cancel.
 */
function abortServerRecorderIfConnected(sttClient: SttClient): void {
	if (!sttClient.isConnected) {
		return;
	}
	// `abort` stops the state machine; `clear_audio_queue` drops any
	// already-buffered frames so the next text() call doesn't churn
	// through audio the user just discarded.
	sttClient.callMethod("abort");
	sttClient.callMethod("clear_audio_queue");

	// Abort alone only flips the state machine; it leaves the audio
	// source actively delivering chunks (just dropped). The OS mic-in-use
	// indicator stays lit and, in toggle/listen mode, the stream really is
	// still listening for audio (the user's reported symptom). Tear the
	// input source down so the OS releases the device.
	const mode = getStoreValue("general.recordingMode");

	// PyAudio: pause hardware capture. Skipped in wakeword mode where the
	// recorder must keep capturing to hear the trigger word — abort already
	// reset the state machine, which is enough for that mode.
	if (mode !== "wakeword") {
		sttClient.callMethod("set_microphone", [false]);
	}

	// Loopback (listen mode): the mic-release path above doesn't touch it;
	// the loopback stream is owned by a separate server-side worker driven
	// by start_loopback / stop_loopback. Idempotent on the server.
	if (mode === "listen") {
		sttClient.stopLoopback();
	}
}

function safeHideOverlay(): void {
	try {
		hideOverlay();
	} catch (err) {
		dbg("stt-cmd", "hideOverlay during abort failed:", String(err));
	}
}

/**
 * Notify every live renderer that a cancel just landed so the renderer-side
 * "session is active" mirrors (toggle-mode `isActiveRef` in usePushToTalk)
 * reset. Without this, after canceling a toggle-mode session the renderer
 * still thinks the mic is on and the user has to press the hotkey twice — once
 * to toggle "off" the phantom session, once to start a fresh one — before
 * recording resumes.
 */
function broadcastSessionAborted(): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send(IPC.STT_SESSION_ABORTED);
		}
	}
}

export function handleAbortOperation(sttClient: SttClient): void {
	dbg("stt-cmd", "abort-operation: user-triggered cancel");
	// Mark first — even if the awaits below take time to land, any
	// fullSentence / realtime event arriving in the meantime is dropped.
	markSessionAborted();
	abortActiveOllamaChats("user-cancelled-from-hotkey");
	abortServerRecorderIfConnected(sttClient);
	safeHideOverlay();
	broadcastSessionAborted();
}

function isValidNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseAssessOllamaFitSize(payload: unknown): number | null {
	if (!isRecord(payload)) {
		return null;
	}
	const sizeBytes = payload.sizeBytes;
	return isValidNonNegativeFiniteNumber(sizeBytes) ? Math.floor(sizeBytes) : null;
}

async function safeAssessOllamaFit(sttClient: SttClient, sizeBytes: number): Promise<unknown> {
	try {
		return await sttClient.assessOllamaFit(sizeBytes);
	} catch (err) {
		logSttRequestFailure("stt:assess-ollama-fit", err);
		return null;
	}
}

function handleAssessOllamaFit(sttClient: SttClient, payload: unknown): Promise<unknown> {
	const size = parseAssessOllamaFitSize(payload);
	return size === null ? Promise.resolve(null) : safeAssessOllamaFit(sttClient, size);
}

export function setupSttCommandHandlers(sttClient: SttClient): void {
	// Reset the set-parameter / call-method dedup caches when the server
	// disconnects so a reconnect re-syncs the full settings snapshot rather
	// than silently relying on stale state. Caller doesn't need the
	// dispose — these handlers live for the lifetime of the process.
	attachCommandDedupReset(sttClient);

	ipcMain.on("stt:set-parameter", (_event, payload: { parameter: string; value: unknown }) => {
		handleSetParameter(sttClient, payload);
	});

	ipcMain.handle("stt:is-connected", () => sttClient.isConnected);

	ipcMain.handle("stt:get-parameter", (_event, payload: { parameter: string }) =>
		handleGetParameter(sttClient, payload)
	);

	ipcMain.on("stt:call-method", (_event, payload: { method: string; args?: unknown[] }) => {
		handleCallMethod(sttClient, payload);
	});

	// Model swap: forwards to the server's reload_main_model / reload_realtime_model
	// control commands. Server side handles the actual swap on a background thread
	// (see RecorderService.request_model_swap) — this IPC just routes the request.
	// Validated kind so a malformed renderer message can't issue an arbitrary command.
	ipcMain.on("stt:reload-model", (_event, payload: unknown) => {
		handleReloadModel(sttClient, payload);
	});

	ipcMain.handle("gpu:get-info", () => handleGetGpuInfo());

	// Model selector cache + fitness state. Renderer calls this on settings
	// panel open; live invalidation comes through the data-channel
	// model_cache_changed event (relayed via stt:model-cache-changed IPC).
	// Wrapped in `dedupeInflight` so multiple windows mounting in the same
	// tick collapse to one WS round-trip instead of N identical ones.
	ipcMain.handle("stt:list-models-with-state", () =>
		dedupeInflight("list-models-with-state", () => handleListModelsWithState(sttClient))
	);

	// Resource-aware model fitness. Renderer fetches a fresh live snapshot
	// when the settings panel opens (or the refresh button fires) and asks
	// the server for an authoritative assessment when the user picks a
	// candidate. Both calls are pre-ready on the server, so the picker
	// works before any model is loaded.
	// `forceRefresh` is part of the dedup key so a button-triggered force
	// doesn't get collapsed with a lazy mount-time fetch.
	ipcMain.handle("stt:get-live-resources", (_event, payload: unknown) => {
		const force = readForceRefresh(payload);
		return dedupeInflight(`get-live-resources:${String(force)}`, () =>
			safeGetLiveResources(sttClient, force)
		);
	});
	ipcMain.handle("stt:assess-dictation-fit", (_event, payload: unknown) =>
		handleAssessDictationFit(sttClient, payload)
	);
	ipcMain.handle("stt:assess-ollama-fit", (_event, payload: unknown) =>
		handleAssessOllamaFit(sttClient, payload)
	);

	// User clicked the X on the overlay pill (or invoked any other UI-driven
	// cancel). Routes to the same handler the hotkey+Backspace combo uses so
	// both entry points run the full five-step cleanup.
	ipcMain.on("stt:abort-operation", () => {
		handleAbortOperation(sttClient);
	});

	// Stryker disable next-line ArrowFunction: handler thunk; the arrow body is exercised by the audio:get-devices integration test, but Stryker's `() => undefined` mutation returns undefined which is also a valid Promise<AudioDevice[]> ⊂ unknown — equivalent at the IPC layer.
	ipcMain.handle("audio:get-devices", () =>
		dedupeInflight("audio:get-devices", () => handleGetAudioDevices(sttClient))
	);
}

/** Test hook: extracted helpers for direct unit testing. */
export const __stt_commands_test_helpers__ = {
	validateParameterPayload,
	validateMethodPayload,
	areMethodArgsValid,
	handleSetParameter,
	handleGetParameter,
	handleCallMethod,
	handleGetGpuInfo,
	handleGetAudioDevices,
	parseAudioDevices,
	parseReloadModelKind,
	parseReloadModelName,
	parseReloadModelPayload,
	buildReloadModelPayload,
	handleReloadModel,
	handleListModelsWithState,
	handleGetLiveResources,
	handleAssessDictationFit,
	handleAssessOllamaFit,
	parseAssessDictationFitPayload,
	safeAssessDictationFit,
	handleAbortOperation,
};
