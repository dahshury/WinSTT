import { describe, expect, mock, test } from "bun:test";

// ── Override the global `WebSocket` BEFORE importing the SUT ─────────
// stt-client.ts uses the native global `WebSocket` (Node 22+ / Electron 42)
// and reads the `WebSocket.OPEN` static constant. Replacing the global
// gives the SUT a deterministic test double for both `new WebSocket(url)`
// and `WebSocket.OPEN` checks.

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

// Override the global the SUT reads at runtime. Bun's `globalThis.WebSocket`
// is its own implementation by default; the SUT calls `new WebSocket(url)`
// and `WebSocket.OPEN` so both shape-points need our test double.
(globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket;

const { debugLogMock } = await import("@test/mocks/debug-log");
mock.module("../lib/debug-log", () => debugLogMock());

// Spread `electronMock()` (imported below) so the process-global mock leak
// this installs is semantically complete — partial shims would make every
// later test importing `BrowserWindow`/`Tray`/etc. from `electron` throw
// "Export named X not found". With electron properly mocked, the real
// `electron/lib/sentry-main` loads fine (its `app` import resolves through
// the mock) and `breadcrumb()` becomes a no-op (no DSN configured). NOT
// mocking sentry-main avoids a process-global module leak that would
// poison `electron/lib/sentry-main.test.ts` — bun 1.3.6 doesn't isolate
// mock.module across test files.
const { electronMock } = await import("@test/mocks/electron");
mock.module("electron", () => electronMock());

const {
	SttClient,
	dataMessagePreview,
	controlMessagePreview,
	parseControlMessage,
	resolveSttClientOptions,
	decodeBinaryFrame,
	classifyDataFrame,
	tryParseJsonAsArray,
	buildTtsSynthesizeAction,
	emitBinaryFrame,
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

describe("tryParseJsonAsArray", () => {
	test("returns [value] for valid JSON", () => {
		expect(tryParseJsonAsArray('{"a":1}')).toEqual([{ a: 1 }]);
	});
	test("returns [] for malformed JSON (no throw)", () => {
		expect(tryParseJsonAsArray("not-json")).toEqual([]);
	});
});

describe("decodeBinaryFrame", () => {
	function makeFrame(headerObj: Record<string, unknown>, pcm: Buffer): Buffer {
		const headerJson = Buffer.from(JSON.stringify(headerObj), "utf8");
		const prefix = Buffer.alloc(4);
		prefix.writeUInt32LE(headerJson.length, 0);
		return Buffer.concat([prefix, headerJson, pcm]);
	}

	test("decodes [u32 LE meta_len][JSON][PCM] into {header, pcm}", () => {
		const pcm = Buffer.from([1, 2, 3, 4]);
		const buf = makeFrame({ request_id: "abc", final: false }, pcm);
		const out = decodeBinaryFrame(buf);
		expect(out).toHaveLength(1);
		expect(out[0]?.header).toEqual({ request_id: "abc", final: false });
		expect(Buffer.compare(out[0]?.pcm ?? Buffer.alloc(0), pcm)).toBe(0);
	});

	test("returns [] when the buffer is shorter than the 4-byte length prefix", () => {
		expect(decodeBinaryFrame(Buffer.alloc(0))).toEqual([]);
		expect(decodeBinaryFrame(Buffer.from([1, 2, 3]))).toEqual([]);
	});

	test("returns [] when meta_len is zero", () => {
		const buf = Buffer.alloc(8);
		buf.writeUInt32LE(0, 0);
		expect(decodeBinaryFrame(buf)).toEqual([]);
	});

	test("returns [] when meta_len overflows the buffer", () => {
		const buf = Buffer.alloc(8);
		buf.writeUInt32LE(999_999, 0);
		expect(decodeBinaryFrame(buf)).toEqual([]);
	});

	test("returns [] when the metadata slice is not valid JSON", () => {
		const garbage = Buffer.from("not-json", "utf8");
		const prefix = Buffer.alloc(4);
		prefix.writeUInt32LE(garbage.length, 0);
		const buf = Buffer.concat([prefix, garbage, Buffer.from([9, 9])]);
		expect(decodeBinaryFrame(buf)).toEqual([]);
	});

	test("yields an empty PCM payload when the buffer ends at the header", () => {
		const buf = makeFrame({ k: "v" }, Buffer.alloc(0));
		const out = decodeBinaryFrame(buf);
		expect(out).toHaveLength(1);
		expect(out[0]?.pcm.length).toBe(0);
	});
});

describe("classifyDataFrame", () => {
	test("routes Node Buffer payloads to the binary handler", () => {
		const buffers: Buffer[] = [];
		const texts: string[] = [];
		const buf = Buffer.from([1, 2, 3]);
		classifyDataFrame(buf, {
			binary: (b) => buffers.push(b),
			text: (t) => texts.push(t),
		});
		expect(buffers).toEqual([buf]);
		expect(texts).toEqual([]);
	});

	test("routes ArrayBuffer payloads to the binary handler (converted to Buffer)", () => {
		const buffers: Buffer[] = [];
		const ab = new ArrayBuffer(3);
		new Uint8Array(ab).set([4, 5, 6]);
		classifyDataFrame(ab, {
			binary: (b) => buffers.push(b),
			text: () => undefined,
		});
		expect(buffers).toHaveLength(1);
		expect(Array.from(buffers[0] ?? Buffer.alloc(0))).toEqual([4, 5, 6]);
	});

	test("routes string payloads to the text handler", () => {
		const texts: string[] = [];
		classifyDataFrame("hello", {
			binary: () => undefined,
			text: (t) => texts.push(t),
		});
		expect(texts).toEqual(["hello"]);
	});

	test("ignores payloads that are neither Buffer, ArrayBuffer, nor string", () => {
		let binaryCount = 0;
		let textCount = 0;
		classifyDataFrame(
			{ unknown: "shape" },
			{
				binary: () => binaryCount++,
				text: () => textCount++,
			}
		);
		classifyDataFrame(null, {
			binary: () => binaryCount++,
			text: () => textCount++,
		});
		classifyDataFrame(undefined, {
			binary: () => binaryCount++,
			text: () => textCount++,
		});
		expect(binaryCount).toBe(0);
		expect(textCount).toBe(0);
	});
});

describe("emitBinaryFrame", () => {
	test("emits 'data-binary' when frame is defined", () => {
		const { EventEmitter } = require("node:events") as typeof import("node:events");
		const emitter = new EventEmitter();
		const seen: unknown[] = [];
		emitter.on("data-binary", (f: unknown) => seen.push(f));
		emitBinaryFrame(emitter, { header: { k: "v" }, pcm: Buffer.from([1, 2]) });
		expect(seen).toHaveLength(1);
	});

	test("is a no-op when frame is undefined", () => {
		const { EventEmitter } = require("node:events") as typeof import("node:events");
		const emitter = new EventEmitter();
		let count = 0;
		emitter.on("data-binary", () => count++);
		emitBinaryFrame(emitter, undefined);
		expect(count).toBe(0);
	});
});

describe("buildTtsSynthesizeAction", () => {
	test("applies defaults for voice='', lang='', speed=1.0 when omitted", () => {
		expect(buildTtsSynthesizeAction({ requestId: "r1", text: "hello world" })).toEqual({
			command: "tts_synthesize",
			request_id: "r1",
			text: "hello world",
			voice: "",
			lang: "",
			speed: 1.0,
		});
	});

	test("preserves caller-supplied voice/lang/speed values", () => {
		expect(
			buildTtsSynthesizeAction({
				requestId: "r2",
				text: "bonjour",
				voice: "af_bella",
				lang: "fr",
				speed: 1.25,
			})
		).toEqual({
			command: "tts_synthesize",
			request_id: "r2",
			text: "bonjour",
			voice: "af_bella",
			lang: "fr",
			speed: 1.25,
		});
	});
});
