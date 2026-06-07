import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import {
	applyDevicesResult,
	handleFetchError,
	resolveCurrentId,
	useLoopbackDevices,
} from "./use-loopback-devices";

const originalApi = window.nativeBridge;
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
			general: {
				...initialSettings.general,
				recordingMode: "listen",
				loopbackDeviceIndex: null,
			},
		},
	});
});

afterEach(() => {
	window.nativeBridge = originalApi;
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
		handler([
			{ index: 0, name: "X", defaultSampleRate: 48_000, maxOutputChannels: 2 },
		]);
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

	test("filters out devices whose schema parse fails (parseDevices invalid branch)", () => {
		let optsLen = 0;
		const handler = applyDevicesResult({
			getIsCancelled: () => false,
			currentDeviceIndex: 0,
			setDefaultIndex: () => undefined,
			setOptions: (o) => {
				optsLen = o.length;
			},
			update: () => undefined,
		});
		handler([
			{
				index: 0,
				name: "Good",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
			},
			{ totally: "wrong shape" },
			null,
			"string-is-not-a-device",
			{
				index: "not-a-number",
				name: "Bad",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
			},
		]);
		// 1 valid device + the "default" entry = 2 options
		expect(optsLen).toBe(2);
	});
});

describe("handleFetchError", () => {
	test("does nothing when cancelled", () => {
		const original = console.error;
		let called = false;
		console.error = () => {
			called = true;
		};
		try {
			handleFetchError(() => true)(new Error("boom"));
			expect(called).toBe(false);
		} finally {
			console.error = original;
		}
	});

	test("logs when not cancelled", () => {
		const original = console.error;
		let called = false;
		console.error = () => {
			called = true;
		};
		try {
			handleFetchError(() => false)(new Error("boom"));
			expect(called).toBe(true);
		} finally {
			console.error = original;
		}
	});
});

describe("resolveCurrentId", () => {
	test("returns 'default' when loopbackDeviceIndex is null", () => {
		expect(resolveCurrentId(null, 5)).toBe("default");
	});

	test("returns 'default' when loopbackDeviceIndex is undefined", () => {
		expect(resolveCurrentId(undefined, 5)).toBe("default");
	});

	test("returns 'default' when loopbackDeviceIndex matches defaultIndex", () => {
		expect(resolveCurrentId(7, 7)).toBe("default");
	});

	test("returns the numeric string when loopbackDeviceIndex differs from defaultIndex", () => {
		expect(resolveCurrentId(3, 5)).toBe("3");
	});

	test("returns the numeric string when defaultIndex is null but a device is selected", () => {
		expect(resolveCurrentId(3, null)).toBe("3");
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
		window.nativeBridge = makeApi([]);
		const { result } = renderHook(() => useLoopbackDevices());
		expect(result.current.options).toEqual([]);
	});

	test("populates options with a System Default entry plus per-device entries", async () => {
		window.nativeBridge = makeApi([
			{
				index: 0,
				name: "Speakers",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
			{
				index: 1,
				name: "Headphones",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
			},
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
		window.nativeBridge = makeApi([
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
			expect(
				useSettingsStore.getState().settings.general.loopbackDeviceIndex,
			).toBe(5);
		});
	});

	test("handleChange('default') stores the underlying default index", async () => {
		window.nativeBridge = makeApi([
			{
				index: 5,
				name: "Out",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
		]);
		const { result } = renderHook(() => useLoopbackDevices());
		await waitFor(() => {
			expect(result.current.options.length).toBeGreaterThan(0);
		});
		act(() => result.current.handleChange("default"));
		expect(
			useSettingsStore.getState().settings.general.loopbackDeviceIndex,
		).toBe(5);
	});

	test("handleChange(numeric string) stores the numeric index", async () => {
		window.nativeBridge = makeApi([
			{
				index: 0,
				name: "A",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
			{ index: 7, name: "B", defaultSampleRate: 48_000, maxOutputChannels: 2 },
		]);
		const { result } = renderHook(() => useLoopbackDevices());
		await waitFor(() => {
			expect(result.current.options.length).toBeGreaterThan(0);
		});
		act(() => result.current.handleChange("7"));
		expect(
			useSettingsStore.getState().settings.general.loopbackDeviceIndex,
		).toBe(7);
	});

	test("currentId is 'default' when the stored index matches the detected default", async () => {
		window.nativeBridge = makeApi([
			{
				index: 9,
				name: "Spk",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
		]);
		const { result } = renderHook(() => useLoopbackDevices());
		await waitFor(() => {
			expect(result.current.options.length).toBeGreaterThan(0);
		});
		await waitFor(() => {
			expect(result.current.currentId).toBe("default");
		});
	});

	test("currentId reflects an explicit non-default selection", async () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					recordingMode: "listen",
					loopbackDeviceIndex: 4,
				},
			},
		});
		window.nativeBridge = makeApi([
			{
				index: 1,
				name: "A",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
				isDefault: true,
			},
			{ index: 4, name: "B", defaultSampleRate: 48_000, maxOutputChannels: 2 },
		]);
		const { result } = renderHook(() => useLoopbackDevices());
		await waitFor(() => {
			expect(result.current.options.length).toBeGreaterThan(0);
		});
		expect(result.current.currentId).toBe("4");
	});

	test("handleChange('default') stores null when no system default was detected", () => {
		// recordingMode is "ptt" so the fetch effect never runs and defaultIndex stays null.
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					recordingMode: "ptt",
					loopbackDeviceIndex: 2,
				},
			},
		});
		window.nativeBridge = makeApi([]);
		const { result } = renderHook(() => useLoopbackDevices());
		act(() => result.current.handleChange("default"));
		expect(
			useSettingsStore.getState().settings.general.loopbackDeviceIndex,
		).toBe(null);
	});

	test("warns and skips state updates when the IPC response is not an array", async () => {
		const originalWarn = console.warn;
		let warned = false;
		console.warn = () => {
			warned = true;
		};
		try {
			window.nativeBridge = {
				...originalApi,
				invoke: async (channel: string) => {
					if (channel === IPC.LOOPBACK_LIST_DEVICES) {
						return "not-an-array" as unknown;
					}
					return;
				},
				on: () => () => undefined,
				send: () => undefined,
			};
			const { result } = renderHook(() => useLoopbackDevices());
			// Give the microtask queue a chance to flush so the .then fires.
			await new Promise((r) => setTimeout(r, 10));
			expect(warned).toBe(true);
			expect(result.current.options).toEqual([]);
		} finally {
			console.warn = originalWarn;
		}
	});
});
