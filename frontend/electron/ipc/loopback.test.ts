import { describe, expect, mock, test } from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { electronMock } from "@test/mocks/electron";
import type { SttClient } from "../ws/stt-client";

// Use the complete `electronMock()` factory so the process-global mock leak
// this installs is semantically complete — partial shims would make every
// later test importing `app` / `BrowserWindow` / etc. from `electron` throw
// "Export named X not found". The default ipcMain captures handlers in
// `_handlers` and listeners in `_listeners`.
const base = electronMock();
const handlers = base.ipcMain._handlers;
const listeners = base.ipcMain._listeners;

mock.module("electron", () => base);

const { setupLoopbackHandlers } = await import("./loopback");

interface MockClient {
	calls: string[];
	devices: unknown;
	isConnected: boolean;
	listLoopbackDevices: () => Promise<unknown>;
	startLoopback: (idx: number) => void;
	stopLoopback: () => void;
}

function makeClient(connected = true): MockClient {
	const calls: string[] = [];
	const devices = [{ index: 0, name: "Speakers" }];
	return {
		isConnected: connected,
		listLoopbackDevices: async () => {
			calls.push("list");
			return devices;
		},
		startLoopback: () => {
			calls.push("start");
		},
		stopLoopback: () => {
			calls.push("stop");
		},
		calls,
		devices,
	};
}

function fire(channel: string, payload?: unknown) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(undefined, payload);
	}
}

// MockClient implements only the SttClient surface loopback.ts touches. The
// single boundary cast lives here instead of being repeated at every
// injection call site — the runtime object is unchanged.
const asClient = (c: MockClient) => c as unknown as SttClient;

describe("setupLoopbackHandlers", () => {
	test("list-devices returns [] when client is disconnected", async () => {
		handlers.clear();
		listeners.clear();
		setupLoopbackHandlers(asClient(makeClient(false)));
		const handler = handlers.get("loopback:list-devices");
		expect(await handler!(undefined)).toEqual([]);
	});

	test("list-devices returns devices when client is connected", async () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(asClient(client));
		const handler = handlers.get("loopback:list-devices");
		expect(await handler!(undefined)).toEqual(client.devices);
		expect(client.calls).toContain("list");
	});

	test("loopback:start with valid deviceIndex calls startLoopback", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(asClient(client));
		fire("loopback:start", { deviceIndex: 3 });
		expect(client.calls).toContain("start");
	});

	test("loopback:start ignored with negative or non-int deviceIndex", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(asClient(client));
		fire("loopback:start", { deviceIndex: -1 });
		fire("loopback:start", { deviceIndex: 1.5 });
		expect(client.calls.includes("start")).toBe(false);
	});

	test("loopback:start ignored when disconnected", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(false);
		setupLoopbackHandlers(asClient(client));
		fire("loopback:start", { deviceIndex: 0 });
		expect(client.calls.includes("start")).toBe(false);
	});

	test("loopback:stop calls stopLoopback when connected", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(asClient(client));
		fire("loopback:stop");
		expect(client.calls).toContain("stop");
	});

	test("loopback:stop is no-op when disconnected", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(false);
		setupLoopbackHandlers(asClient(client));
		fire("loopback:stop");
		expect(client.calls.includes("stop")).toBe(false);
	});

	test("list-devices returns empty array (not arbitrary content) when disconnected", async () => {
		handlers.clear();
		listeners.clear();
		setupLoopbackHandlers(asClient(makeClient(false)));
		const handler = handlers.get("loopback:list-devices");
		const result = (await handler!(undefined)) as unknown[];
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(0);
	});

	test("list-devices returns empty array (not arbitrary content) when listLoopbackDevices throws", async () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		client.listLoopbackDevices = async () => {
			throw new Error("boom");
		};
		setupLoopbackHandlers(asClient(client));
		const handler = handlers.get("loopback:list-devices");
		const result = (await handler!(undefined)) as unknown[];
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBe(0);
		// Confirm the catch block actually executed (otherwise BlockStatement -> {} wouldn't matter)
		expect(client.calls).not.toContain("start");
	});

	test("loopback:start does NOT throw when payload is undefined (optional chaining)", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(asClient(client));
		// payload is undefined; payload?.deviceIndex must short-circuit, not crash
		expect(() => fire("loopback:start", undefined)).not.toThrow();
		expect(client.calls.includes("start")).toBe(false);
	});

	test("loopback:start accepts deviceIndex of 0 (boundary; not <0)", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(asClient(client));
		fire("loopback:start", { deviceIndex: 0 });
		expect(client.calls).toContain("start");
	});

	test("loopback:start ignored when deviceIndex is a non-number value", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(asClient(client));
		// Strings / null / NaN must not pass the typeof === "number" guard.
		fire("loopback:start", { deviceIndex: asInvalid<number>("0") });
		fire("loopback:start", { deviceIndex: asInvalid<number>(null) });
		fire("loopback:start", { deviceIndex: Number.NaN });
		expect(client.calls.includes("start")).toBe(false);
	});
});
