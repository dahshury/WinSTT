import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type RenderHookResult, renderHook, waitFor } from "@testing-library/react";
import { useInputDevices } from "./use-input-devices";

// Track every rendered hook so afterEach can UNMOUNT it. The hook installs a
// `navigator.mediaDevices` listener and a 200 ms devicechange debounce
// `setTimeout`; leaving instances mounted leaks a pending refresh()/timer that
// resolves during a LATER test file (bun shares one happy-dom + event loop
// across files), polluting victims like useDeviceSwitchFeedback.
const mountedHooks: RenderHookResult<unknown, unknown>[] = [];

function renderTrackedHook() {
	const handle = renderHook(() => useInputDevices());
	mountedHooks.push(handle as unknown as RenderHookResult<unknown, unknown>);
	return handle;
}

interface FakeMediaDevices {
	addEventListener: (type: string, handler: EventListener) => void;
	dispatchEvent: (event: Event) => boolean;
	removeEventListener: (type: string, handler: EventListener) => void;
}

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
				list.filter((l) => l !== handler)
			);
		},
		dispatchEvent: (event) => target.dispatchEvent(event),
	};
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		writable: true,
		value: fake,
	});
	return { mediaDevices: fake, addedListeners: added };
}

interface FakeApi {
	getPathForFile: () => string;
	invoke: (channel: string) => Promise<unknown>;
	on: () => () => void;
	secureInvoke: () => Promise<unknown>;
	send: () => void;
}

// Capture the canonical `window.electronAPI` installed by the test preload so
// afterEach can RESTORE it. Setting it to `undefined` here leaked into every
// subsequent test file (bun:test shares one happy-dom window across files,
// with no per-file teardown), breaking victims that route the REAL ipc-client
// through `window.electronAPI` (detectElectron, StatusBar, OverlayPage, …).
const originalElectronApi = window.electronAPI;

let invokeQueue: unknown[] = [];
let invokeCalls: string[] = [];

function installFakeElectron(): void {
	invokeQueue = [];
	invokeCalls = [];
	const api: FakeApi = {
		send: () => undefined,
		invoke: async (channel: string) => {
			invokeCalls.push(channel);
			const value = invokeQueue.shift();
			return value ?? [];
		},
		on: () => () => undefined,
		getPathForFile: () => "",
		secureInvoke: async () => undefined,
	};
	(window as unknown as { electronAPI: FakeApi }).electronAPI = api;
}

function queueDevices(devices: Array<{ index: number; name: string; isDefault: boolean }>): void {
	invokeQueue.push(devices);
}

beforeEach(() => {
	installFakeElectron();
});

afterEach(async () => {
	// Unmount every hook rendered this test so its effect cleanup runs
	// (clears the 200 ms devicechange debounce timer + removes the
	// mediaDevices listener) BEFORE we tear down the fake environment. This
	// prevents a pending refresh()/timer from firing during a later test
	// file and polluting victims (e.g. useDeviceSwitchFeedback).
	for (const handle of mountedHooks.splice(0)) {
		act(() => handle.unmount());
	}
	// Let any in-flight refresh() promise + the (now-cancelled) debounce
	// settle before restoring globals, so nothing resolves post-restore.
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
	window.electronAPI = originalElectronApi;
	try {
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			writable: true,
			value: undefined,
		});
	} catch {
		// ignore
	}
});

describe("useInputDevices", () => {
	test("fetches devices on mount and reports the default device", async () => {
		installFakeMediaDevices();
		queueDevices([
			{ index: 0, name: "Built-in Mic", isDefault: true },
			{ index: 1, name: "USB Mic", isDefault: false },
		]);
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.defaultDevice?.name).toBe("Built-in Mic");
	});

	test("re-fetches when navigator.mediaDevices fires a devicechange event", async () => {
		const { mediaDevices } = installFakeMediaDevices();
		queueDevices([{ index: 0, name: "Built-in Mic", isDefault: true }]);
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		queueDevices([
			{ index: 0, name: "Built-in Mic", isDefault: true },
			{ index: 2, name: "Newly Plugged USB", isDefault: false },
		]);
		act(() => {
			mediaDevices.dispatchEvent(new Event("devicechange"));
		});
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.devices[1]?.name).toBe("Newly Plugged USB");
		// Two invocations: one on mount, one on devicechange.
		expect(invokeCalls.filter((c) => c === "audio:get-devices").length).toBe(2);
	});

	test("removes the devicechange listener on unmount", async () => {
		const { addedListeners } = installFakeMediaDevices();
		const { unmount } = renderHook(() => useInputDevices());
		await waitFor(() => expect(addedListeners.get("devicechange")?.length ?? 0).toBe(1));
		unmount();
		expect(addedListeners.get("devicechange")?.length ?? 0).toBe(0);
	});

	test("coalesces a burst of devicechange events into a single re-fetch", async () => {
		// A failed PyAudio open flaps the OS device state and fires 5-10
		// devicechange events in rapid succession.  Without debouncing,
		// each one triggers its own list_input_devices round-trip — a
		// burst we observed at 11:16:15 in the debug log.  The hook
		// should collapse them to one enumeration.
		const { mediaDevices } = installFakeMediaDevices();
		queueDevices([{ index: 0, name: "Built-in Mic", isDefault: true }]);
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		const callsBeforeBurst = invokeCalls.filter((c) => c === "audio:get-devices").length;

		// Queue the result for the (single) coalesced refetch.
		queueDevices([
			{ index: 0, name: "Built-in Mic", isDefault: true },
			{ index: 3, name: "After Burst", isDefault: false },
		]);
		// Fire six events back-to-back within the debounce window.
		act(() => {
			for (let i = 0; i < 6; i++) {
				mediaDevices.dispatchEvent(new Event("devicechange"));
			}
		});

		await waitFor(() => expect(result.current.devices.length).toBe(2));

		const callsAfterBurst = invokeCalls.filter((c) => c === "audio:get-devices").length;
		// Exactly ONE additional call despite six events.
		expect(callsAfterBurst - callsBeforeBurst).toBe(1);
	});
});
