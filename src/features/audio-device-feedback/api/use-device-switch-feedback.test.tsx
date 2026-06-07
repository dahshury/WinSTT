import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, type RenderHookResult, renderHook, waitFor } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";

// ---------------------------------------------------------------------------
// This suite drives its data through a per-file `window.nativeBridge` stub
// (restored in afterEach) rather than overriding ipc-client exports via
// `mock.module`. bun:test's `mock.module` is process-global with a single
// winner per path and no teardown, so per-file export overrides leak between
// files in unpredictable order. We install the SAME clean, behavior-faithful
// `ipcClientMock()` every other partial-mock file installs (so whichever wins
// globally is identical and harmless) and let it route through our stub
// exactly as the real module would:
//   onDeviceSwitchFailed → on(STT_DEVICE_SWITCH_FAILED)
//   settingsSave         → send(SETTINGS_SAVE, { settings })
//   audioGetDevices      → invoke(AUDIO_GET_DEVICES)
// ---------------------------------------------------------------------------

mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const {
	useDeviceSwitchFeedback,
	__test_shouldResetSavedIndex,
	__test_shouldResetSavedOutputDevice,
} = await import("./use-device-switch-feedback");
const { _resetOutputDevicesCacheForTests } = await import(
	"@/entities/audio-device/model/use-output-devices"
);

const originalNativeBridge = window.nativeBridge;
const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
	navigator,
	"mediaDevices"
);

// Capture mock-call records so each test can assert.
const settingsSaveCalls: Array<{
	audio?: { inputDeviceIndex: number | null };
	general?: { outputDeviceId?: string };
}> = [];
let onDeviceSwitchFailedCb:
	| ((payload: {
			errorMessage: string;
			fallbackIndex: number | null;
			requestedIndex: number;
	  }) => void)
	| null = null;
let audioGetDevicesImpl: () => Promise<Array<{ index: number; name: string; isDefault: boolean }>> =
	async () => [];
let outputEnumerateResult: Array<{ deviceId: string; kind: MediaDeviceKind; label: string }> = [];

function installNativeBridgeStub(): void {
	window.nativeBridge = {
		getPathForFile: () => "",
		send: (channel: string, payload?: unknown) => {
			if (channel === IPC.SETTINGS_SAVE) {
				const settings = (payload as { settings?: unknown } | undefined)?.settings;
				settingsSaveCalls.push(
					settings as { audio: { inputDeviceIndex: number | null } | undefined }
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
			if (channel === IPC.STT_DEVICE_SWITCH_FAILED) {
				onDeviceSwitchFailedCb = (payload) => cb(payload);
				return () => {
					onDeviceSwitchFailedCb = null;
				};
			}
			return () => undefined;
		},
	};
}

function installMediaDevicesStub(): void {
	const mediaDevices = {
		addEventListener: () => undefined,
		enumerateDevices: async () => outputEnumerateResult as unknown as MediaDeviceInfo[],
		removeEventListener: () => undefined,
	};
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: mediaDevices,
	});
}

// Reset from the canonical schema defaults (deep-cloned) rather than an
// import-time snapshot of the shared store — sibling suites mutate the global
// `useSettingsStore` and module-eval order is not isolated, so a captured
// `getState()` could already be polluted (e.g. recordingMode: "listen").
function freshSettings() {
	return structuredClone(DEFAULT_SETTINGS);
}

beforeEach(() => {
	settingsSaveCalls.length = 0;
	audioGetDevicesImpl = async () => [];
	outputEnumerateResult = [];
	onDeviceSwitchFailedCb = null;
	installNativeBridgeStub();
	installMediaDevicesStub();
	_resetOutputDevicesCacheForTests();
	useSettingsStore.setState({
		settings: {
			...freshSettings(),
			audio: { ...freshSettings().audio, inputDeviceIndex: 6 },
		},
	});
});

afterEach(() => {
	// Unmount FIRST so each hook's reconcile effect stops reacting to the
	// shared settings store before the next test runs.
	for (const handle of mountedHooks.splice(0)) {
		act(() => handle.unmount());
	}
	window.nativeBridge = originalNativeBridge;
	_resetOutputDevicesCacheForTests();
	if (originalMediaDevicesDescriptor) {
		Object.defineProperty(navigator, "mediaDevices", originalMediaDevicesDescriptor);
	} else {
		Reflect.deleteProperty(navigator, "mediaDevices");
	}
	useSettingsStore.setState({ settings: freshSettings() });
	onDeviceSwitchFailedCb = null;
	audioGetDevicesImpl = async () => [];
});

// Track rendered hooks so afterEach can UNMOUNT them. `useDeviceSwitchFeedback`
// has a reconcile effect that writes to the SHARED `useSettingsStore`; an
// un-unmounted hook from an earlier test keeps reacting to device-list changes
// and clobbers a later test's saved index (the "Received: null" failures).
const mountedHooks: RenderHookResult<unknown, unknown>[] = [];

function renderHookWithProviders() {
	const handle = renderHook(() => useDeviceSwitchFeedback(), { wrapper: IntlProvider });
	mountedHooks.push(handle as unknown as RenderHookResult<unknown, unknown>);
	return handle;
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
		// stale index 6 stays in persisted store across an early app close.
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

	test("auto-resets to system default when saved index is missing from the live list", async () => {
		// Saved index 6 was set in beforeEach; live list reports only idx=9 (e.g.
		// after the WASAPI-only enumeration switch dropped the previously-saved
		// MME duplicate at 6).
		audioGetDevicesImpl = async () => [
			{ index: 9, name: "Microphone (WO Mic Device)", isDefault: true },
		];
		renderHookWithProviders();
		await waitFor(() => {
			expect(useSettingsStore.getState().settings.audio?.inputDeviceIndex).toBe(null);
		});
		// And the reset must be persisted immediately so it survives an early close.
		expect(settingsSaveCalls.length).toBeGreaterThanOrEqual(1);
		expect(settingsSaveCalls.at(-1)?.audio?.inputDeviceIndex).toBe(null);
	});

	test("auto-resets output to system default when the saved output device disappears", async () => {
		outputEnumerateResult = [
			{ deviceId: "default", kind: "audiooutput", label: "Default Speakers" },
			{ deviceId: "spk-live", kind: "audiooutput", label: "Built-in Speakers" },
		];
		useSettingsStore.setState({
			settings: {
				...freshSettings(),
				audio: { ...freshSettings().audio, inputDeviceIndex: null },
				general: { ...freshSettings().general, outputDeviceId: "bt-headset" },
			},
		});

		renderHookWithProviders();

		await waitFor(() => {
			expect(useSettingsStore.getState().settings.general?.outputDeviceId).toBe("");
		});
		expect(settingsSaveCalls.at(-1)?.general?.outputDeviceId).toBe("");
	});

	test("does not touch the saved output device when it is still in the live list", async () => {
		outputEnumerateResult = [
			{ deviceId: "default", kind: "audiooutput", label: "Default Speakers" },
			{ deviceId: "bt-headset", kind: "audiooutput", label: "Bluetooth Headset" },
		];
		useSettingsStore.setState({
			settings: {
				...freshSettings(),
				audio: { ...freshSettings().audio, inputDeviceIndex: null },
				general: { ...freshSettings().general, outputDeviceId: "bt-headset" },
			},
		});

		renderHookWithProviders();
		await new Promise((r) => setTimeout(r, 20));

		expect(useSettingsStore.getState().settings.general?.outputDeviceId).toBe("bt-headset");
		expect(settingsSaveCalls.some((call) => call.general != null)).toBe(false);
	});

	test("does not touch the saved index when it matches a device in the live list", async () => {
		audioGetDevicesImpl = async () => [
			{ index: 6, name: "Microphone (Some Mic)", isDefault: true },
			{ index: 9, name: "Microphone (Another)", isDefault: false },
		];
		renderHookWithProviders();
		// Give the enumeration promise a chance to resolve and the reconcile
		// effect a chance to fire — it should NOT fire because 6 is in the list.
		await new Promise((r) => setTimeout(r, 20));
		expect(useSettingsStore.getState().settings.audio?.inputDeviceIndex).toBe(6);
		expect(settingsSaveCalls.length).toBe(0);
	});

	describe("shouldResetSavedIndex (pure)", () => {
		const list = [{ index: 6 }, { index: 9 }];

		test("false when no index was ever saved (null/undefined)", () => {
			expect(__test_shouldResetSavedIndex(null, list)).toBe(false);
			expect(__test_shouldResetSavedIndex(undefined, list)).toBe(false);
		});

		test("false while the device list is still empty (loading / no hardware)", () => {
			expect(__test_shouldResetSavedIndex(6, [])).toBe(false);
		});

		test("false when the saved index is present in the live list", () => {
			expect(__test_shouldResetSavedIndex(6, list)).toBe(false);
			expect(__test_shouldResetSavedIndex(9, list)).toBe(false);
		});

		test("true when the saved index is absent from a non-empty live list", () => {
			expect(__test_shouldResetSavedIndex(42, list)).toBe(true);
		});
	});

	describe("shouldResetSavedOutputDevice (pure)", () => {
		const sinkIds = ["default", "speaker-1"];

		test("false when no output device was saved", () => {
			expect(__test_shouldResetSavedOutputDevice("", sinkIds)).toBe(false);
			expect(__test_shouldResetSavedOutputDevice(null, sinkIds)).toBe(false);
			expect(__test_shouldResetSavedOutputDevice(undefined, sinkIds)).toBe(false);
		});

		test("false while the sink-id list is still empty", () => {
			expect(__test_shouldResetSavedOutputDevice("speaker-1", [])).toBe(false);
		});

		test("false when the saved output device is present", () => {
			expect(__test_shouldResetSavedOutputDevice("speaker-1", sinkIds)).toBe(false);
		});

		test("true when the saved output device is absent from a non-empty list", () => {
			expect(__test_shouldResetSavedOutputDevice("bt-headset", sinkIds)).toBe(true);
		});
	});

	test("does not reset while the live list is still empty (loading state)", async () => {
		// audioGetDevicesImpl stays as the beforeEach default: returns []. An
		// empty list could mean either "still loading" or "no hardware at all";
		// in both cases we leave the saved index alone — server-side fallback
		// in PyAudioSource.setup() handles audio routing, and resetting on an
		// empty list would clobber the user's selection during boot.
		renderHookWithProviders();
		await new Promise((r) => setTimeout(r, 20));
		expect(useSettingsStore.getState().settings.audio?.inputDeviceIndex).toBe(6);
		expect(settingsSaveCalls.length).toBe(0);
	});
});
