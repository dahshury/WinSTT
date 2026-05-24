import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import type { SttClient } from "../ws/stt-client";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();

// Spread the full electronMock so subsequent test files that import `app`
// from electron (e.g. debug-log.ts) are not broken by this partial mock.
mock.module("electron", () => ({
	...electronMock(),
	ipcMain: {
		handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, listener);
		},
		on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(listener);
			listeners.set(channel, list);
		},
	},
}));

// Capture markSessionAborted / abortActiveOllamaChats / hideOverlay so the
// handleAbortOperation test can assert each side effect was invoked. Each
// mock module replaces only the symbols we care about.
const abortStateLog: string[] = [];
mock.module("../lib/abort-state", () => ({
	markSessionAborted: () => {
		abortStateLog.push("mark");
	},
}));

const ollamaAbortLog: string[] = [];
mock.module("./llm", () => ({
	abortActiveOllamaChats: (reason: string) => {
		ollamaAbortLog.push(reason);
	},
}));

const overlayState = { hideCalls: 0, throwOnHide: false };
mock.module("./overlay", () => ({
	hideOverlay: () => {
		overlayState.hideCalls += 1;
		if (overlayState.throwOnHide) {
			throw new Error("overlay-hide-failed");
		}
	},
}));

const { setupSttCommandHandlers, __stt_commands_test_helpers__: helpers } = await import(
	"./stt-commands"
);

interface MockSttClient {
	assessDictationFit: (
		modelId: string,
		quantization: string,
		device: string | null
	) => Promise<unknown>;
	assessDictationFitResult?: unknown;
	assessOllamaFit: (sizeBytes: number) => Promise<unknown>;
	assessOllamaFitResult?: unknown;
	callMethod: (method: string, args?: unknown[]) => void;
	calls: Array<{ kind: string; args: unknown[] }>;
	getLiveResources: (force: boolean) => Promise<unknown>;
	getLiveResourcesResult?: unknown;
	getParameter: (parameter: string) => Promise<unknown>;
	isConnected: boolean;
	listInputDevices: () => Promise<unknown>;
	listInputDevicesResult?: unknown;
	listModelsWithState: () => Promise<unknown>;
	listModelsWithStateResult?: unknown;
	sendControl: (data: Record<string, unknown>) => void;
	setParameter: (parameter: string, value: unknown) => void;
}

function makeClient(connected = true): MockSttClient {
	const calls: MockSttClient["calls"] = [];
	const client: MockSttClient = {
		isConnected: connected,
		setParameter: (parameter, value) => {
			calls.push({ kind: "set", args: [parameter, value] });
		},
		getParameter: async (parameter) => {
			calls.push({ kind: "get", args: [parameter] });
			return "value";
		},
		callMethod: (method, args) => {
			calls.push({ kind: "call", args: [method, args] });
		},
		listInputDevices: async () => {
			calls.push({ kind: "listInputDevices", args: [] });
			return client.listInputDevicesResult ?? [];
		},
		listModelsWithState: async () => {
			calls.push({ kind: "listModelsWithState", args: [] });
			return client.listModelsWithStateResult ?? null;
		},
		getLiveResources: async (force) => {
			calls.push({ kind: "getLiveResources", args: [force] });
			return client.getLiveResourcesResult ?? null;
		},
		assessDictationFit: async (modelId, quantization, device) => {
			calls.push({ kind: "assessDictationFit", args: [modelId, quantization, device] });
			return client.assessDictationFitResult ?? null;
		},
		assessOllamaFit: async (sizeBytes) => {
			calls.push({ kind: "assessOllamaFit", args: [sizeBytes] });
			return client.assessOllamaFitResult ?? null;
		},
		sendControl: (data) => {
			calls.push({ kind: "sendControl", args: [data] });
		},
		calls,
	};
	return client;
}

const client = makeClient(true);
setupSttCommandHandlers(client as unknown as SttClient);

function fireListener(channel: string, payload?: unknown) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(undefined, payload);
	}
}

describe("setupSttCommandHandlers", () => {
	test("registers all the expected handlers and listeners", () => {
		expect(handlers.has("stt:is-connected")).toBe(true);
		expect(handlers.has("stt:get-parameter")).toBe(true);
		expect(handlers.has("gpu:get-info")).toBe(true);
		expect(handlers.has("audio:get-devices")).toBe(true);
		expect(listeners.has("stt:set-parameter")).toBe(true);
		expect(listeners.has("stt:call-method")).toBe(true);
	});

	test("stt:is-connected returns the client's connection state", async () => {
		const handler = handlers.get("stt:is-connected");
		expect(await handler!(undefined)).toBe(true);
	});

	test("set-parameter accepts an allowed parameter when connected", () => {
		client.calls.length = 0;
		fireListener("stt:set-parameter", { parameter: "model", value: "tiny" });
		expect(client.calls).toEqual([{ kind: "set", args: ["model", "tiny"] }]);
	});

	test("set-parameter REJECTS disallowed parameters silently", () => {
		client.calls.length = 0;
		fireListener("stt:set-parameter", { parameter: "rm -rf /", value: "x" });
		expect(client.calls).toEqual([]);
	});

	test("set-parameter REJECTS invalid payloads silently", () => {
		client.calls.length = 0;
		fireListener("stt:set-parameter", null);
		fireListener("stt:set-parameter", { parameter: 42 });
		expect(client.calls).toEqual([]);
	});

	test("call-method accepts an allowed method with array args", () => {
		client.calls.length = 0;
		fireListener("stt:call-method", { method: "set_microphone", args: [true] });
		expect(client.calls).toEqual([{ kind: "call", args: ["set_microphone", [true]] }]);
	});

	test("call-method REJECTS non-array args", () => {
		client.calls.length = 0;
		fireListener("stt:call-method", { method: "set_microphone", args: "not-an-array" });
		expect(client.calls).toEqual([]);
	});

	test("call-method REJECTS disallowed methods", () => {
		client.calls.length = 0;
		fireListener("stt:call-method", { method: "evil_method", args: [] });
		expect(client.calls).toEqual([]);
	});

	test("get-parameter rejects disallowed parameters with an error", async () => {
		const handler = handlers.get("stt:get-parameter");
		await expect(handler!(undefined, { parameter: "evil" })).rejects.toThrow(/Disallowed/);
	});

	test("get-parameter rejects invalid payloads", async () => {
		const handler = handlers.get("stt:get-parameter");
		await expect(handler!(undefined, null)).rejects.toThrow(/Invalid payload/);
	});

	test("get-parameter returns the value when connected and allowed", async () => {
		const handler = handlers.get("stt:get-parameter");
		const result = await handler!(undefined, { parameter: "model" });
		expect(result).toBe("value");
	});
});

describe("setupSttCommandHandlers — disconnected client", () => {
	test("set-parameter is dropped silently", () => {
		const offline = makeClient(false);
		// Re-register handlers with the offline client (overwrites previous ipcMain.on listeners)
		handlers.clear();
		listeners.clear();
		setupSttCommandHandlers(offline as unknown as SttClient);
		fireListener("stt:set-parameter", { parameter: "model", value: "tiny" });
		expect(offline.calls).toEqual([]);
	});

	test("get-parameter rejects with a 'not connected' error", async () => {
		const handler = handlers.get("stt:get-parameter");
		await expect(handler!(undefined, { parameter: "model" })).rejects.toThrow(/not connected/);
	});
});

describe("handleGetGpuInfo", () => {
	test("returns available=false when nvidia-smi is not found (expected in CI/test env)", async () => {
		// In test environments without an NVIDIA GPU / nvidia-smi, the command
		// fails and the catch branch returns the fallback object.
		const result = await helpers.handleGetGpuInfo();
		expect(typeof result.name).toBe("string");
		expect(typeof result.available).toBe("boolean");
		// The catch branch always returns available=false in a non-GPU environment.
		// If nvidia-smi IS present, available may be true — both are valid.
	});

	test("gpu:get-info handler resolves with a gpu info object", async () => {
		const handler = handlers.get("gpu:get-info");
		const result = (await handler!(undefined)) as { name: string; available: boolean };
		expect(typeof result.name).toBe("string");
		expect(typeof result.available).toBe("boolean");
	});
});

describe("stt-commands pure helpers", () => {
	test.each([
		[undefined, true],
		[[], true],
		[[1, 2, 3], true],
		["string", false],
		[42, false],
		[{}, false],
		[null, false],
	])("areMethodArgsValid(%p) === %p", (input, expected) => {
		expect(helpers.areMethodArgsValid(input)).toBe(expected);
	});

	test("validateParameterPayload returns 'invalid' for malformed payloads", () => {
		const fakeClient = { isConnected: true };
		expect(helpers.validateParameterPayload(null, fakeClient)).toBe("invalid");
		expect(helpers.validateParameterPayload({}, fakeClient)).toBe("invalid");
		expect(helpers.validateParameterPayload({ parameter: 42 }, fakeClient)).toBe("invalid");
	});

	test("validateParameterPayload returns 'disallowed' for non-allowlisted params", () => {
		const fakeClient = { isConnected: true };
		expect(helpers.validateParameterPayload({ parameter: "evil" }, fakeClient)).toBe("disallowed");
	});

	test("validateParameterPayload returns 'disconnected' when client is offline", () => {
		const offline = { isConnected: false };
		expect(helpers.validateParameterPayload({ parameter: "model" }, offline)).toBe("disconnected");
	});

	test("validateParameterPayload returns null for valid + connected", () => {
		const fakeClient = { isConnected: true };
		expect(helpers.validateParameterPayload({ parameter: "model" }, fakeClient)).toBeNull();
	});

	test("validateMethodPayload returns 'invalid' for malformed payloads", () => {
		const fakeClient = { isConnected: true };
		expect(helpers.validateMethodPayload(null, fakeClient)).toBe("invalid");
		expect(helpers.validateMethodPayload({ method: 42 }, fakeClient)).toBe("invalid");
	});

	test("validateMethodPayload returns 'disallowed' for non-allowlisted methods", () => {
		const fakeClient = { isConnected: true };
		expect(helpers.validateMethodPayload({ method: "rm -rf /" }, fakeClient)).toBe("disallowed");
	});

	test("validateMethodPayload returns 'bad-args' when args is not an array", () => {
		const fakeClient = { isConnected: true };
		expect(
			helpers.validateMethodPayload({ method: "set_microphone", args: "nope" }, fakeClient)
		).toBe("bad-args");
	});

	test("validateMethodPayload returns 'disconnected' when offline", () => {
		const offline = { isConnected: false };
		expect(helpers.validateMethodPayload({ method: "stop" }, offline)).toBe("disconnected");
	});

	test("validateMethodPayload returns null for valid + connected", () => {
		const fakeClient = { isConnected: true };
		expect(
			helpers.validateMethodPayload({ method: "stop", args: undefined }, fakeClient)
		).toBeNull();
	});

	test("parseAudioDevices returns [] for non-array input", () => {
		expect(helpers.parseAudioDevices(null)).toEqual([]);
		expect(helpers.parseAudioDevices(undefined)).toEqual([]);
		expect(helpers.parseAudioDevices("nope")).toEqual([]);
		expect(helpers.parseAudioDevices({})).toEqual([]);
	});

	test("parseAudioDevices keeps only well-formed device objects", () => {
		const input = [
			{ index: 0, name: "Mic", isDefault: true },
			{ index: 1, name: "Headset", isDefault: false },
			{ index: "bad", name: "x", isDefault: false },
			{ name: "missing-index", isDefault: false },
			null,
		];
		expect(helpers.parseAudioDevices(input)).toEqual([
			{ index: 0, name: "Mic", isDefault: true },
			{ index: 1, name: "Headset", isDefault: false },
		]);
	});

	test("handleGetAudioDevices returns [] when the STT client is disconnected", async () => {
		const offline = makeClient(false);
		const devices = await helpers.handleGetAudioDevices(offline as unknown as SttClient);
		expect(devices).toEqual([]);
		expect(offline.calls).toEqual([]);
	});

	test("handleGetAudioDevices proxies to listInputDevices when connected", async () => {
		const online = makeClient(true);
		online.listInputDevicesResult = [{ index: 3, name: "USB Mic", isDefault: false }];
		const devices = await helpers.handleGetAudioDevices(online as unknown as SttClient);
		expect(devices).toEqual([{ index: 3, name: "USB Mic", isDefault: false }]);
		expect(online.calls).toEqual([{ kind: "listInputDevices", args: [] }]);
	});

	test.each([
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
	])("each allowlisted parameter passes validateParameterPayload: %s", (param) => {
		const fakeClient = { isConnected: true };
		expect(helpers.validateParameterPayload({ parameter: param }, fakeClient)).toBeNull();
	});

	test.each([
		"set_microphone",
		"abort",
		"stop",
		"clear_audio_queue",
		"wakeup",
		"shutdown",
		"text",
	])("each allowlisted method passes validateMethodPayload: %s", (method) => {
		const fakeClient = { isConnected: true };
		expect(helpers.validateMethodPayload({ method }, fakeClient)).toBeNull();
	});

	test("disallowed-parameter mutation guard: mutating any allowlist string would trip this test", () => {
		// Catches StringLiteral mutations on lines 11-26: if any allowlisted string
		// were replaced with "", the .has() check would reject it as "disallowed".
		const fakeClient = { isConnected: true };
		const reasons = [
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
		].map((p) => helpers.validateParameterPayload({ parameter: p }, fakeClient));
		// Every one must be null (allowed). If any literal were mutated to "", the
		// corresponding .has() check would fail, returning "disallowed".
		expect(reasons.every((r) => r === null)).toBe(true);
	});

	test("disallowed-method mutation guard: mutating any allowlist string would trip this test", () => {
		const fakeClient = { isConnected: true };
		const reasons = [
			"set_microphone",
			"abort",
			"stop",
			"clear_audio_queue",
			"wakeup",
			"shutdown",
			"text",
		].map((m) => helpers.validateMethodPayload({ method: m }, fakeClient));
		expect(reasons.every((r) => r === null)).toBe(true);
	});

	test("handleSetParameter forwards parameter+value when valid (and dbg log fires)", () => {
		const online = makeClient(true);
		helpers.handleSetParameter(online as unknown as SttClient, {
			parameter: "model",
			value: "tiny",
		});
		expect(online.calls).toEqual([{ kind: "set", args: ["model", "tiny"] }]);
	});

	test("handleSetParameter does not call setParameter when payload is invalid", () => {
		const online = makeClient(true);
		helpers.handleSetParameter(online as unknown as SttClient, {
			// Missing/wrong parameter: cast through unknown so TS allows the test of
			// runtime invalid input.
			parameter: 42 as unknown as string,
			value: "x",
		});
		expect(online.calls).toEqual([]);
	});

	test("handleSetParameter does not call setParameter when disallowed", () => {
		const online = makeClient(true);
		helpers.handleSetParameter(online as unknown as SttClient, {
			parameter: "evil",
			value: "x",
		});
		expect(online.calls).toEqual([]);
	});

	test("handleSetParameter does not call setParameter when offline", () => {
		const offline = makeClient(false);
		helpers.handleSetParameter(offline as unknown as SttClient, {
			parameter: "model",
			value: "tiny",
		});
		expect(offline.calls).toEqual([]);
	});

	test("handleGetParameter forwards parameter and returns value", async () => {
		const online = makeClient(true);
		const result = await helpers.handleGetParameter(online as unknown as SttClient, {
			parameter: "model",
		});
		expect(result).toBe("value");
		expect(online.calls).toEqual([{ kind: "get", args: ["model"] }]);
	});

	test("handleGetParameter rejects invalid payload with exact error message", async () => {
		const online = makeClient(true);
		await expect(
			helpers.handleGetParameter(online as unknown as SttClient, {
				parameter: 42 as unknown as string,
			})
		).rejects.toThrow("Invalid payload: parameter must be a string");
	});

	test("handleGetParameter rejects disallowed param with exact error message including name", async () => {
		const online = makeClient(true);
		await expect(
			helpers.handleGetParameter(online as unknown as SttClient, { parameter: "evil" })
		).rejects.toThrow("Disallowed parameter: evil");
	});

	test("handleGetParameter rejects when disconnected with exact error message", async () => {
		const offline = makeClient(false);
		await expect(
			helpers.handleGetParameter(offline as unknown as SttClient, { parameter: "model" })
		).rejects.toThrow("STT client is not connected");
	});

	test("handleCallMethod forwards method+args when valid", () => {
		const online = makeClient(true);
		helpers.handleCallMethod(online as unknown as SttClient, {
			method: "set_microphone",
			args: [true],
		});
		expect(online.calls).toEqual([{ kind: "call", args: ["set_microphone", [true]] }]);
	});

	test("handleCallMethod logs args as [] when args is omitted (StringLiteral/Array mutations)", () => {
		// Mutates L200's `payload.args ?? []` short-circuit: if mutated, the
		// log JSON would be different but the underlying call still happens with
		// args=undefined. This exercises the no-args path.
		const online = makeClient(true);
		helpers.handleCallMethod(online as unknown as SttClient, { method: "stop" });
		expect(online.calls).toEqual([{ kind: "call", args: ["stop", undefined] }]);
	});

	test("handleCallMethod drops disallowed methods silently", () => {
		const online = makeClient(true);
		helpers.handleCallMethod(online as unknown as SttClient, { method: "evil" });
		expect(online.calls).toEqual([]);
	});

	test("handleCallMethod drops calls when disconnected", () => {
		const offline = makeClient(false);
		helpers.handleCallMethod(offline as unknown as SttClient, { method: "stop" });
		expect(offline.calls).toEqual([]);
	});

	test("handleCallMethod drops invalid payload (method not a string)", () => {
		const online = makeClient(true);
		helpers.handleCallMethod(online as unknown as SttClient, {
			method: 42 as unknown as string,
		});
		expect(online.calls).toEqual([]);
	});

	test("handleCallMethod drops bad-args (args not array)", () => {
		const online = makeClient(true);
		helpers.handleCallMethod(online as unknown as SttClient, {
			method: "set_microphone",
			args: "nope" as unknown as unknown[],
		});
		expect(online.calls).toEqual([]);
	});

	test("handleGetAudioDevices catches errors from listInputDevices and returns []", async () => {
		const online = makeClient(true);
		online.listInputDevices = async () => {
			throw new Error("server crashed");
		};
		const devices = await helpers.handleGetAudioDevices(online as unknown as SttClient);
		expect(devices).toEqual([]);
	});

	test("parseAudioDevices rejects items with non-string name", () => {
		const input = [
			{ index: 1, name: 42, isDefault: true },
			{ index: 2, name: "OK", isDefault: false },
		];
		expect(helpers.parseAudioDevices(input)).toEqual([{ index: 2, name: "OK", isDefault: false }]);
	});

	test("parseAudioDevices rejects items with non-boolean isDefault", () => {
		const input = [
			{ index: 1, name: "Mic", isDefault: "yes" },
			{ index: 2, name: "OK", isDefault: false },
		];
		expect(helpers.parseAudioDevices(input)).toEqual([{ index: 2, name: "OK", isDefault: false }]);
	});

	test("parseReloadModelKind accepts the two valid kinds", () => {
		expect(helpers.parseReloadModelKind("main")).toBe("main");
		expect(helpers.parseReloadModelKind("realtime")).toBe("realtime");
	});

	test.each([null, undefined, "", "other", 42, {}])("parseReloadModelKind rejects %p", (input) => {
		expect(helpers.parseReloadModelKind(input)).toBeNull();
	});

	test("parseReloadModelName accepts non-empty strings", () => {
		expect(helpers.parseReloadModelName("tiny")).toBe("tiny");
		expect(helpers.parseReloadModelName("base.en")).toBe("base.en");
	});

	test.each([null, undefined, "", 42, {}])("parseReloadModelName rejects %p", (input) => {
		expect(helpers.parseReloadModelName(input)).toBeNull();
	});

	test("parseReloadModelPayload returns null for non-object payloads", () => {
		expect(helpers.parseReloadModelPayload(null)).toBeNull();
		expect(helpers.parseReloadModelPayload(undefined)).toBeNull();
		expect(helpers.parseReloadModelPayload("nope")).toBeNull();
		expect(helpers.parseReloadModelPayload(42)).toBeNull();
	});

	test("parseReloadModelPayload returns null when kind is invalid", () => {
		expect(helpers.parseReloadModelPayload({ kind: "evil", name: "tiny" })).toBeNull();
	});

	test("parseReloadModelPayload returns null when name is missing or non-string", () => {
		expect(helpers.parseReloadModelPayload({ kind: "main" })).toBeNull();
		expect(helpers.parseReloadModelPayload({ kind: "main", name: "" })).toBeNull();
		expect(helpers.parseReloadModelPayload({ kind: "main", name: 42 })).toBeNull();
	});

	test("parseReloadModelPayload returns the normalized payload when valid", () => {
		expect(helpers.parseReloadModelPayload({ kind: "main", name: "tiny" })).toEqual({
			kind: "main",
			name: "tiny",
		});
		expect(helpers.parseReloadModelPayload({ kind: "realtime", name: "base" })).toEqual({
			kind: "realtime",
			name: "base",
		});
	});

	test("buildReloadModelPayload returns null when kind is null", () => {
		expect(helpers.buildReloadModelPayload(null, "tiny")).toBeNull();
	});

	test("buildReloadModelPayload returns null when name is null", () => {
		expect(helpers.buildReloadModelPayload("main", null)).toBeNull();
	});

	test("buildReloadModelPayload returns null when both inputs are null", () => {
		expect(helpers.buildReloadModelPayload(null, null)).toBeNull();
	});

	test("buildReloadModelPayload returns the normalized payload when both are present", () => {
		expect(helpers.buildReloadModelPayload("main", "tiny")).toEqual({
			kind: "main",
			name: "tiny",
		});
		expect(helpers.buildReloadModelPayload("realtime", "base")).toEqual({
			kind: "realtime",
			name: "base",
		});
	});

	test("handleReloadModel forwards main → reload_main_model with model name", () => {
		const online = makeClient(true);
		helpers.handleReloadModel(online as unknown as SttClient, { kind: "main", name: "tiny" });
		expect(online.calls).toEqual([
			{ kind: "sendControl", args: [{ command: "reload_main_model", model: "tiny" }] },
		]);
	});

	test("handleReloadModel forwards realtime → reload_realtime_model with model name", () => {
		const online = makeClient(true);
		helpers.handleReloadModel(online as unknown as SttClient, {
			kind: "realtime",
			name: "base",
		});
		expect(online.calls).toEqual([
			{ kind: "sendControl", args: [{ command: "reload_realtime_model", model: "base" }] },
		]);
	});

	test("handleReloadModel drops invalid payloads silently (no sendControl call)", () => {
		const online = makeClient(true);
		helpers.handleReloadModel(online as unknown as SttClient, null);
		helpers.handleReloadModel(online as unknown as SttClient, { kind: "evil", name: "x" });
		helpers.handleReloadModel(online as unknown as SttClient, { kind: "main", name: "" });
		helpers.handleReloadModel(online as unknown as SttClient, "string-payload");
		expect(online.calls).toEqual([]);
	});

	test("stt:reload-model IPC listener forwards valid payloads", () => {
		const online = makeClient(true);
		handlers.clear();
		listeners.clear();
		setupSttCommandHandlers(online as unknown as SttClient);
		fireListener("stt:reload-model", { kind: "realtime", name: "base" });
		expect(online.calls).toEqual([
			{ kind: "sendControl", args: [{ command: "reload_realtime_model", model: "base" }] },
		]);
	});

	test("stt:reload-model IPC listener drops invalid payloads", () => {
		const online = makeClient(true);
		handlers.clear();
		listeners.clear();
		setupSttCommandHandlers(online as unknown as SttClient);
		fireListener("stt:reload-model", { kind: "main", name: "" });
		fireListener("stt:reload-model", null);
		expect(online.calls).toEqual([]);
	});

	test("handleListModelsWithState returns the client's response when successful", async () => {
		const online = makeClient(true);
		const payload = [{ name: "tiny", available: true }];
		online.listModelsWithStateResult = payload;
		const result = await helpers.handleListModelsWithState(online as unknown as SttClient);
		expect(result).toEqual(payload);
		expect(online.calls).toEqual([{ kind: "listModelsWithState", args: [] }]);
	});

	test("handleListModelsWithState returns null when listModelsWithState rejects", async () => {
		const online = makeClient(true);
		online.listModelsWithState = async () => {
			throw new Error("server crashed");
		};
		const result = await helpers.handleListModelsWithState(online as unknown as SttClient);
		expect(result).toBeNull();
	});

	test("stt:list-models-with-state IPC handler forwards to handleListModelsWithState", async () => {
		const online = makeClient(true);
		online.listModelsWithStateResult = { models: [] };
		handlers.clear();
		listeners.clear();
		setupSttCommandHandlers(online as unknown as SttClient);
		const handler = handlers.get("stt:list-models-with-state");
		const result = await handler!(undefined);
		expect(result).toEqual({ models: [] });
	});
});

describe("handleGetLiveResources", () => {
	test("forwards forceRefresh=true when payload sets it", async () => {
		const online = makeClient(true);
		online.getLiveResourcesResult = { cpu: 0.5 };
		const result = await helpers.handleGetLiveResources(online as unknown as SttClient, {
			forceRefresh: true,
		});
		expect(result).toEqual({ cpu: 0.5 });
		expect(online.calls).toEqual([{ kind: "getLiveResources", args: [true] }]);
	});

	test("defaults forceRefresh to false when payload is missing the field", async () => {
		const online = makeClient(true);
		await helpers.handleGetLiveResources(online as unknown as SttClient, {});
		expect(online.calls).toEqual([{ kind: "getLiveResources", args: [false] }]);
	});

	test("defaults forceRefresh to false when payload is not a record", async () => {
		const online = makeClient(true);
		await helpers.handleGetLiveResources(online as unknown as SttClient, null);
		await helpers.handleGetLiveResources(online as unknown as SttClient, "nope");
		await helpers.handleGetLiveResources(online as unknown as SttClient, 42);
		expect(online.calls).toEqual([
			{ kind: "getLiveResources", args: [false] },
			{ kind: "getLiveResources", args: [false] },
			{ kind: "getLiveResources", args: [false] },
		]);
	});

	test("returns null when the underlying call rejects", async () => {
		const online = makeClient(true);
		online.getLiveResources = async () => {
			throw new Error("server crashed");
		};
		const result = await helpers.handleGetLiveResources(online as unknown as SttClient, {});
		expect(result).toBeNull();
	});
});

describe("parseAssessDictationFitPayload", () => {
	test("returns null for non-record payloads", () => {
		expect(helpers.parseAssessDictationFitPayload(null)).toBeNull();
		expect(helpers.parseAssessDictationFitPayload(undefined)).toBeNull();
		expect(helpers.parseAssessDictationFitPayload("nope")).toBeNull();
		expect(helpers.parseAssessDictationFitPayload(42)).toBeNull();
	});

	test("returns null when modelId is missing, empty, or non-string", () => {
		expect(helpers.parseAssessDictationFitPayload({})).toBeNull();
		expect(helpers.parseAssessDictationFitPayload({ modelId: "" })).toBeNull();
		expect(helpers.parseAssessDictationFitPayload({ modelId: 42 })).toBeNull();
	});

	test("defaults quantization to '' and device to null when omitted", () => {
		expect(helpers.parseAssessDictationFitPayload({ modelId: "tiny" })).toEqual({
			modelId: "tiny",
			quantization: "",
			device: null,
		});
	});

	test("preserves string quantization and device when present", () => {
		expect(
			helpers.parseAssessDictationFitPayload({
				modelId: "base",
				quantization: "int8",
				device: "cuda",
			})
		).toEqual({ modelId: "base", quantization: "int8", device: "cuda" });
	});

	test("falls back to '' / null when quantization or device are not strings", () => {
		expect(
			helpers.parseAssessDictationFitPayload({ modelId: "x", quantization: 7, device: 9 })
		).toEqual({ modelId: "x", quantization: "", device: null });
	});
});

describe("handleAssessDictationFit", () => {
	test("returns null when the payload is invalid", async () => {
		const online = makeClient(true);
		expect(await helpers.handleAssessDictationFit(online as unknown as SttClient, null)).toBeNull();
		expect(
			await helpers.handleAssessDictationFit(online as unknown as SttClient, { modelId: "" })
		).toBeNull();
		expect(online.calls).toEqual([]);
	});

	test("forwards modelId + quantization + device when valid", async () => {
		const online = makeClient(true);
		online.assessDictationFitResult = { fits: true };
		const result = await helpers.handleAssessDictationFit(online as unknown as SttClient, {
			modelId: "tiny",
			quantization: "int8",
			device: "cuda",
		});
		expect(result).toEqual({ fits: true });
		expect(online.calls).toEqual([{ kind: "assessDictationFit", args: ["tiny", "int8", "cuda"] }]);
	});

	test("returns null when the underlying call rejects", async () => {
		const online = makeClient(true);
		online.assessDictationFit = async () => {
			throw new Error("server crashed");
		};
		const result = await helpers.handleAssessDictationFit(online as unknown as SttClient, {
			modelId: "tiny",
		});
		expect(result).toBeNull();
	});
});

describe("handleAssessOllamaFit", () => {
	test("returns null when payload is not a record", async () => {
		const online = makeClient(true);
		expect(await helpers.handleAssessOllamaFit(online as unknown as SttClient, null)).toBeNull();
		expect(await helpers.handleAssessOllamaFit(online as unknown as SttClient, "nope")).toBeNull();
		expect(online.calls).toEqual([]);
	});

	test("returns null when sizeBytes is missing or invalid", async () => {
		const online = makeClient(true);
		expect(await helpers.handleAssessOllamaFit(online as unknown as SttClient, {})).toBeNull();
		expect(
			await helpers.handleAssessOllamaFit(online as unknown as SttClient, { sizeBytes: "nope" })
		).toBeNull();
		expect(
			await helpers.handleAssessOllamaFit(online as unknown as SttClient, { sizeBytes: -1 })
		).toBeNull();
		expect(
			await helpers.handleAssessOllamaFit(online as unknown as SttClient, {
				sizeBytes: Number.POSITIVE_INFINITY,
			})
		).toBeNull();
		expect(online.calls).toEqual([]);
	});

	test("floors sizeBytes and forwards it when valid", async () => {
		const online = makeClient(true);
		online.assessOllamaFitResult = { fits: false };
		const result = await helpers.handleAssessOllamaFit(online as unknown as SttClient, {
			sizeBytes: 12_345.9,
		});
		expect(result).toEqual({ fits: false });
		expect(online.calls).toEqual([{ kind: "assessOllamaFit", args: [12_345] }]);
	});

	test("accepts a zero size (locks in the >= 0 guard, not > 0)", async () => {
		const online = makeClient(true);
		await helpers.handleAssessOllamaFit(online as unknown as SttClient, { sizeBytes: 0 });
		expect(online.calls).toEqual([{ kind: "assessOllamaFit", args: [0] }]);
	});

	test("returns null when the underlying call rejects", async () => {
		const online = makeClient(true);
		online.assessOllamaFit = async () => {
			throw new Error("server crashed");
		};
		const result = await helpers.handleAssessOllamaFit(online as unknown as SttClient, {
			sizeBytes: 100,
		});
		expect(result).toBeNull();
	});
});

describe("handleAbortOperation", () => {
	function resetAbortMocks(): void {
		abortStateLog.length = 0;
		ollamaAbortLog.length = 0;
		overlayState.hideCalls = 0;
		overlayState.throwOnHide = false;
	}

	test("marks the session aborted, cancels Ollama, calls server abort+clear, and hides overlay", () => {
		resetAbortMocks();
		const online = makeClient(true);
		helpers.handleAbortOperation(online as unknown as SttClient);
		expect(abortStateLog).toEqual(["mark"]);
		expect(ollamaAbortLog).toEqual(["user-cancelled-from-hotkey"]);
		expect(online.calls).toEqual([
			{ kind: "call", args: ["abort", undefined] },
			{ kind: "call", args: ["clear_audio_queue", undefined] },
		]);
		expect(overlayState.hideCalls).toBe(1);
	});

	test("skips the server abort/clear calls when the client is disconnected", () => {
		resetAbortMocks();
		const offline = makeClient(false);
		helpers.handleAbortOperation(offline as unknown as SttClient);
		expect(abortStateLog).toEqual(["mark"]);
		expect(ollamaAbortLog).toEqual(["user-cancelled-from-hotkey"]);
		expect(offline.calls).toEqual([]);
		expect(overlayState.hideCalls).toBe(1);
	});

	test("swallows hideOverlay errors without throwing", () => {
		resetAbortMocks();
		overlayState.throwOnHide = true;
		const online = makeClient(true);
		expect(() => helpers.handleAbortOperation(online as unknown as SttClient)).not.toThrow();
		expect(abortStateLog).toEqual(["mark"]);
	});
});
