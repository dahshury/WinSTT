import { describe, expect, mock, test } from "bun:test";

// ── Mock `ws` BEFORE importing the SUT ───────────────────────────────
// stt-client.ts does `import WebSocket from "ws"` and uses both
// `new WebSocket(url)` and the `WebSocket.OPEN` static constant.

interface MockMessageEvent {
	data: string;
}

class MockWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static CONNECTING = 0;
	static CLOSING = 2;

	readyState: number = MockWebSocket.CONNECTING;
	url: string;
	sent: string[] = [];
	closeCalled = 0;

	onopen: (() => void) | null = null;
	onmessage: ((event: MockMessageEvent) => void) | null = null;
	onerror: ((err: unknown) => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
		MockWebSocket.created.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closeCalled += 1;
		this.readyState = MockWebSocket.CLOSED;
	}

	// Test helpers
	fireOpen(): void {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.();
	}

	fireMessage(data: string): void {
		this.onmessage?.({ data });
	}

	fireError(err: unknown): void {
		this.onerror?.(err);
	}

	fireClose(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	}

	static created: MockWebSocket[] = [];
	static reset(): void {
		MockWebSocket.created = [];
	}
}

mock.module("ws", () => ({
	default: MockWebSocket,
	WebSocket: MockWebSocket,
}));

mock.module("../lib/debug-log", () => ({
	dbg: () => undefined,
	dbgVerbose: () => undefined,
}));

const {
	SttClient,
	dataMessagePreview,
	controlMessagePreview,
	isObjectPayload,
	parseControlMessage,
	resolveSttClientOptions,
} = await import("./stt-client");

describe("dataMessagePreview", () => {
	test("stringifies non-null objects and clips to 100 chars", () => {
		const obj = { type: undefined, payload: "x".repeat(200) };
		const out = dataMessagePreview(obj);
		expect(out.length).toBeLessThanOrEqual(100);
	});
	test("uses String() for primitives", () => {
		expect(dataMessagePreview(42)).toBe("42");
		expect(dataMessagePreview("hello")).toBe("hello");
	});
	test("treats null as a primitive (not an object)", () => {
		expect(dataMessagePreview(null)).toBe("null");
	});
});

function getSockets(): { control: MockWebSocket; data: MockWebSocket } {
	const all = MockWebSocket.created;
	if (all.length < 2) {
		throw new Error(`Expected 2 sockets, got ${all.length}`);
	}
	const control = all.at(-2);
	const data = all.at(-1);
	if (!(control && data)) {
		throw new Error("Sockets missing");
	}
	return { control, data };
}

describe("SttClient", () => {
	test("constructor accepts default options", () => {
		const client = new SttClient();
		expect(client.isConnected).toBe(false);
	});

	test("constructor accepts custom host and ports", () => {
		MockWebSocket.reset();
		const client = new SttClient({
			host: "example.com",
			controlPort: 9000,
			dataPort: 9001,
		});
		// Trigger connectInternal so we can read the URLs from the sockets
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		expect(control.url).toBe("ws://example.com:9000");
		expect(data.url).toBe("ws://example.com:9001");
		client.disconnect();
	});

	test("connect resolves once both sockets fire onopen", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		const connected = new Promise<void>((resolve) => client.once("connected", resolve));
		const promise = client.connect();
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		await promise;
		await connected;
		expect(client.isConnected).toBe(true);
		// list_models is sent on connect
		expect(control.sent.some((m) => m.includes("list_models"))).toBe(true);
		client.disconnect();
	});

	test("sendControl writes JSON to the control socket when open", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		control.sent.length = 0;
		client.sendControl({ command: "noop" });
		expect(control.sent).toEqual([JSON.stringify({ command: "noop" })]);
		client.disconnect();
	});

	test("sendControl is a no-op when control socket is not OPEN", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		// no connect() — controlWs is null
		client.sendControl({ command: "ignored" });
		// Nothing should throw or be sent
		expect(MockWebSocket.created.length).toBe(0);
	});

	test("setParameter sends a set_parameter command", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		control.sent.length = 0;
		client.setParameter("model", "tiny");
		const parsed = JSON.parse(control.sent[0] ?? "{}");
		expect(parsed).toEqual({ command: "set_parameter", parameter: "model", value: "tiny" });
		client.disconnect();
	});

	test("callMethod sends a call_method command with default empty args", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		control.sent.length = 0;
		client.callMethod("set_microphone");
		const parsed = JSON.parse(control.sent[0] ?? "{}");
		expect(parsed).toEqual({ command: "call_method", method: "set_microphone", args: [] });
		client.disconnect();
	});

	test("startLoopback / stopLoopback emit the expected commands", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		control.sent.length = 0;
		client.startLoopback(3);
		client.stopLoopback();
		expect(JSON.parse(control.sent[0] ?? "{}")).toEqual({
			command: "start_loopback",
			device_index: 3,
		});
		expect(JSON.parse(control.sent[1] ?? "{}")).toEqual({ command: "stop_loopback" });
		client.disconnect();
	});

	test("getParameter rejects when not connected", async () => {
		const client = new SttClient();
		await expect(client.getParameter("model")).rejects.toThrow(/not connected/i);
	});

	test("getParameter resolves when the server sends a matching request_id", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		control.sent.length = 0;

		const promise = client.getParameter("model");
		const sent = JSON.parse(control.sent[0] ?? "{}") as { request_id: number };
		expect(typeof sent.request_id).toBe("number");

		// Server replies on the control channel with the same request_id
		control.fireMessage(JSON.stringify({ request_id: sent.request_id, value: "tiny" }));

		const result = await promise;
		expect(result).toBe("tiny");
		client.disconnect();
	});

	test("control message with type='server_ready' emits 'server-ready'", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		const ready = new Promise<void>((resolve) => client.once("server-ready", resolve));
		control.fireMessage(JSON.stringify({ type: "server_ready" }));
		await ready;
		client.disconnect();
	});

	test("control message with command='list_models' emits 'model-catalog'", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		const models = new Promise<unknown>((resolve) =>
			client.once("model-catalog", (m: unknown) => resolve(m))
		);
		control.fireMessage(JSON.stringify({ command: "list_models", models: [{ id: "tiny" }] }));
		const got = await models;
		expect(got).toEqual([{ id: "tiny" }]);
		client.disconnect();
	});

	test("data channel messages with a 'type' field emit 'data-event'", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		const event = new Promise<unknown>((resolve) =>
			client.once("data-event", (m: unknown) => resolve(m))
		);
		data.fireMessage(JSON.stringify({ type: "vad_start" }));
		const got = await event;
		expect(got).toMatchObject({ type: "vad_start" });
		client.disconnect();
	});

	test("malformed control JSON does not throw", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		expect(() => control.fireMessage("not-json")).not.toThrow();
		client.disconnect();
	});

	test("disconnect closes both sockets and disables reconnect", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		expect(client.isConnected).toBe(true);
		client.disconnect();
		expect(control.closeCalled).toBeGreaterThanOrEqual(1);
		expect(data.closeCalled).toBeGreaterThanOrEqual(1);
		expect(client.isConnected).toBe(false);
	});

	test("connection error from socket fails the connect() promise", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		// Catch error event to prevent unhandled error event
		client.on("error", () => undefined);
		const promise = client.connect();
		const { control } = getSockets();
		control.fireError(new Error("boom"));
		await expect(promise).rejects.toThrow();
		client.disconnect();
	});

	test("socket close after successful connect triggers handleClose and emits disconnected", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		const disconnected = new Promise<void>((resolve) => client.once("disconnected", resolve));
		control.fireClose();
		await disconnected;
		// scheduleReconnect should have been called — client emits "reconnecting"
		// We just verify it doesn't throw and the client is no longer connected.
		expect(client.isConnected).toBe(false);
		client.disconnect();
	});

	test("handleClose is idempotent — second close does not double-emit disconnected", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		let disconnectedCount = 0;
		client.on("disconnected", () => {
			disconnectedCount += 1;
		});
		control.fireClose();
		data.fireClose();
		// Small delay to let async handlers settle
		await new Promise<void>((r) => setTimeout(r, 10));
		expect(disconnectedCount).toBe(1);
		client.disconnect();
	});

	test("malformed data JSON does not throw", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		expect(() => data.fireMessage("not-json")).not.toThrow();
		client.disconnect();
	});

	test("data message missing type field is rejected by schema validation", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		// Message without 'type' field fails schema validation — should not throw or emit data-event
		const events: unknown[] = [];
		client.on("data-event", (e) => events.push(e));
		expect(() => data.fireMessage(JSON.stringify({ payload: "no-type" }))).not.toThrow();
		expect(events.length).toBe(0);
		client.disconnect();
	});

	test("control message with unknown request_id is ignored gracefully", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		// request_id that has no pending request — should not throw
		expect(() =>
			control.fireMessage(JSON.stringify({ request_id: 9999, value: "whatever" }))
		).not.toThrow();
		client.disconnect();
	});

	test("listLoopbackDevices rejects when not connected", async () => {
		const client = new SttClient();
		await expect(client.listLoopbackDevices()).rejects.toThrow(/not connected/i);
	});

	test("listInputDevices rejects when not connected", async () => {
		const client = new SttClient();
		await expect(client.listInputDevices()).rejects.toThrow(/not connected/i);
	});

	test("scheduleReconnect is skipped when shouldReconnect is false (after disconnect)", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		let reconnectingFired = false;
		client.on("reconnecting", () => {
			reconnectingFired = true;
		});
		// Disable reconnect before closing
		client.disconnect();
		// Simulate socket close after disconnect — handleClose should skip scheduleReconnect
		control.fireClose();
		await new Promise<void>((r) => setTimeout(r, 50));
		expect(reconnectingFired).toBe(false);
	});

	test("disconnect rejects all pending requests", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		const promise = client.getParameter("model").catch((e: Error) => e.message);
		client.disconnect();
		const msg = await promise;
		expect(typeof msg).toBe("string");
		expect(msg).toMatch(/disconnect/i);
	});

	test("server_ready with runtime_info object emits runtime-info as a separate event", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		const info = new Promise<unknown>((resolve) =>
			client.once("runtime-info", (i: unknown) => resolve(i))
		);
		control.fireMessage(
			JSON.stringify({ type: "server_ready", runtime_info: { provider: "cpu" } })
		);
		const got = await info;
		expect(got).toEqual({ provider: "cpu" });
		client.disconnect();
	});

	test("server_ready without runtime_info emits server-ready only (no runtime-info)", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		let runtimeInfoFired = false;
		client.on("runtime-info", () => {
			runtimeInfoFired = true;
		});
		const ready = new Promise<void>((resolve) => client.once("server-ready", resolve));
		control.fireMessage(JSON.stringify({ type: "server_ready" }));
		await ready;
		expect(runtimeInfoFired).toBe(false);
		client.disconnect();
	});

	test("get_runtime_info response emits runtime-info", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		const info = new Promise<unknown>((resolve) =>
			client.once("runtime-info", (i: unknown) => resolve(i))
		);
		control.fireMessage(
			JSON.stringify({ command: "get_runtime_info", value: { provider: "gpu" } })
		);
		const got = await info;
		expect(got).toEqual({ provider: "gpu" });
		client.disconnect();
	});

	test("get_runtime_info with non-object value does not emit runtime-info", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		let runtimeInfoFired = false;
		client.on("runtime-info", () => {
			runtimeInfoFired = true;
		});
		// value is a string, not an object — handler should skip the emit
		control.fireMessage(JSON.stringify({ command: "get_runtime_info", value: "not-an-object" }));
		expect(runtimeInfoFired).toBe(false);
		client.disconnect();
	});

	test("list_models with non-array models is ignored (no model-catalog emit)", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		let catalogFired = false;
		client.on("model-catalog", () => {
			catalogFired = true;
		});
		control.fireMessage(JSON.stringify({ command: "list_models", models: "oops" }));
		expect(catalogFired).toBe(false);
		client.disconnect();
	});

	test("unknown control event type is dispatched as control-message only", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();

		const events: unknown[] = [];
		client.on("server-ready", () => events.push("server-ready"));
		client.on("model-catalog", () => events.push("model-catalog"));

		const generic = new Promise<unknown>((resolve) =>
			client.once("control-message", (m: unknown) => resolve(m))
		);
		control.fireMessage(JSON.stringify({ type: "totally_unknown" }));
		const msg = await generic;
		expect(msg).toMatchObject({ type: "totally_unknown" });
		expect(events).toEqual([]);
		client.disconnect();
	});

	test("control message with long raw body is truncated by preview helper", async () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		// Long body — covers the preview ternary truthy branch via dbgVerbose call site.
		const big = JSON.stringify({ type: "server_ready", filler: "x".repeat(300) });
		expect(() => control.fireMessage(big)).not.toThrow();
		client.disconnect();
	});

	test("control message that fails schema validation is logged and dropped", () => {
		MockWebSocket.reset();
		const client = new SttClient();
		client.connect().catch(() => undefined);
		const { control, data } = getSockets();
		control.fireOpen();
		data.fireOpen();
		// `type` must be a string per the schema — number violates it.
		let serverReadyFired = false;
		client.on("server-ready", () => {
			serverReadyFired = true;
		});
		expect(() => control.fireMessage(JSON.stringify({ type: 42 }))).not.toThrow();
		expect(serverReadyFired).toBe(false);
		client.disconnect();
	});
});

describe("resolveSttClientOptions", () => {
	test("returns full defaults when options is empty", () => {
		const out = resolveSttClientOptions({});
		expect(out).toEqual({ host: "localhost", controlPort: 8011, dataPort: 8012 });
	});

	test("preserves caller-supplied fields and fills the rest", () => {
		expect(resolveSttClientOptions({ host: "h" })).toEqual({
			host: "h",
			controlPort: 8011,
			dataPort: 8012,
		});
		expect(resolveSttClientOptions({ controlPort: 1 })).toEqual({
			host: "localhost",
			controlPort: 1,
			dataPort: 8012,
		});
		expect(resolveSttClientOptions({ dataPort: 2 })).toEqual({
			host: "localhost",
			controlPort: 8011,
			dataPort: 2,
		});
	});
});

describe("isObjectPayload", () => {
	test("returns true for plain object", () => {
		expect(isObjectPayload({ foo: 1 })).toBe(true);
	});
	test("returns true for arrays (object-typed)", () => {
		expect(isObjectPayload([1, 2])).toBe(true);
	});
	test("returns false for null", () => {
		expect(isObjectPayload(null)).toBe(false);
	});
	test("returns false for primitives", () => {
		expect(isObjectPayload(undefined)).toBe(false);
		expect(isObjectPayload("s")).toBe(false);
		expect(isObjectPayload(0)).toBe(false);
		expect(isObjectPayload(false)).toBe(false);
	});
});

describe("parseControlMessage", () => {
	test("returns parsed object for valid JSON", () => {
		expect(parseControlMessage('{"a":1}')).toEqual({ a: 1 });
	});
	test("returns undefined and logs on malformed JSON", () => {
		expect(parseControlMessage("not-json")).toBeUndefined();
	});
});

describe("controlMessagePreview", () => {
	test("returns the raw body when shorter than the budget", () => {
		expect(controlMessagePreview("short")).toBe("short");
	});
	test("clips bodies over 200 chars with an ellipsis", () => {
		const long = "x".repeat(250);
		const out = controlMessagePreview(long);
		expect(out.length).toBe(201);
		expect(out.endsWith("…")).toBe(true);
	});
});
