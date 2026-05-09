import { describe, expect, mock, test } from "bun:test";
import type { SttClient } from "../ws/stt-client";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();

mock.module("electron", () => ({
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
mock.module("../lib/debug-log", () => ({
	dbg: () => undefined,
	dbgVerbose: () => undefined,
}));

const { setupSttCommandHandlers, __stt_commands_test_helpers__: helpers } = await import(
	"./stt-commands"
);

interface MockSttClient {
	callMethod: (method: string, args?: unknown[]) => void;
	calls: Array<{ kind: string; args: unknown[] }>;
	getParameter: (parameter: string) => Promise<unknown>;
	isConnected: boolean;
	listInputDevices: () => Promise<unknown>;
	listInputDevicesResult?: unknown;
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
});
