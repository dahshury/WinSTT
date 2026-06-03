import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useConnectionStore } from "@/entities/connection";
import { IPC } from "@/shared/api/ipc-channels";
import { useConnectionListener } from "./use-connection-listener";

const originalApi = window.nativeBridge;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function makeApi(invokeImpl?: (channel: string) => unknown) {
	listeners.clear();
	return {
		...originalApi,
		invoke: async (channel: string) => {
			if (invokeImpl) {
				return invokeImpl(channel);
			}
			return;
		},
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
				);
			};
		},
	};
}

beforeEach(() => {
	useConnectionStore.setState({
		connectionStatus: "disconnected",
		gpuInfo: null,
		serverStatus: "idle",
	});
});

afterEach(() => {
	window.nativeBridge = originalApi;
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useConnectionListener", () => {
	test("subscribes to connection-change and server-status channels", () => {
		window.nativeBridge = makeApi();
		renderHook(() => useConnectionListener());
		expect(listeners.has(IPC.STT_CONNECTION_CHANGE)).toBe(true);
		expect(listeners.has(IPC.STT_SERVER_STATUS)).toBe(true);
	});

	test("queries STT_IS_CONNECTED on mount and seeds connection state if true", async () => {
		window.nativeBridge = makeApi((channel) => {
			if (channel === IPC.STT_IS_CONNECTED) {
				return true;
			}
			return;
		});
		renderHook(() => useConnectionListener());
		await waitFor(() => {
			expect(useConnectionStore.getState().connectionStatus).toBe("connected");
		});
	});

	test("connection-change events update the store status", () => {
		window.nativeBridge = makeApi();
		renderHook(() => useConnectionListener());
		fire(IPC.STT_CONNECTION_CHANGE, { connected: true });
		expect(useConnectionStore.getState().connectionStatus).toBe("connected");
		fire(IPC.STT_CONNECTION_CHANGE, { connected: false });
		expect(useConnectionStore.getState().connectionStatus).toBe("disconnected");
		// disconnect also resets serverStatus to idle
		expect(useConnectionStore.getState().serverStatus).toBe("idle");
	});

	test("server-status events update the store serverStatus", () => {
		window.nativeBridge = makeApi();
		renderHook(() => useConnectionListener());
		fire(IPC.STT_SERVER_STATUS, { status: "running" });
		expect(useConnectionStore.getState().serverStatus).toBe("running");
	});

	test("unmount unsubscribes all listeners", () => {
		window.nativeBridge = makeApi();
		const { unmount } = renderHook(() => useConnectionListener());
		unmount();
		expect(listeners.get(IPC.STT_CONNECTION_CHANGE)?.length ?? 0).toBe(0);
		expect(listeners.get(IPC.STT_SERVER_STATUS)?.length ?? 0).toBe(0);
	});
});
