import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { applyDevicesResult, useLoopbackDevices } from "./use-loopback-devices";

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

describe("applyDevicesResult", () => {
	test("does nothing when cancelled", () => {
		const setOptions = (_opts: unknown[]) => {
			throw new Error("should not call setOptions");
		};
		const handler = applyDevicesResult({
			getIsCancelled: () => true,
			currentDeviceIndex: null,
			setDefaultIndex: () => undefined,
			setOptions: setOptions as never,
			update: () => undefined,
		});
		handler([{ index: 0, name: "X", defaultSampleRate: 48_000, maxOutputChannels: 2 }]);
		// no throw = test passes
	});

	test("does nothing when devices is not an array", () => {
		let called = false;
		const handler = applyDevicesResult({
			getIsCancelled: () => false,
			currentDeviceIndex: null,
			setDefaultIndex: () => {
				called = true;
			},
			setOptions: () => undefined,
			update: () => undefined,
		});
		handler("not-an-array");
		expect(called).toBe(false);
	});

	test("sets options and defaultIndex from valid device list", () => {
		let optsCount = 0;
		let idx: number | null = null;
		const handler = applyDevicesResult({
			getIsCancelled: () => false,
			currentDeviceIndex: null,
			setDefaultIndex: (i) => {
				idx = i;
			},
			setOptions: (o) => {
				optsCount = o.length;
			},
			update: () => undefined,
		});
		handler([
			{
				index: 5,
				name: "Speakers",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
		]);
		expect(optsCount).toBeGreaterThan(0);
		expect(idx as unknown as number).toBe(5);
	});

	test("calls update when currentDeviceIndex is null and defaultIndex is found", () => {
		let updated = false;
		const handler = applyDevicesResult({
			getIsCancelled: () => false,
			currentDeviceIndex: null,
			setDefaultIndex: () => undefined,
			setOptions: () => undefined,
			update: () => {
				updated = true;
			},
		});
		handler([
			{
				index: 5,
				name: "Speakers",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
		]);
		expect(updated).toBe(true);
	});

	test("does not call update when currentDeviceIndex is already set", () => {
		let updated = false;
		const handler = applyDevicesResult({
			getIsCancelled: () => false,
			currentDeviceIndex: 3,
			setDefaultIndex: () => undefined,
			setOptions: () => undefined,
			update: () => {
				updated = true;
			},
		});
		handler([
			{
				index: 5,
				name: "Speakers",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
		]);
		expect(updated).toBe(false);
	});
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
