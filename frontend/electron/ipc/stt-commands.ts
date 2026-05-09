import { ipcMain } from "electron";
import { dbg, dbgVerbose } from "../lib/debug-log";
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
	dbgVerbose("stt-cmd", "set-parameter:", payload.parameter, "=", JSON.stringify(payload.value));
	sttClient.setParameter(payload.parameter, payload.value);
}

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

const CALL_METHOD_LOG_MESSAGES: Record<CallMethodReason, (p: MethodPayload) => string> = {
	invalid: () => "call-method REJECTED (invalid payload)",
	disallowed: (p) => `call-method REJECTED (disallowed): ${p.method}`,
	"bad-args": (p) => `call-method REJECTED (args must be array): ${p.method}`,
	disconnected: (p) => `call-method DROPPED (not connected): ${p.method}`,
};

function logCallMethodRejection(reason: CallMethodReason, payload: MethodPayload): void {
	dbg("stt-cmd", CALL_METHOD_LOG_MESSAGES[reason](payload));
}

function handleCallMethod(sttClient: SttClient, payload: MethodPayload): void {
	const reason = validateMethodPayload(payload, sttClient);
	if (reason) {
		logCallMethodRejection(reason, payload);
		return;
	}
	dbgVerbose("stt-cmd", "call-method:", payload.method, JSON.stringify(payload.args ?? []));
	sttClient.callMethod(payload.method, payload.args);
}

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

interface AudioDevice {
	index: number;
	isDefault: boolean;
	name: string;
}

function isAudioDeviceObject(d: unknown): d is AudioDevice {
	if (typeof d !== "object" || d === null) {
		return false;
	}
	const obj = d as Record<string, unknown>;
	return (
		typeof obj.index === "number" &&
		typeof obj.name === "string" &&
		typeof obj.isDefault === "boolean"
	);
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
		console.warn("[audio] Failed to enumerate input devices via STT server:", err);
		return [];
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

	ipcMain.handle("gpu:get-info", () => handleGetGpuInfo());

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
};
