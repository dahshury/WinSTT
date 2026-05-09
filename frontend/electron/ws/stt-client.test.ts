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

const { SttClient } = await import("./stt-client");

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
});
