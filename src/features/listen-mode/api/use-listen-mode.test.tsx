import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { useListenStore } from "../model/listen-store";
import {
	applyLoopbackTransition,
	handleLoopbackListError,
	useListenMode,
	validateDevices,
} from "./use-listen-mode";

const originalApi = window.nativeBridge;
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
	window.nativeBridge = originalApi;
	useSettingsStore.setState({ settings: initialSettings });
	useConnectionStore.setState({ connectionStatus: "disconnected" });
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

describe("validateDevices", () => {
	test("returns valid devices from a raw array", () => {
		const raw = [
			{ index: 0, name: "Speakers", defaultSampleRate: 48_000, maxOutputChannels: 2 },
			{ index: 1, name: "Mic", defaultSampleRate: 44_100, maxOutputChannels: 0 },
		];
		const result = validateDevices(raw);
		expect(result).toHaveLength(2);
		expect(result[0]?.name).toBe("Speakers");
	});

	test("drops entries that fail Zod validation", () => {
		const raw = [
			{ index: 0, name: "Valid", defaultSampleRate: 48_000, maxOutputChannels: 2 },
			{ index: "bad", name: 42 }, // invalid
		];
		const result = validateDevices(raw);
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("Valid");
	});

	test("returns empty array for empty input", () => {
		expect(validateDevices([])).toEqual([]);
	});
});

describe("applyLoopbackTransition", () => {
	test("calls loopbackStart when mode=listen, device set, and connected", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition("listen", false, 3, "connected");
		expect(sentChannels).toContain(IPC.LOOPBACK_START);
	});

	test("does not call loopbackStart when device index is null", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition("listen", false, null, "connected");
		expect(sentChannels).not.toContain(IPC.LOOPBACK_START);
	});

	test("calls loopbackStop when transitioning away from listen mode", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition("ptt", true, null, "connected");
		expect(sentChannels).toContain(IPC.LOOPBACK_STOP);
	});

	test("does not call loopbackStop when not connected", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition("ptt", true, null, "disconnected");
		expect(sentChannels).not.toContain(IPC.LOOPBACK_STOP);
	});
});

describe("handleLoopbackListError", () => {
	const originalError = console.error;
	let calls: unknown[][] = [];

	beforeEach(() => {
		calls = [];
		console.error = (...args: unknown[]) => {
			calls.push(args);
		};
	});

	afterEach(() => {
		console.error = originalError;
	});

	test("logs the error when the effect was not cancelled", () => {
		const err = new Error("boom");
		handleLoopbackListError(err, false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]).toBe(err);
	});

	test("logs non-Error rejection values", () => {
		handleLoopbackListError("string-rejection", false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]).toBe("string-rejection");
	});

	test("does not log when the effect was cancelled", () => {
		handleLoopbackListError(new Error("ignored"), true);
		expect(calls).toHaveLength(0);
	});
});

describe("useListenMode", () => {
	test("subscribes to loopback started/stopped events", () => {
		window.nativeBridge = makeApi();
		renderHook(() => useListenMode());
		expect(listeners.has(IPC.STT_LOOPBACK_STARTED)).toBe(true);
		expect(listeners.has(IPC.STT_LOOPBACK_STOPPED)).toBe(true);
	});

	test("loopback-started event sets isListening true with the device name", () => {
		window.nativeBridge = makeApi();
		renderHook(() => useListenMode());
		fire(IPC.STT_LOOPBACK_STARTED, { deviceName: "Speakers" });
		const state = useListenStore.getState();
		expect(state.isListening).toBe(true);
		expect(state.deviceName).toBe("Speakers");
	});

	test("loopback-stopped event sets isListening false", () => {
		window.nativeBridge = makeApi();
		renderHook(() => useListenMode());
		useListenStore.setState({ isListening: true, deviceName: "Speakers" });
		fire(IPC.STT_LOOPBACK_STOPPED);
		expect(useListenStore.getState().isListening).toBe(false);
	});

	test("starts loopback when mode=listen + connected + device selected", () => {
		window.nativeBridge = makeApi();
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
