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

describe("setupLoopbackHandlers", () => {
	test("list-devices returns [] when client is disconnected", async () => {
		handlers.clear();
		listeners.clear();
		setupLoopbackHandlers(makeClient(false) as unknown as SttClient);
		const handler = handlers.get("loopback:list-devices");
		expect(await handler!(undefined)).toEqual([]);
	});

	test("list-devices returns devices when client is connected", async () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(client as unknown as SttClient);
		const handler = handlers.get("loopback:list-devices");
		expect(await handler!(undefined)).toEqual(client.devices);
		expect(client.calls).toContain("list");
	});

	test("loopback:start with valid deviceIndex calls startLoopback", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(client as unknown as SttClient);
		fire("loopback:start", { deviceIndex: 3 });
		expect(client.calls).toContain("start");
	});

	test("loopback:start ignored with negative or non-int deviceIndex", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(client as unknown as SttClient);
		fire("loopback:start", { deviceIndex: -1 });
		fire("loopback:start", { deviceIndex: 1.5 });
		expect(client.calls.includes("start")).toBe(false);
	});

	test("loopback:start ignored when disconnected", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(false);
		setupLoopbackHandlers(client as unknown as SttClient);
		fire("loopback:start", { deviceIndex: 0 });
		expect(client.calls.includes("start")).toBe(false);
	});

	test("loopback:stop calls stopLoopback when connected", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(true);
		setupLoopbackHandlers(client as unknown as SttClient);
		fire("loopback:stop");
		expect(client.calls).toContain("stop");
	});

	test("loopback:stop is no-op when disconnected", () => {
		handlers.clear();
		listeners.clear();
		const client = makeClient(false);
		setupLoopbackHandlers(client as unknown as SttClient);
		fire("loopback:stop");
		expect(client.calls.includes("stop")).toBe(false);
	});
});
