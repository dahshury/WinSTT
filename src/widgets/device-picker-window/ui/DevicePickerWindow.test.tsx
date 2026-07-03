import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { commands } from "@/bindings";
import { _resetInputDevicesCacheForTests } from "@/entities/audio-device/model/use-input-devices";
import { IPC } from "@/shared/api/ipc-channels";
import { DevicePickerWindow } from "./DevicePickerWindow";

const originalBridge = window.nativeBridge;
const originalGetSettings = commands.winsttGetSettings;
const originalGetAudioDevices = commands.getAudioDevices;
const originalRefreshAudioDevices = commands.refreshAudioDevices;
const originalResizeWindow = commands.resizeWindow;
const originalStart = commands.startMicrophoneLevelMonitor;
const originalStop = commands.stopMicrophoneLevelMonitor;
let startCalls = 0;
let stopCalls = 0;

type BridgeListener = (...args: unknown[]) => void;
let bridgeListeners = new Map<string, BridgeListener[]>();

function recordStart(): void {
	startCalls += 1;
}

function recordStop(): void {
	stopCalls += 1;
}

async function flushReactEffects() {
	await act(async () => {
		await Promise.resolve();
	});
}

function installNativeBridgeStub(): void {
	bridgeListeners = new Map<string, BridgeListener[]>();
	window.nativeBridge = {
		...window.nativeBridge,
		getPathForFile: () => "",
		invoke: async (channel: string) => {
			if (channel === IPC.AUDIO_START_MICROPHONE_LEVEL_MONITOR) {
				recordStart();
				return undefined;
			}
			if (channel === IPC.AUDIO_STOP_MICROPHONE_LEVEL_MONITOR) {
				recordStop();
				return undefined;
			}
			if (
				channel === IPC.AUDIO_GET_DEVICES ||
				channel === IPC.AUDIO_REFRESH_DEVICES
			) {
				return [];
			}
			if (channel === IPC.SETTINGS_LOAD) {
				return {};
			}
			return undefined;
		},
		on: (channel, cb) => {
			const list = bridgeListeners.get(channel) ?? [];
			list.push(cb);
			bridgeListeners.set(channel, list);
			return () => {
				bridgeListeners.set(
					channel,
					(bridgeListeners.get(channel) ?? []).filter(
						(listener) => listener !== cb,
					),
				);
			};
		},
		secureInvoke: async () => undefined,
		send: () => {},
	} satisfies typeof window.nativeBridge;
}

beforeEach(() => {
	_resetInputDevicesCacheForTests();
	startCalls = 0;
	stopCalls = 0;
	installNativeBridgeStub();
	commands.winsttGetSettings = (async () =>
		({}) as Awaited<
			ReturnType<typeof commands.winsttGetSettings>
		>) satisfies typeof commands.winsttGetSettings;
	commands.getAudioDevices = (async () => []) satisfies typeof commands.getAudioDevices;
	commands.refreshAudioDevices = (async () =>
		[]) satisfies typeof commands.refreshAudioDevices;
	commands.resizeWindow = (async () => ({
		status: "ok",
		data: null,
	})) satisfies typeof commands.resizeWindow;
	commands.startMicrophoneLevelMonitor = (async () => {
		recordStart();
	}) satisfies typeof commands.startMicrophoneLevelMonitor;
	commands.stopMicrophoneLevelMonitor = (async () => {
		recordStop();
	}) satisfies typeof commands.stopMicrophoneLevelMonitor;
});

afterEach(() => {
	cleanup();
	window.nativeBridge = originalBridge;
	commands.winsttGetSettings = originalGetSettings;
	commands.getAudioDevices = originalGetAudioDevices;
	commands.refreshAudioDevices = originalRefreshAudioDevices;
	commands.resizeWindow = originalResizeWindow;
	commands.startMicrophoneLevelMonitor = originalStart;
	commands.stopMicrophoneLevelMonitor = originalStop;
	_resetInputDevicesCacheForTests();
});

describe("DevicePickerWindow", () => {
	test("does NOT start the mic level monitor while hidden (prewarmed at boot)", async () => {
		render(
			<IntlProvider>
				<DevicePickerWindow />
			</IntlProvider>,
		);
		await flushReactEffects();
		expect(startCalls).toBe(0);
	});

	test("starts metering when shown and stops when hidden again", async () => {
		render(
			<IntlProvider>
				<DevicePickerWindow />
			</IntlProvider>,
		);
		await flushReactEffects();
		await act(async () => {
			window.dispatchEvent(new Event("winstt:device-picker-shown"));
		});
		await waitFor(() => expect(startCalls).toBeGreaterThan(0));
		expect(stopCalls).toBe(0);
		await act(async () => {
			window.dispatchEvent(new Event("winstt:device-picker-hidden"));
		});
		await waitFor(() => expect(stopCalls).toBeGreaterThan(0));
	});
});
