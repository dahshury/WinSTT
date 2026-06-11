import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	type RenderHookResult,
	renderHook,
	waitFor,
} from "@testing-library/react";
import { IPC } from "@/shared/api/ipc-channels";
import {
	_resetOutputDevicesCacheForTests,
	useOutputDevices,
} from "./use-output-devices";

// Track every rendered hook so afterEach UNMOUNTs it. The hook installs a
// `navigator.mediaDevices` "devicechange" listener plus a 200ms debounce
// `setTimeout`; leaving instances mounted leaks a pending refresh()/timer that
// resolves during a LATER test file (bun shares one happy-dom + event loop
// across files).
const mountedHooks: RenderHookResult<unknown, unknown>[] = [];

function renderTrackedHook() {
	const handle = renderHook(() => useOutputDevices());
	mountedHooks.push(handle as unknown as RenderHookResult<unknown, unknown>);
	return handle;
}

interface FakeDevice {
	deviceId: string;
	kind: string;
	label: string;
}

interface FakeMediaDevices {
	addEventListener: (type: string, handler: EventListener) => void;
	dispatchEvent: (event: Event) => boolean;
	enumerateDevices: () => Promise<FakeDevice[]>;
	removeEventListener: (type: string, handler: EventListener) => void;
}

let enumResult: FakeDevice[] = [];
let enumCallCount = 0;

type NativeBridgeListener = (...args: unknown[]) => void;

function installFakeMediaDevices(): {
	mediaDevices: FakeMediaDevices;
	addedListeners: Map<string, EventListener[]>;
} {
	const target = new EventTarget();
	const added = new Map<string, EventListener[]>();
	const fake: FakeMediaDevices = {
		addEventListener: (type, handler) => {
			target.addEventListener(type, handler);
			const list = added.get(type) ?? [];
			list.push(handler);
			added.set(type, list);
		},
		removeEventListener: (type, handler) => {
			target.removeEventListener(type, handler);
			const list = added.get(type) ?? [];
			added.set(
				type,
				list.filter((l) => l !== handler),
			);
		},
		dispatchEvent: (event) => target.dispatchEvent(event),
		enumerateDevices: async () => {
			enumCallCount++;
			return enumResult;
		},
	};
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		writable: true,
		value: fake,
	});
	return { mediaDevices: fake, addedListeners: added };
}

function removeMediaDevices(): void {
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		writable: true,
		value: undefined,
	});
}

function installFakeNativeBridge(): Map<string, NativeBridgeListener[]> {
	const listeners = new Map<string, NativeBridgeListener[]>();
	const original = window.nativeBridge;
	window.nativeBridge = {
		...original,
		on: (channel, cb) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((listener) => listener !== cb),
				);
			};
		},
	};
	return listeners;
}

function fireNativeBridgeEvent(
	listeners: Map<string, NativeBridgeListener[]>,
	channel: string,
	...args: unknown[]
): void {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

interface FakeBackendDevice {
	index: number;
	isDefault: boolean;
	name: string;
}

// The `get/refresh_audio_output_devices` commands are now TYPED — their wrappers
// call the generated `commands.*` which bottom out in `@tauri-apps/api/core`
// `invoke` (NOT `window.nativeBridge.invoke`). `use-input-devices.test.tsx`
// registers a PROCESS-GLOBAL `mock.module("@tauri-apps/api/core")` that never
// tears down, so we must re-register our OWN ("last registration wins") that
// serves the OUTPUT-device list from a shared mutable reference. The mock reads
// `outputDeviceState.devices` live so a hot-plug mid-test is reflected. Events
// still flow through `window.nativeBridge.on`.
const OUTPUT_DEVICE_CMDS = new Set([
	"get_audio_output_devices",
	"refresh_audio_output_devices",
]);

let outputDeviceState: { devices: FakeBackendDevice[] } = { devices: [] };

mock.module("@tauri-apps/api/core", () => ({
	invoke: (cmd: string) =>
		Promise.resolve(
			OUTPUT_DEVICE_CMDS.has(cmd) ? outputDeviceState.devices : undefined,
		),
	// `bindings.ts` imports `Channel` too; an unused stub keeps the binding satisfied.
	Channel: class {},
}));

// A native bridge that records event listeners; the backend OUTPUT-device list
// is served from the `@tauri-apps/api/core` mock above (via the shared
// `outputDeviceState`). Mutating `state.devices` then firing
// `AUDIO_OUTPUT_DEVICES_CHANGED` simulates a real-time hot-plug push.
function installFakeBackendBridge(state: { devices: FakeBackendDevice[] }): {
	listeners: Map<string, NativeBridgeListener[]>;
} {
	const listeners = new Map<string, NativeBridgeListener[]>();
	outputDeviceState = state;
	window.nativeBridge = {
		...window.nativeBridge,
		on: (channel, cb) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((listener) => listener !== cb),
				);
			};
		},
	};
	return { listeners };
}

beforeEach(() => {
	_resetOutputDevicesCacheForTests();
	enumResult = [];
	enumCallCount = 0;
});

afterEach(async () => {
	for (const handle of mountedHooks.splice(0)) {
		act(() => handle.unmount());
	}
	// Let any in-flight refresh() promise + the (now-cancelled) debounce settle
	// before restoring globals so nothing resolves post-teardown.
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
	try {
		removeMediaDevices();
	} catch {
		// ignore
	}
	// Clear the shared device list the typed-command core mock reads, so a stale
	// list can't leak into a later test.
	outputDeviceState = { devices: [] };
	_resetOutputDevicesCacheForTests();
});

describe("useOutputDevices", () => {
	test("enumerates audiooutput devices on mount, filtering out non-output kinds", async () => {
		installFakeMediaDevices();
		enumResult = [
			{ deviceId: "default", kind: "audiooutput", label: "Default Speakers" },
			{ deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" },
			{ deviceId: "spk-2", kind: "audiooutput", label: "USB Headphones" },
			{ deviceId: "cam-1", kind: "videoinput", label: "Webcam" },
		];
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.devices[0]?.label).toBe("Default Speakers");
		expect(result.current.devices[1]?.label).toBe("USB Headphones");
		// Only audiooutput rows survive the kind filter.
		expect(
			result.current.devices.every((d) => d.label !== "Built-in Mic"),
		).toBe(true);
	});

	test("marks the deviceId === 'default' row as the default and surfaces it", async () => {
		installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-2", kind: "audiooutput", label: "USB Headphones" },
			{ deviceId: "default", kind: "audiooutput", label: "Default Speakers" },
		];
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		const defaultRow = result.current.devices.find(
			(d) => d.deviceId === "default",
		);
		expect(defaultRow?.isDefault).toBe(true);
		// Non-default rows are NOT flagged default.
		expect(
			result.current.devices.find((d) => d.deviceId === "spk-2")?.isDefault,
		).toBe(false);
		// defaultDevice returns the isDefault row even though it's listed second.
		expect(result.current.defaultDevice?.deviceId).toBe("default");
	});

	test("defaultDevice falls back to the first device when none is flagged default", async () => {
		installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
			{ deviceId: "spk-2", kind: "audiooutput", label: "Speakers B" },
		];
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.defaultDevice?.deviceId).toBe("spk-1");
	});

	test("defaultDevice is null when there are no output devices", async () => {
		installFakeMediaDevices();
		enumResult = [{ deviceId: "mic-1", kind: "audioinput", label: "Mic" }];
		const { result } = renderTrackedHook();
		// One enumeration happens on mount; with no outputs the list stays empty.
		await waitFor(() => expect(enumCallCount).toBeGreaterThanOrEqual(1));
		expect(result.current.devices).toEqual([]);
		expect(result.current.defaultDevice).toBeNull();
	});

	test("synthesizes incremental 'Output N' labels when device labels are empty (no mic permission)", async () => {
		installFakeMediaDevices();
		enumResult = [
			{ deviceId: "a", kind: "audiooutput", label: "" },
			{ deviceId: "b", kind: "audiooutput", label: "" },
			{ deviceId: "c", kind: "audiooutput", label: "Named Speaker" },
			{ deviceId: "d", kind: "audiooutput", label: "" },
		];
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(4));
		// fallbackCounter only advances on empty labels; the named row keeps its
		// label and does NOT consume a counter slot. So "d" is "Output 3", not 4.
		expect(result.current.devices.map((d) => d.label)).toEqual([
			"Output 1",
			"Output 2",
			"Named Speaker",
			"Output 3",
		]);
	});

	test("re-enumerates when navigator fires a devicechange event", async () => {
		const { mediaDevices } = installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
		];
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
			{ deviceId: "spk-3", kind: "audiooutput", label: "Newly Plugged" },
		];
		act(() => {
			mediaDevices.dispatchEvent(new Event("devicechange"));
		});
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.devices[1]?.label).toBe("Newly Plugged");
	});

	test("re-enumerates when the app-level devicechange broadcast fires", async () => {
		const listeners = installFakeNativeBridge();
		installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
		];
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
			{ deviceId: "spk-4", kind: "audiooutput", label: "Broadcast Headset" },
		];
		act(() => {
			fireNativeBridgeEvent(listeners, IPC.AUDIO_DEVICECHANGE_DETECTED, {});
		});
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.devices[1]?.label).toBe("Broadcast Headset");
	});

	test("coalesces a burst of devicechange events into a single re-enumeration", async () => {
		const { mediaDevices } = installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
		];
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		const callsBeforeBurst = enumCallCount;
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
			{ deviceId: "spk-9", kind: "audiooutput", label: "After Burst" },
		];
		act(() => {
			for (let i = 0; i < 6; i++) {
				mediaDevices.dispatchEvent(new Event("devicechange"));
			}
		});
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		// Exactly ONE additional enumeration despite six events (200ms debounce).
		expect(enumCallCount - callsBeforeBurst).toBe(1);
	});

	test("removes the devicechange listener and is enumerable again on unmount", async () => {
		const { addedListeners } = installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
		];
		const { unmount } = renderHook(() => useOutputDevices());
		await waitFor(() =>
			expect(addedListeners.get("devicechange")?.length ?? 0).toBe(1),
		);
		unmount();
		expect(addedListeners.get("devicechange")?.length ?? 0).toBe(0);
	});

	test("refresh() is a no-op (resolves) when navigator.mediaDevices is unavailable", async () => {
		removeMediaDevices();
		const { result } = renderTrackedHook();
		// No mediaDevices ⇒ refresh returns early, no listener attached, list empty.
		await act(async () => {
			await result.current.refresh();
		});
		expect(result.current.devices).toEqual([]);
		expect(result.current.defaultDevice).toBeNull();
		expect(enumCallCount).toBe(0);
	});

	test("unmount cancels a pending debounce timer so no stray re-enumeration fires", async () => {
		const { mediaDevices } = installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
		];
		const { result, unmount } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		const callsBeforeUnmount = enumCallCount;
		// Fire a devicechange to ARM the 200ms debounce timer, then unmount before
		// it elapses. The cleanup must clearTimeout the pending timer (lines 90-92)
		// so the debounced refresh() never fires post-unmount.
		act(() => {
			mediaDevices.dispatchEvent(new Event("devicechange"));
		});
		unmount();
		mountedHooks.length = 0; // already unmounted; don't double-unmount in afterEach
		await new Promise((r) => setTimeout(r, 300));
		// No enumeration happened after the unmount — the armed timer was cleared.
		expect(enumCallCount).toBe(callsBeforeUnmount);
	});

	test("sources the device list from the backend push, joining browser deviceIds by name, and surfaces a hot-plug the browser is stale about", async () => {
		const savedBridge = window.nativeBridge;
		try {
			// The browser knows the speakers (so the name→deviceId join resolves) but
			// its enumerateDevices() stays STALE across the later hot-plug.
			installFakeMediaDevices();
			enumResult = [
				{ deviceId: "default", kind: "audiooutput", label: "Default" },
				{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
			];
			const state: { devices: FakeBackendDevice[] } = {
				devices: [{ index: 0, name: "Speakers A", isDefault: true }],
			};
			const { listeners } = installFakeBackendBridge(state);

			const { result } = renderTrackedHook();
			await waitFor(() =>
				expect(
					listeners.get(IPC.AUDIO_OUTPUT_DEVICES_CHANGED)?.length ?? 0,
				).toBe(1),
			);
			act(() => {
				fireNativeBridgeEvent(listeners, IPC.AUDIO_OUTPUT_DEVICES_CHANGED, {
					devices: state.devices,
				});
			});
			// Backend membership (1 device), with the deviceId joined from the browser.
			await waitFor(() =>
				expect(result.current.devices).toEqual([
					expect.objectContaining({
						deviceId: "spk-1",
						label: "Speakers A",
						isDefault: true,
					}),
				]),
			);

			// Hot-plug a headset. The native watcher pushes the new list even though
			// navigator.mediaDevices.enumerateDevices() (enumResult) is unchanged.
			act(() => {
				fireNativeBridgeEvent(listeners, IPC.AUDIO_OUTPUT_DEVICES_CHANGED, {
					devices: [
						{ index: 0, name: "Speakers A", isDefault: false },
						{ index: 1, name: "USB Headset", isDefault: true },
					],
				});
			});

			await waitFor(() => expect(result.current.devices.length).toBe(2));
			const headset = result.current.devices.find(
				(d) => d.label === "USB Headset",
			);
			expect(headset).toBeDefined();
			// No browser deviceId yet → a stable synthetic id (the name) keeps it
			// visible and selectable; routing falls back to the system default.
			expect(headset?.deviceId).toBe("USB Headset");
			expect(headset?.isDefault).toBe(true);
			expect(result.current.defaultDevice?.label).toBe("USB Headset");
		} finally {
			window.nativeBridge = savedBridge;
		}
	});

	test("manual refresh() re-enumerates and updates the list", async () => {
		installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
		];
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
			{ deviceId: "spk-2", kind: "audiooutput", label: "Speakers B" },
		];
		await act(async () => {
			await result.current.refresh();
		});
		expect(result.current.devices.length).toBe(2);
	});

	test("new hook instances reuse the cached list while refreshing in the background", async () => {
		installFakeMediaDevices();
		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
		];
		const first = renderTrackedHook();
		await waitFor(() => expect(first.result.current.devices.length).toBe(1));

		enumResult = [
			{ deviceId: "spk-1", kind: "audiooutput", label: "Speakers A" },
			{ deviceId: "spk-2", kind: "audiooutput", label: "Hot Plug Headset" },
		];
		const second = renderTrackedHook();
		expect(second.result.current.devices.map((d) => d.label)).toEqual([
			"Speakers A",
		]);

		await waitFor(() =>
			expect(second.result.current.devices.map((d) => d.label)).toContain(
				"Hot Plug Headset",
			),
		);
	});

	test("mount-time enumeration rejection is swallowed (.catch) and leaves the list empty", async () => {
		// The mount effect calls refresh().catch(() => undefined). When
		// enumerateDevices() rejects (e.g. permission revoked mid-session) the
		// hook must not throw an unhandled rejection — the list just stays empty.
		const target = new EventTarget();
		const fake: FakeMediaDevices = {
			addEventListener: (type, handler) =>
				target.addEventListener(type, handler),
			removeEventListener: (type, handler) =>
				target.removeEventListener(type, handler),
			dispatchEvent: (event) => target.dispatchEvent(event),
			enumerateDevices: () => {
				enumCallCount++;
				return Promise.reject(new Error("NotAllowedError"));
			},
		};
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			writable: true,
			value: fake,
		});
		const { result } = renderTrackedHook();
		await waitFor(() => expect(enumCallCount).toBeGreaterThanOrEqual(1));
		// Give the rejected promise a tick to settle through the .catch.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(result.current.devices).toEqual([]);

		// Also exercise the DEBOUNCED refresh's own .catch: fire a devicechange,
		// let the 200ms timer elapse, and confirm the rejected re-enumeration is
		// swallowed (different .catch site than the mount-time one above).
		const callsBefore = enumCallCount;
		act(() => {
			fake.dispatchEvent(new Event("devicechange"));
		});
		await waitFor(() => expect(enumCallCount).toBeGreaterThan(callsBefore));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(result.current.devices).toEqual([]);
	});
});
