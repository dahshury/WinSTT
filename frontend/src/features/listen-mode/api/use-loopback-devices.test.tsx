import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { useLoopbackDevices } from "./use-loopback-devices";

const originalApi = window.electronAPI;
const initialSettings = useSettingsStore.getState().settings;

function makeApi(devices: unknown[]) {
	return {
		...originalApi,
		invoke: async (channel: string) => {
			if (channel === IPC.LOOPBACK_LIST_DEVICES) {
				return devices;
			}
			return;
		},
		on: () => () => undefined,
		send: () => undefined,
	};
}

beforeEach(() => {
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			general: { ...initialSettings.general, recordingMode: "listen", loopbackDeviceIndex: null },
		},
	});
});

afterEach(() => {
	window.electronAPI = originalApi;
	useSettingsStore.setState({ settings: initialSettings });
});

describe("useLoopbackDevices", () => {
	test("returns no options before devices arrive (mode != listen)", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, recordingMode: "ptt" },
			},
		});
		window.electronAPI = makeApi([]);
		const { result } = renderHook(() => useLoopbackDevices());
		expect(result.current.options).toEqual([]);
	});

	test("populates options with a System Default entry plus per-device entries", async () => {
		window.electronAPI = makeApi([
			{
				index: 0,
				name: "Speakers",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
			{ index: 1, name: "Headphones", defaultSampleRate: 48_000, maxOutputChannels: 2 },
		]);
		const { result } = renderHook(() => useLoopbackDevices());
		await waitFor(() => {
			expect(result.current.options.length).toBeGreaterThan(0);
		});
		expect(result.current.options[0]?.id).toBe("default");
		expect(result.current.options[0]?.label).toContain("Speakers");
		expect(result.current.options[1]?.label).toBe("Speakers");
		expect(result.current.options[2]?.label).toBe("Headphones");
	});

	test("auto-selects the default device index when none was chosen", async () => {
		window.electronAPI = makeApi([
			{
				index: 5,
				name: "Output",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
		]);
		renderHook(() => useLoopbackDevices());
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.general.loopbackDeviceIndex).toBe(5);
		});
	});

	test("handleChange('default') stores the underlying default index", async () => {
		window.electronAPI = makeApi([
			{ index: 5, name: "Out", defaultSampleRate: 48_000, maxOutputChannels: 2, isDefault: true },
		]);
		const { result } = renderHook(() => useLoopbackDevices());
		await waitFor(() => {
			expect(result.current.options.length).toBeGreaterThan(0);
		});
		act(() => result.current.handleChange("default"));
		expect(useSettingsStore.getState().settings.general.loopbackDeviceIndex).toBe(5);
	});

	test("handleChange(numeric string) stores the numeric index", async () => {
		window.electronAPI = makeApi([
			{ index: 0, name: "A", defaultSampleRate: 48_000, maxOutputChannels: 2, isDefault: true },
			{ index: 7, name: "B", defaultSampleRate: 48_000, maxOutputChannels: 2 },
		]);
		const { result } = renderHook(() => useLoopbackDevices());
		await waitFor(() => {
			expect(result.current.options.length).toBeGreaterThan(0);
		});
		act(() => result.current.handleChange("7"));
		expect(useSettingsStore.getState().settings.general.loopbackDeviceIndex).toBe(7);
	});
});
