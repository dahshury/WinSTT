import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	act,
	type RenderHookResult,
	renderHook,
	waitFor,
} from "@testing-library/react";
import {
	_resetInputDevicesCacheForTests,
	useInputDevices,
} from "./use-input-devices";
import { IPC } from "@/shared/api/ipc-channels";

// ── Transport seam #2: the globally-mocked `@tauri-apps/api/core` ──────────────
//
// `useInputDevices` fetches via `audioGetDevices()`, which the live ipc-client
// routes through the typed `commands.getAudioDevices()` (@/bindings). The
// bindings bottom out in `@tauri-apps/api/core` `invoke(cmd, args)` — NOT in
// `window.__TAURI_INTERNALS__` directly. `src/shared/api/ipc-client.test.ts`
// (which runs FIRST in the suite) installs a PROCESS-GLOBAL
// `mock.module("@tauri-apps/api/core")` whose `invoke` resolves whatever its
// private `tauriInvokeImpl` returns — left at `() => undefined` once that file
// finishes. Since `mock.module` never tears down and this file runs SECOND,
// that leaked core mock makes every `commands.*` call resolve `undefined`,
// so instrumenting `window.__TAURI_INTERNALS__` alone is invisible here.
//
// `mock.module` is "last registration wins", so re-register our own faithful
// core mock that serves the queued device payload for `get_audio_devices` and
// delegates everything else to `undefined` — byte-for-byte the same observable
// behaviour the leaked ipc-client.test.ts mock gives later files, just with the
// one command this suite needs wired through. This makes the suite correct under
// BOTH the leaked core mock (full suite) and the real core (run alone). The
// nativeBridge seam below still covers the leaked-ipc-client-FAKE transport.
let invokeQueue: unknown[] = [];
let invokeCalls: string[] = [];

mock.module("@tauri-apps/api/core", () => ({
	invoke: (cmd: string) => {
		if (cmd === "refresh_audio_devices" || cmd === "get_audio_devices") {
			invokeCalls.push("refresh_audio_devices");
			return Promise.resolve(nextDevicePayload());
		}
		return Promise.resolve(undefined);
	},
	// `bindings.ts` imports `Channel` too; an unused stub keeps the binding satisfied.
	Channel: class {},
}));

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
				list.filter((l) => l !== handler),
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

// `audioRefreshDevices()` reaches the hook through the native bridge route. The
// legacy `get_audio_devices` seams are still wired below because this suite can
// run after other global IPC mocks that exercise the old typed command path.
//
// `audioGetDevices()` reaches the hook via one of THREE transports depending on
// which process-global `mock.module` registrations have leaked in by the time
// this file runs (bun shares one happy-dom + module registry across files):
//   1. Run ALONE — real ipc-client + real `@tauri-apps/api/core` →
//      `window.__TAURI_INTERNALS__.invoke("get_audio_devices")`.
//   2. Full suite — the leaked `@tauri-apps/api/core` mock from
//      `ipc-client.test.ts` shadows transport 1 (the bindings call its `invoke`,
//      not `__TAURI_INTERNALS__`); handled by our OWN core mock above.
//   3. A leaked `@/shared/api/ipc-client` FAITHFUL FAKE → `audioGetDevices`
//      routes through `window.nativeBridge.invoke("audio:get-devices")`.
// We serve the SAME queued device payload from all three and count each into one
// shared `invokeCalls` recorder (every seam pushes the canonical `GET_DEVICES_CMD`
// tag so the assertions read identically regardless of file order).
const GET_DEVICES_CMD = "refresh_audio_devices";
const LEGACY_GET_DEVICES_CMD = "get_audio_devices";
const GET_DEVICES_CHANNEL = "audio:get-devices"; // IPC.AUDIO_GET_DEVICES
const REFRESH_DEVICES_CHANNEL = "audio:refresh-devices"; // IPC.AUDIO_REFRESH_DEVICES

type NativeBridgeListener = (...args: unknown[]) => void;
type TauriInvokeFn = (
	cmd: string,
	args?: unknown,
	options?: unknown,
) => Promise<unknown>;

interface TauriInternals {
	__TAURI_INTERNALS__: { invoke: TauriInvokeFn };
}

// The preload's per-test `afterEach` REPLACES the whole `window.__TAURI_INTERNALS__`
// object with a fresh one each tick, so a module-level captured reference goes
// stale after the first test (writes to the stale object are invisible to
// `@tauri-apps/api/core`, which reads `window.__TAURI_INTERNALS__` live). Always
// read the LIVE object — and re-stamp our instrumentation in every `beforeEach`
// onto whatever object is current — so the transport-1 seam is honoured on every
// test, not just the first.
function tauriInternals(): TauriInternals["__TAURI_INTERNALS__"] {
	return (window as unknown as TauriInternals).__TAURI_INTERNALS__;
}

let nativeBridgeListeners = new Map<string, NativeBridgeListener[]>();

function nextDevicePayload(): unknown {
	// `commands.getAudioDevices()` is infallible (returns the raw array, not a
	// specta Result) and the leaked fake's `audioGetDevices` falls back to `[]`
	// via `invokeOrDefault`, so resolve the queued payload directly on both seams.
	const value = invokeQueue.shift();
	return value ?? [];
}

function installFakeBridge(): void {
	invokeQueue = [];
	invokeCalls = [];
	nativeBridgeListeners = new Map<string, NativeBridgeListener[]>();
	// Real-module seam: the typed command bypasses nativeBridge and hits Tauri
	// internals. Re-stamp onto the LIVE object each beforeEach (the preload swaps
	// the object out between tests).
	tauriInternals().invoke = async (cmd: string) => {
		if (cmd === GET_DEVICES_CMD || cmd === LEGACY_GET_DEVICES_CMD) {
			invokeCalls.push(GET_DEVICES_CMD);
			return nextDevicePayload();
		}
		invokeCalls.push(cmd);
		return undefined;
	};
	// Leaked-fake seam: the faithful fake routes `audioGetDevices` through
	// nativeBridge.invoke on the `audio:get-devices` channel.
	window.nativeBridge = {
		...window.nativeBridge,
		invoke: (async (channel: string) => {
			if (
				channel === REFRESH_DEVICES_CHANNEL ||
				channel === GET_DEVICES_CHANNEL
			) {
				invokeCalls.push(GET_DEVICES_CMD);
				return nextDevicePayload();
			}
			return undefined;
		}) as typeof window.nativeBridge.invoke,
		on: (channel, cb) => {
			const list = nativeBridgeListeners.get(channel) ?? [];
			list.push(cb);
			nativeBridgeListeners.set(channel, list);
			return () => {
				nativeBridgeListeners.set(
					channel,
					(nativeBridgeListeners.get(channel) ?? []).filter(
						(listener) => listener !== cb,
					),
				);
			};
		},
	};
}

function fireNativeBridgeEvent(channel: string, ...args: unknown[]): void {
	for (const cb of nativeBridgeListeners.get(channel) ?? []) {
		cb(...args);
	}
}

function queueDevices(
	devices: Array<{ index: number; name: string; isDefault: boolean }>,
): void {
	invokeQueue.push(devices);
}

beforeEach(() => {
	_resetInputDevicesCacheForTests();
	installFakeBridge();
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
	// settle before restoring globals, so nothing resolves post-restore. The
	// preload's own afterEach re-installs fresh default `__TAURI_INTERNALS__` +
	// `nativeBridge` objects after this, so we don't manually restore those two
	// (a captured reference would be stale — the preload swaps the objects out).
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
	try {
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			writable: true,
			value: undefined,
		});
	} catch {
		// ignore
	}
	_resetInputDevicesCacheForTests();
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
		expect(invokeCalls.filter((c) => c === GET_DEVICES_CMD).length).toBe(2);
	});

	test("updates when the backend broadcasts a changed input-device list", async () => {
		installFakeMediaDevices();
		queueDevices([{ index: 0, name: "Built-in Mic", isDefault: true }]);
		const { result } = renderTrackedHook();
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		act(() => {
			fireNativeBridgeEvent(IPC.AUDIO_DEVICES_CHANGED, {
				devices: [
					{ index: 0, name: "Built-in Mic", isDefault: true },
					{ index: 4, name: "Bluetooth Headset Mic", isDefault: false },
				],
			});
		});

		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.devices[1]?.name).toBe("Bluetooth Headset Mic");
	});

	test("removes the devicechange listener on unmount", async () => {
		const { addedListeners } = installFakeMediaDevices();
		const { unmount } = renderHook(() => useInputDevices());
		await waitFor(() =>
			expect(addedListeners.get("devicechange")?.length ?? 0).toBe(1),
		);
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

		const callsBeforeBurst = invokeCalls.filter(
			(c) => c === GET_DEVICES_CMD,
		).length;

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

		const callsAfterBurst = invokeCalls.filter(
			(c) => c === GET_DEVICES_CMD,
		).length;
		// Exactly ONE additional call despite six events.
		expect(callsAfterBurst - callsBeforeBurst).toBe(1);
	});

	test("new hook instances reuse the cached list while refreshing in the background", async () => {
		installFakeMediaDevices();
		queueDevices([{ index: 0, name: "Built-in Mic", isDefault: true }]);
		const first = renderTrackedHook();
		await waitFor(() => expect(first.result.current.devices.length).toBe(1));

		queueDevices([
			{ index: 0, name: "Built-in Mic", isDefault: true },
			{ index: 2, name: "Hot Plug USB Mic", isDefault: false },
		]);
		const second = renderTrackedHook();
		expect(second.result.current.devices.map((d) => d.name)).toEqual([
			"Built-in Mic",
		]);

		await waitFor(() =>
			expect(second.result.current.devices.map((d) => d.name)).toContain(
				"Hot Plug USB Mic",
			),
		);
	});
});
