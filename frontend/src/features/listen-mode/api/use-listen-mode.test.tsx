import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { useListenStore } from "../model/listen-store";
import { useListenMode } from "./use-listen-mode";

const originalApi = window.electronAPI;
const initialSettings = useSettingsStore.getState().settings;
const sentChannels: string[] = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function makeApi() {
	listeners.clear();
	sentChannels.length = 0;
	return {
		...originalApi,
		invoke: async () => undefined,
		send: (channel: string) => {
			sentChannels.push(channel);
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
	useSettingsStore.setState({ settings: initialSettings });
	useConnectionStore.setState({ connectionStatus: "disconnected" });
	useListenStore.setState({ isListening: false, deviceName: "", devices: [] });
});

afterEach(() => {
	window.electronAPI = originalApi;
	useSettingsStore.setState({ settings: initialSettings });
	useConnectionStore.setState({ connectionStatus: "disconnected" });
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("useListenMode", () => {
	test("subscribes to loopback started/stopped events", () => {
		window.electronAPI = makeApi();
		renderHook(() => useListenMode());
		expect(listeners.has(IPC.STT_LOOPBACK_STARTED)).toBe(true);
		expect(listeners.has(IPC.STT_LOOPBACK_STOPPED)).toBe(true);
	});

	test("loopback-started event sets isListening true with the device name", () => {
		window.electronAPI = makeApi();
		renderHook(() => useListenMode());
		fire(IPC.STT_LOOPBACK_STARTED, { deviceName: "Speakers" });
		const state = useListenStore.getState();
		expect(state.isListening).toBe(true);
		expect(state.deviceName).toBe("Speakers");
	});

	test("loopback-stopped event sets isListening false", () => {
		window.electronAPI = makeApi();
		renderHook(() => useListenMode());
		useListenStore.setState({ isListening: true, deviceName: "Speakers" });
		fire(IPC.STT_LOOPBACK_STOPPED);
		expect(useListenStore.getState().isListening).toBe(false);
	});

	test("starts loopback when mode=listen + connected + device selected", () => {
		window.electronAPI = makeApi();
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, recordingMode: "listen", loopbackDeviceIndex: 3 },
			},
		});
		useConnectionStore.setState({ connectionStatus: "connected" });
		renderHook(() => useListenMode());
		expect(sentChannels).toContain(IPC.LOOPBACK_START);
	});
});
