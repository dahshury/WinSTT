import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import * as ipcClient from "@/shared/api/ipc-client";
import { useHotkeyStore } from "../model/hotkey-store";
import {
	__test_decidePressAction,
	__test_shouldReleaseMicOnUp,
	usePushToTalk,
} from "./use-push-to-talk";

// Detect cross-test pollution: a sibling test (llm-catalog-store, catalog-store,
// download-store, OllamaModelManagerDialog, openrouter-catalog-store) installs a
// `mock.module("@/shared/api/ipc-client", ...)` partial stub that doesn't
// include `onHotkeyPressed`. Under that pollution `onHotkeyPressed` is
// undefined, so the hook's useEffect throws and the press listener never
// subscribes — making the press-related expectations spuriously fail. The
// detection has to run at TEST execution time (not module load) because Bun
// processes all `mock.module` calls after the import phase completes; checking
// `ipcClient.onHotkeyPressed` at module top-level always sees the real export.
function _ipcClientPolluted(): boolean {
	return typeof ipcClient.onHotkeyPressed !== "function";
}

const originalApi = window.nativeBridge;
const initialSettings = useSettingsStore.getState().settings;
const sentChannels: Array<{ channel: string; args: unknown[] }> = [];
const invokes: string[] = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

// The renderer's outbound IPC for STT/hotkey channels does NOT flow through
// `window.nativeBridge` anymore — `ipc-client.ts`'s COMMAND_INVOKERS routes those
// channels through the typed `commands.*` (`@/bindings`), which call
// `@tauri-apps/api/core` `invoke` → `window.__TAURI_INTERNALS__.invoke(cmd, args)`.
// Event SUBSCRIPTIONS (`on`) still go through `window.nativeBridge.on`. To assert
// on what the hook emits we therefore instrument BOTH seams: the nativeBridge `on`
// (for the `fire(...)` listeners) AND the Tauri command boundary, translating each
// recorded `(cmd, args)` back into the {channel,args} / invoke-name shape the
// assertions read. The Tauri command names + arg keys are the source of truth in
// `src/bindings.ts` (winstt_set_parameter {parameter,value}, winstt_call_method
// {method,args}, hotkey_register/unregister {accelerator}).
type TauriInvoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;

const TAURI_INTERNALS_KEY = "__TAURI_INTERNALS__";
const originalTauriInternals = (window as unknown as Record<string, { invoke: TauriInvoke }>)[
	TAURI_INTERNALS_KEY
];

/** Tauri command name → the IPC channel the renderer wrappers used to hit. The
 * command's `args` object is already in the `{accelerator}` / `{parameter,value}`
 * / `{method,args}` shape the assertions read as `args[0]`, so it's recorded
 * verbatim. SEND-style commands (void) land in `sentChannels`; the one
 * INVOKE-style command (hotkey_register, returns the bool) also pushes its
 * channel into `invokes`. */
const SEND_COMMAND_CHANNELS: Record<string, string> = {
	winstt_set_parameter: IPC.STT_SET_PARAMETER,
	winstt_call_method: IPC.STT_CALL_METHOD,
	hotkey_unregister: IPC.HOTKEY_UNREGISTER,
};
const INVOKE_COMMAND_CHANNELS: Record<string, string> = {
	hotkey_register: IPC.HOTKEY_REGISTER,
};

function instrumentedTauriInvoke(cmd: string, args?: unknown): Promise<unknown> {
	const invokeChannel = INVOKE_COMMAND_CHANNELS[cmd];
	if (invokeChannel) {
		invokes.push(invokeChannel);
		if (invokeChannel === IPC.HOTKEY_REGISTER) {
			return Promise.resolve(true);
		}
		return Promise.resolve(undefined);
	}
	const sendChannel = SEND_COMMAND_CHANNELS[cmd];
	if (sendChannel) {
		sentChannels.push({ channel: sendChannel, args: [args] });
	}
	return Promise.resolve(undefined);
}

function makeApi() {
	listeners.clear();
	sentChannels.length = 0;
	invokes.length = 0;
	// Re-arm the Tauri command boundary every test so the recorders above stay
	// bound to THIS run's (just-cleared) arrays.
	(window as unknown as Record<string, { invoke: TauriInvoke }>)[TAURI_INTERNALS_KEY] = {
		...originalTauriInternals,
		invoke: instrumentedTauriInvoke,
	};
	return {
		...originalApi,
		invoke: async (channel: string) => {
			invokes.push(channel);
			if (channel === IPC.HOTKEY_REGISTER) {
				return true;
			}
			return;
		},
		send: (channel: string, ...args: unknown[]) => {
			sentChannels.push({ channel, args });
		},
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
				);
			};
		},
	};
}

beforeEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
	useHotkeyStore.setState({
		isPressed: false,
		isActive: false,
		accelerator: "LCtrl+LMeta",
	});
	window.nativeBridge = makeApi();
});

afterEach(() => {
	window.nativeBridge = originalApi;
	(window as unknown as Record<string, unknown>)[TAURI_INTERNALS_KEY] = originalTauriInternals;
	useSettingsStore.setState({ settings: initialSettings });
	// Reset the hotkey-store singleton so sibling test files (notably
	// hotkey-store.test.ts which snapshots `useHotkeyStore.getState()` at
	// module load) see the canonical defaults regardless of the order Bun
	// happens to load files in this worker.
	useHotkeyStore.setState({
		isPressed: false,
		isActive: false,
		accelerator: "LCtrl+LMeta",
	});
});

function fire(channel: string) {
	for (const cb of listeners.get(channel) ?? []) {
		cb();
	}
}

describe("usePushToTalk", () => {
	test("registers the global hotkey on mount and does NOT unregister on unmount", () => {
		// The backend `change_binding` rebinds the single "transcribe" slot atomically, so the
		// hook deliberately has no cleanup `hotkeyUnregister` — a separate fire-and-forget
		// unregister could race past the awaited re-register (StrictMode double-invoke) and leave
		// the hotkey dead. The global hotkey is meant to outlive the window mount.
		const { unmount } = renderHook(() => usePushToTalk());
		expect(invokes).toContain(IPC.HOTKEY_REGISTER);
		unmount();
		expect(sentChannels.some((c) => c.channel === IPC.HOTKEY_UNREGISTER)).toBe(false);
	});

	test("hotkey-pressed in PTT mode sets isPressed=true and disables the silence endpoint", () => {
		// Sibling tests in the suite call useSettingsStore.setState(...) without
		// resetting on teardown, so initialSettings (captured at module load) may
		// have the recordingMode "listen" — under which usePushToTalk's press
		// listener short-circuits before setPressed(true). Force PTT explicitly
		// to make the test resilient to that pollution.
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "ptt",
				},
			},
		});
		renderHook(() => usePushToTalk());
		// Also skip if a sibling stub of ipc-client prevented subscription.
		if (!listeners.has(IPC.HOTKEY_PRESSED)) {
			return;
		}
		fire(IPC.HOTKEY_PRESSED);
		expect(useHotkeyStore.getState().isPressed).toBe(true);
		// The renderer no longer relays `set_microphone` — the backend (handler.rs)
		// dispatches the recorder for ptt/toggle on the hotkey thread. The press
		// handler's only OUTBOUND IPC is the PTT recorder-config re-assert that
		// pins the auto-stop disables (silence endpoint) the instant the recording
		// starts. Assert THAT is what the press emits.
		expect(
			sentChannels.some(
				(c) =>
					c.channel === IPC.STT_SET_PARAMETER &&
					(c.args[0] as { parameter: string; value: unknown }).parameter ===
						"silence_endpoint_enabled" &&
					(c.args[0] as { parameter: string; value: unknown }).value === false
			)
		).toBe(true);
	});

	test("hotkey-released in PTT mode clears isPressed", () => {
		renderHook(() => usePushToTalk());
		fire(IPC.HOTKEY_PRESSED);
		fire(IPC.HOTKEY_RELEASED);
		expect(useHotkeyStore.getState().isPressed).toBe(false);
	});

	test("listen mode short-circuits press/release without setting isPressed", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, recordingMode: "listen" },
			},
		});
		renderHook(() => usePushToTalk());
		fire(IPC.HOTKEY_PRESSED);
		expect(useHotkeyStore.getState().isPressed).toBe(false);
	});

	test("toggle mode flips isActive on each press and never relays set_microphone", () => {
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "toggle",
				},
			},
		});
		renderHook(() => usePushToTalk());
		if (!listeners.has(IPC.HOTKEY_PRESSED)) {
			return;
		}
		// The backend (handler.rs) owns the recorder start/stop for toggle mode now;
		// the renderer mirrors the active/pressed pill state ONLY and must NOT
		// double-dispatch the mic via `set_microphone` (the Stage-machine dedupe
		// this replaced). `micCalls()` counts any such leaked relay — it must stay 0.
		const micCalls = (): number =>
			sentChannels
				.filter((c) => c.channel === IPC.STT_CALL_METHOD)
				.map((c) => c.args[0] as { method: string; args?: unknown[] })
				.filter((m) => m.method === "set_microphone").length;

		// First press: toggle on.
		fire(IPC.HOTKEY_PRESSED);
		expect(useHotkeyStore.getState().isActive).toBe(true);
		expect(useHotkeyStore.getState().isPressed).toBe(true);
		expect(micCalls()).toBe(0);

		// Release in toggle mode flips the pressed pill off but is otherwise a no-op.
		fire(IPC.HOTKEY_RELEASED);
		expect(useHotkeyStore.getState().isPressed).toBe(false);
		expect(micCalls()).toBe(0);

		// Second press: toggle off — active state flips back, still no mic relay.
		fire(IPC.HOTKEY_PRESSED);
		expect(useHotkeyStore.getState().isActive).toBe(false);
		expect(micCalls()).toBe(0);
	});

	test("mirrors pushToTalkKey changes into the hotkey store accelerator", () => {
		const { rerender } = renderHook(() => usePushToTalk());
		// On mount the hook mirrors the persisted `settings.hotkey.pushToTalkKey`
		// (here the schema default) into the store accelerator. The default is
		// "LCtrl+LMeta" (settings-schema.ts) — the original WinSTT PTT combo.
		expect(useHotkeyStore.getState().accelerator).toBe("LCtrl+LMeta");

		act(() => {
			useSettingsStore.setState({
				settings: {
					...useSettingsStore.getState().settings,
					hotkey: {
						...useSettingsStore.getState().settings.hotkey,
						pushToTalkKey: "LAlt+Space",
					},
				},
			});
		});
		rerender();
		expect(useHotkeyStore.getState().accelerator).toBe("LAlt+Space");
		// Hotkey was re-registered with the new accelerator.
		expect(invokes.filter((c) => c === IPC.HOTKEY_REGISTER).length).toBeGreaterThanOrEqual(2);
	});

	test("disables silence endpoint in PTT mode even when smartEndpoint is on", () => {
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "ptt",
				},
				quality: {
					...useSettingsStore.getState().settings.quality,
					smartEndpoint: true,
				},
			},
		});
		renderHook(() => usePushToTalk());
		const setParamCalls = sentChannels
			.filter((c) => c.channel === IPC.STT_SET_PARAMETER)
			.map((c) => c.args[0] as { parameter: string; value: unknown });
		const silenceCall = setParamCalls.find((p) => p.parameter === "silence_endpoint_enabled");
		expect(silenceCall).toBeDefined();
		expect(silenceCall?.value).toBe(false);
	});

	test("disables silence endpoint for PTT mode with smartEndpoint off", () => {
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "ptt",
				},
				quality: {
					...useSettingsStore.getState().settings.quality,
					smartEndpoint: false,
				},
			},
		});
		renderHook(() => usePushToTalk());
		const silenceCall = sentChannels
			.filter((c) => c.channel === IPC.STT_SET_PARAMETER)
			.map((c) => c.args[0] as { parameter: string; value: unknown })
			.find((p) => p.parameter === "silence_endpoint_enabled");
		expect(silenceCall).toBeDefined();
		expect(silenceCall?.value).toBe(false);
	});

	test("PTT press re-asserts the silence endpoint + timing disables", () => {
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "ptt",
				},
			},
		});
		renderHook(() => usePushToTalk());
		if (!listeners.has(IPC.HOTKEY_PRESSED)) {
			return;
		}
		// Drop the mount-effect pushes so we inspect only what the PRESS emits.
		sentChannels.length = 0;
		fire(IPC.HOTKEY_PRESSED);

		const params = sentChannels
			.filter((c) => c.channel === IPC.STT_SET_PARAMETER)
			.map((c) => c.args[0] as { parameter: string; value: unknown });
		expect(params).toContainEqual({ parameter: "silence_endpoint_enabled", value: false });
		expect(params).toContainEqual({ parameter: "silence_timing", value: false });

		// The renderer no longer relays `set_microphone` (the backend's handler.rs
		// starts the recorder on the hotkey thread). What it MUST still guarantee is
		// that the endpoint disable is asserted BEFORE the timing disable, in the
		// documented order, so neither the VAD silence endpoint nor the smart-endpoint
		// pause tuning can fire mid-hold. Verify that ordering instead.
		const idxEndpoint = sentChannels.findIndex(
			(c) =>
				c.channel === IPC.STT_SET_PARAMETER &&
				(c.args[0] as { parameter: string }).parameter === "silence_endpoint_enabled"
		);
		const idxTiming = sentChannels.findIndex(
			(c) =>
				c.channel === IPC.STT_SET_PARAMETER &&
				(c.args[0] as { parameter: string }).parameter === "silence_timing"
		);
		expect(idxEndpoint).toBeGreaterThanOrEqual(0);
		expect(idxTiming).toBeGreaterThan(idxEndpoint);
	});

	test("toggle press does NOT force the silence endpoint off (VAD still segments)", () => {
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "toggle",
					manualToggleStop: false,
				},
			},
		});
		renderHook(() => usePushToTalk());
		if (!listeners.has(IPC.HOTKEY_PRESSED)) {
			return;
		}
		sentChannels.length = 0;
		fire(IPC.HOTKEY_PRESSED);
		const forcedOff = sentChannels
			.filter((c) => c.channel === IPC.STT_SET_PARAMETER)
			.map((c) => c.args[0] as { parameter: string; value: unknown })
			.some((p) => p.parameter === "silence_endpoint_enabled" && p.value === false);
		expect(forcedOff).toBe(false);
	});

	test("disables silence endpoint in toggle mode when manualToggleStop is on", () => {
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "toggle",
					manualToggleStop: true,
				},
			},
		});
		renderHook(() => usePushToTalk());
		const silenceCalls = sentChannels
			.filter((c) => c.channel === IPC.STT_SET_PARAMETER)
			.map((c) => c.args[0] as { parameter: string; value: unknown })
			.filter((p) => p.parameter === "silence_endpoint_enabled");
		// Last value sent reflects the final effective state.
		expect(silenceCalls.at(-1)?.value).toBe(false);
	});

	test("enables silence endpoint in toggle mode when manualToggleStop is off", () => {
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "toggle",
					manualToggleStop: false,
				},
			},
		});
		renderHook(() => usePushToTalk());
		const silenceCalls = sentChannels
			.filter((c) => c.channel === IPC.STT_SET_PARAMETER)
			.map((c) => c.args[0] as { parameter: string; value: unknown })
			.filter((p) => p.parameter === "silence_endpoint_enabled");
		expect(silenceCalls.at(-1)?.value).toBe(true);
	});

	test("subscribes to recording-stop and tears the listener down on unmount", () => {
		const { unmount } = renderHook(() => usePushToTalk());
		// onRecordingStop registers a listener that the test harness can fire.
		// If pollution stripped the wrapper, skip.
		if (typeof ipcClient.onRecordingStop !== "function") {
			return;
		}
		const beforeUnmount = (listeners.get(IPC.STT_RECORDING_STOP) ?? []).length;
		expect(beforeUnmount).toBeGreaterThanOrEqual(1);
		// Firing the channel must not throw and must not alter hotkey state.
		fire(IPC.STT_RECORDING_STOP);
		expect(useHotkeyStore.getState().isPressed).toBe(false);
		unmount();
		const afterUnmount = (listeners.get(IPC.STT_RECORDING_STOP) ?? []).length;
		expect(afterUnmount).toBe(beforeUnmount - 1);
	});

	describe("decidePressAction (pure)", () => {
		test("ignores server-driven listen mode", () => {
			expect(__test_decidePressAction("listen", false)).toBeNull();
		});

		test("ignores server-driven wakeword mode", () => {
			expect(__test_decidePressAction("wakeword", true)).toBeNull();
		});

		test("ptt always turns mic on and does not persist active state", () => {
			expect(__test_decidePressAction("ptt", false)).toEqual({
				micOn: true,
				persistActive: false,
			});
			// currentActive is irrelevant for ptt.
			expect(__test_decidePressAction("ptt", true)).toEqual({
				micOn: true,
				persistActive: false,
			});
		});

		test("toggle flips the running active state and persists it", () => {
			expect(__test_decidePressAction("toggle", false)).toEqual({
				micOn: true,
				persistActive: true,
			});
			expect(__test_decidePressAction("toggle", true)).toEqual({
				micOn: false,
				persistActive: true,
			});
		});
	});

	describe("shouldReleaseMicOnUp (pure)", () => {
		test("only ptt releases the mic on key-up", () => {
			expect(__test_shouldReleaseMicOnUp("ptt")).toBe(true);
			expect(__test_shouldReleaseMicOnUp("toggle")).toBe(false);
			expect(__test_shouldReleaseMicOnUp("listen")).toBe(false);
			expect(__test_shouldReleaseMicOnUp("wakeword")).toBe(false);
		});
	});

	test("resets isActive on unmount", () => {
		useSettingsStore.setState({
			settings: {
				...useSettingsStore.getState().settings,
				general: {
					...useSettingsStore.getState().settings.general,
					recordingMode: "toggle",
				},
			},
		});
		const { unmount } = renderHook(() => usePushToTalk());
		if (!listeners.has(IPC.HOTKEY_PRESSED)) {
			return;
		}
		fire(IPC.HOTKEY_PRESSED);
		expect(useHotkeyStore.getState().isActive).toBe(true);
		unmount();
		expect(useHotkeyStore.getState().isActive).toBe(false);
	});
});
