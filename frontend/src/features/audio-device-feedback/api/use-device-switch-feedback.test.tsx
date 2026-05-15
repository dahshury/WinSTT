import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";

// Capture mock-call records so each test can assert.
const settingsSaveCalls: Array<{ audio: { inputDeviceIndex: number | null } | undefined }> = [];
let onDeviceSwitchFailedCb:
	| ((payload: {
			errorMessage: string;
			fallbackIndex: number | null;
			requestedIndex: number;
	  }) => void)
	| null = null;

const actualIpcClient = await import("@/shared/api/ipc-client");

mock.module("@/shared/api/ipc-client", () => ({
	...actualIpcClient,
	onDeviceSwitchFailed: (cb: typeof onDeviceSwitchFailedCb) => {
		onDeviceSwitchFailedCb = cb;
		return () => {
			onDeviceSwitchFailedCb = null;
		};
	},
	settingsSave: (settings: { audio: { inputDeviceIndex: number | null } | undefined }) => {
		settingsSaveCalls.push(settings);
	},
	audioGetDevices: async () => [],
}));

// Fresh import after the mock is installed.
const { useDeviceSwitchFeedback } = await import("./use-device-switch-feedback");

const initial = useSettingsStore.getState();

beforeEach(() => {
	settingsSaveCalls.length = 0;
	useSettingsStore.setState({
		...initial,
		settings: {
			...initial.settings,
			audio: { ...initial.settings.audio, inputDeviceIndex: 6 },
		},
	});
});

afterEach(() => {
	useSettingsStore.setState(initial);
	onDeviceSwitchFailedCb = null;
});

function renderHookWithProviders() {
	return renderHook(() => useDeviceSwitchFeedback(), { wrapper: IntlProvider });
}

describe("useDeviceSwitchFeedback", () => {
	test("persists the fallback index immediately, bypassing debounce", () => {
		renderHookWithProviders();
		expect(onDeviceSwitchFailedCb).not.toBeNull();
		act(() => {
			onDeviceSwitchFailedCb?.({
				errorMessage: "Cannot open input device 6",
				fallbackIndex: null,
				requestedIndex: 6,
			});
		});
		// settingsSave must fire synchronously in the same tick — otherwise the
		// stale index 6 stays in electron-store across an early Electron close.
		expect(settingsSaveCalls.length).toBe(1);
		expect(settingsSaveCalls[0]?.audio?.inputDeviceIndex).toBe(null);
		// And the Zustand store reflects the fallback.
		expect(useSettingsStore.getState().settings.audio?.inputDeviceIndex).toBe(null);
	});

	test("forwards the server-reported fallback index when non-null", () => {
		renderHookWithProviders();
		act(() => {
			onDeviceSwitchFailedCb?.({
				errorMessage: "device gone",
				fallbackIndex: 2,
				requestedIndex: 6,
			});
		});
		expect(settingsSaveCalls[0]?.audio?.inputDeviceIndex).toBe(2);
		expect(useSettingsStore.getState().settings.audio?.inputDeviceIndex).toBe(2);
	});
});
