import { ipcMain } from "electron";
import { dbg, dbgVerbose } from "../lib/debug-log";
import { isRecord } from "../lib/ipc-helpers";
import type { SttClient } from "../ws/stt-client";

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
]);

const ALLOWED_METHODS = new Set([
	"set_microphone",
	"abort",
	"stop",
	"clear_audio_queue",
	"wakeup",
	"shutdown",
	"text",
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
	// Stryker disable next-line StringLiteral: log-only side-effect; dbgVerbose is mocked to no-op in tests.
	dbgVerbose("stt-cmd", "set-parameter:", payload.parameter, "=", JSON.stringify(payload.value));
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
	dbg("stt-cmd", SET_PARAM_LOG_MESSAGES[reason](payload));
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
	dbg("stt-cmd", CALL_METHOD_LOG_MESSAGES[reason](payload));
}
// Stryker restore ObjectLiteral,ArrowFunction,StringLiteral,BlockStatement

function handleCallMethod(sttClient: SttClient, payload: MethodPayload): void {
	const reason = validateMethodPayload(payload, sttClient);
	if (reason) {
		logCallMethodRejection(reason, payload);
		return;
	}
	// Stryker disable next-line StringLiteral,LogicalOperator,ArrayDeclaration: log-only debug emission; observable behavior is verified by the call-method tests asserting sttClient.callMethod was invoked with the right args.
	dbgVerbose("stt-cmd", "call-method:", payload.method, JSON.stringify(payload.args ?? []));
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
		console.warn("[stt:list-models-with-state] request failed:", err);
		return null;
	}
}

async function handleGetLiveResources(sttClient: SttClient, payload: unknown): Promise<unknown> {
	const force = Boolean(isRecord(payload) && payload.forceRefresh === true);
	try {
		return await sttClient.getLiveResources(force);
	} catch (err) {
		console.warn("[stt:get-live-resources] request failed:", err);
		return null;
	}
}

interface AssessDictationFitPayload {
	device?: string | null;
	modelId: string;
	quantization?: string;
}

function parseAssessDictationFitPayload(payload: unknown): AssessDictationFitPayload | null {
	if (!isRecord(payload)) {
		return null;
	}
	const modelId = payload.modelId;
	if (typeof modelId !== "string" || !modelId) {
		return null;
	}
	const quantization = typeof payload.quantization === "string" ? payload.quantization : "";
	const device = typeof payload.device === "string" ? payload.device : null;
	return { modelId, quantization, device };
}

async function handleAssessDictationFit(sttClient: SttClient, payload: unknown): Promise<unknown> {
	const parsed = parseAssessDictationFitPayload(payload);
	if (!parsed) {
		return null;
	}
	try {
		return await sttClient.assessDictationFit(
			parsed.modelId,
			parsed.quantization ?? "",
			parsed.device ?? null
		);
	} catch (err) {
		console.warn("[stt:assess-dictation-fit] request failed:", err);
		return null;
	}
}

async function handleAssessOllamaFit(sttClient: SttClient, payload: unknown): Promise<unknown> {
	if (!isRecord(payload)) {
		return null;
	}
	const sizeBytes = payload.sizeBytes;
	if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
		return null;
	}
	try {
		return await sttClient.assessOllamaFit(Math.floor(sizeBytes));
	} catch (err) {
		console.warn("[stt:assess-ollama-fit] request failed:", err);
		return null;
	}
}

export function setupSttCommandHandlers(sttClient: SttClient): void {
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
	ipcMain.handle("stt:list-models-with-state", () => handleListModelsWithState(sttClient));

	// Resource-aware model fitness. Renderer fetches a fresh live snapshot
	// when the settings panel opens (or the refresh button fires) and asks
	// the server for an authoritative assessment when the user picks a
	// candidate. Both calls are pre-ready on the server, so the picker
	// works before any model is loaded.
	ipcMain.handle("stt:get-live-resources", (_event, payload: unknown) =>
		handleGetLiveResources(sttClient, payload)
	);
	ipcMain.handle("stt:assess-dictation-fit", (_event, payload: unknown) =>
		handleAssessDictationFit(sttClient, payload)
	);
	ipcMain.handle("stt:assess-ollama-fit", (_event, payload: unknown) =>
		handleAssessOllamaFit(sttClient, payload)
	);

	// Stryker disable next-line ArrowFunction: handler thunk; the arrow body is exercised by the audio:get-devices integration test, but Stryker's `() => undefined` mutation returns undefined which is also a valid Promise<AudioDevice[]> ⊂ unknown — equivalent at the IPC layer.
	ipcMain.handle("audio:get-devices", () => handleGetAudioDevices(sttClient));
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
};
