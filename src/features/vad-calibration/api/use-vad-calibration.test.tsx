import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import {
	act,
	type RenderHookResult,
	renderHook,
	waitFor,
} from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";

mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const { useVadCalibration } = await import("./use-vad-calibration");

const originalNativeBridge = window.nativeBridge;

let audioGetDevicesImpl: () => Promise<
	Array<{ index: number; name: string; isDefault: boolean }>
> = async () => [];

function installNativeBridgeStub(): void {
	window.nativeBridge = {
		getPathForFile: () => "",
		send: () => undefined,
		invoke: async (channel: string) => {
			if (channel === IPC.AUDIO_GET_DEVICES) {
				return audioGetDevicesImpl();
			}
			return;
		},
		secureInvoke: async () => undefined,
		on: () => () => undefined,
	};
}

function freshSettings() {
	return structuredClone(DEFAULT_SETTINGS);
}

beforeEach(() => {
	audioGetDevicesImpl = async () => [];
	installNativeBridgeStub();
	useSettingsStore.setState({
		settings: freshSettings(),
	});
});

const mountedHooks: RenderHookResult<unknown, unknown>[] = [];

afterEach(() => {
	for (const handle of mountedHooks.splice(0)) {
		act(() => handle.unmount());
	}
	window.nativeBridge = originalNativeBridge;
	useSettingsStore.setState({ settings: freshSettings() });
	audioGetDevicesImpl = async () => [];
});

function renderHookWithProviders() {
	const handle = renderHook(() => useVadCalibration());
	mountedHooks.push(handle as unknown as RenderHookResult<unknown, unknown>);
	return handle;
}

describe("useVadCalibration — device-switch sync", () => {
	test("seeds live sensitivity from the per-device map when device changes", async () => {
		audioGetDevicesImpl = async () => [
			{ index: 7, name: "USB Mic", isDefault: false },
		];
		useSettingsStore.setState({
			settings: {
				...freshSettings(),
				audio: {
					...freshSettings().audio,
					inputDeviceIndex: 7,
					sileroSensitivity: 0.4,
					sileroSensitivityByDeviceName: { "USB Mic": 0.62 },
				},
			},
		});

		renderHookWithProviders();
		// Wait for the seed effect.
		await waitFor(() => {
			expect(
				useSettingsStore.getState().settings.audio?.sileroSensitivity,
			).toBe(0.62);
		});
	});

	test("does NOT seed when the per-device entry equals the current live value", async () => {
		audioGetDevicesImpl = async () => [
			{ index: 7, name: "USB Mic", isDefault: false },
		];
		useSettingsStore.setState({
			settings: {
				...freshSettings(),
				audio: {
					...freshSettings().audio,
					inputDeviceIndex: 7,
					sileroSensitivity: 0.55,
					sileroSensitivityByDeviceName: { "USB Mic": 0.55 },
				},
			},
		});

		const before =
			useSettingsStore.getState().settings.audio?.sileroSensitivity;
		renderHookWithProviders();
		await new Promise((r) => setTimeout(r, 30));
		// Unchanged
		expect(useSettingsStore.getState().settings.audio?.sileroSensitivity).toBe(
			before,
		);
	});

	test("does NOT seed when the device is not in the persisted map (uses live baseline)", async () => {
		audioGetDevicesImpl = async () => [
			{ index: 4, name: "Built-in Microphone", isDefault: true },
		];
		useSettingsStore.setState({
			settings: {
				...freshSettings(),
				audio: {
					...freshSettings().audio,
					inputDeviceIndex: 4,
					sileroSensitivity: 0.4,
					sileroSensitivityByDeviceName: { "Some Other Mic": 0.7 },
				},
			},
		});
		renderHookWithProviders();
		await new Promise((r) => setTimeout(r, 30));
		// Live baseline untouched — no per-device override applies.
		expect(useSettingsStore.getState().settings.audio?.sileroSensitivity).toBe(
			0.4,
		);
	});
});
