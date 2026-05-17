import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, type RenderHookResult, renderHook, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";

mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const { useVadCalibration } = await import("./use-vad-calibration");

const originalElectronApi = window.electronAPI;

const settingsSaveCalls: Array<{
	audio: {
		sileroSensitivity: number;
		sileroSensitivityByDeviceName: Record<string, number>;
	};
}> = [];
let onVadAdaptedCb:
	| ((payload: { newSensitivity: number; noiseFloorRms: number; speechPeakRms: number }) => void)
	| null = null;
let audioGetDevicesImpl: () => Promise<Array<{ index: number; name: string; isDefault: boolean }>> =
	async () => [];

function installElectronStub(): void {
	window.electronAPI = {
		getPathForFile: () => "",
		send: (channel: string, payload?: unknown) => {
			if (channel === IPC.SETTINGS_SAVE) {
				const settings = (payload as { settings?: unknown } | undefined)?.settings;
				settingsSaveCalls.push(
					settings as {
						audio: {
							sileroSensitivity: number;
							sileroSensitivityByDeviceName: Record<string, number>;
						};
					}
				);
			}
		},
		invoke: async (channel: string) => {
			if (channel === IPC.AUDIO_GET_DEVICES) {
				return audioGetDevicesImpl();
			}
			return;
		},
		secureInvoke: async () => undefined,
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			if (channel === IPC.STT_VAD_SENSITIVITY_ADAPTED) {
				onVadAdaptedCb = (payload) => cb(payload);
				return () => {
					onVadAdaptedCb = null;
				};
			}
			return () => undefined;
		},
	};
}

function freshSettings() {
	return structuredClone(DEFAULT_SETTINGS);
}

beforeEach(() => {
	settingsSaveCalls.length = 0;
	audioGetDevicesImpl = async () => [];
	onVadAdaptedCb = null;
	installElectronStub();
	useSettingsStore.setState({
		settings: freshSettings(),
	});
});

const mountedHooks: RenderHookResult<unknown, unknown>[] = [];

afterEach(() => {
	for (const handle of mountedHooks.splice(0)) {
		act(() => handle.unmount());
	}
	window.electronAPI = originalElectronApi;
	useSettingsStore.setState({ settings: freshSettings() });
	onVadAdaptedCb = null;
	audioGetDevicesImpl = async () => [];
});

function renderHookWithProviders() {
	const handle = renderHook(() => useVadCalibration());
	mountedHooks.push(handle as unknown as RenderHookResult<unknown, unknown>);
	return handle;
}

async function waitForDeviceListLoaded(name: string) {
	await waitFor(() => {
		// The hook only reacts once useInputDevices has data — devices list
		// arrives via the audio_get_devices IPC promise resolving.
		const { devices } =
			(window.electronAPI as unknown as {
				invoke: () => Promise<unknown[]>;
			}) ?? {};
		if (!devices) {
			// fallback: just yield a tick
			return;
		}
	});
	return name;
}

describe("useVadCalibration — adapt event persistence", () => {
	test("on adapt event with a known current device, persists per-device + bumps live value", async () => {
		audioGetDevicesImpl = async () => [{ index: 5, name: "Bluetooth Headset", isDefault: false }];
		// Saved selection = index 5 → Bluetooth Headset
		useSettingsStore.setState({
			settings: {
				...freshSettings(),
				audio: { ...freshSettings().audio, inputDeviceIndex: 5 },
			},
		});
		renderHookWithProviders();
		// Wait for the input-device list to load through the IPC stub.
		await waitFor(() => {
			expect(onVadAdaptedCb).not.toBeNull();
		});
		await waitForDeviceListLoaded("Bluetooth Headset");
		// Give useInputDevices a tick to populate.
		await new Promise((r) => setTimeout(r, 30));

		act(() => {
			onVadAdaptedCb?.({
				newSensitivity: 0.53,
				noiseFloorRms: 120.0,
				speechPeakRms: 6000.0,
			});
		});

		const after = useSettingsStore.getState().settings.audio;
		expect(after?.sileroSensitivity).toBe(0.53);
		expect(after?.sileroSensitivityByDeviceName?.["Bluetooth Headset"]).toBe(0.53);
		// Persisted to electron-store immediately so a fast close doesn't lose it.
		expect(settingsSaveCalls.length).toBeGreaterThanOrEqual(1);
		expect(
			settingsSaveCalls.at(-1)?.audio?.sileroSensitivityByDeviceName?.["Bluetooth Headset"]
		).toBe(0.53);
	});

	test("on adapt event with no resolvable device, still bumps live value (skips map)", () => {
		// Empty device list → currentDeviceName is null
		audioGetDevicesImpl = async () => [];
		renderHookWithProviders();
		// Without waiting for devices the current name is null.
		act(() => {
			onVadAdaptedCb?.({
				newSensitivity: 0.42,
				noiseFloorRms: 100.0,
				speechPeakRms: 5000.0,
			});
		});
		const after = useSettingsStore.getState().settings.audio;
		expect(after?.sileroSensitivity).toBe(0.42);
		// Map untouched
		expect(Object.keys(after?.sileroSensitivityByDeviceName ?? {}).length).toBe(0);
	});
});

describe("useVadCalibration — device-switch sync", () => {
	test("seeds live sensitivity from the per-device map when device changes", async () => {
		audioGetDevicesImpl = async () => [{ index: 7, name: "USB Mic", isDefault: false }];
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
			expect(useSettingsStore.getState().settings.audio?.sileroSensitivity).toBe(0.62);
		});
	});

	test("does NOT seed when the per-device entry equals the current live value", async () => {
		audioGetDevicesImpl = async () => [{ index: 7, name: "USB Mic", isDefault: false }];
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

		const before = useSettingsStore.getState().settings.audio?.sileroSensitivity;
		renderHookWithProviders();
		await new Promise((r) => setTimeout(r, 30));
		// Unchanged
		expect(useSettingsStore.getState().settings.audio?.sileroSensitivity).toBe(before);
	});

	test("does NOT seed when the device is not in the persisted map (uses live baseline)", async () => {
		audioGetDevicesImpl = async () => [{ index: 4, name: "Built-in Microphone", isDefault: true }];
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
		expect(useSettingsStore.getState().settings.audio?.sileroSensitivity).toBe(0.4);
	});
});
