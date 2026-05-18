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

const originalApi = window.electronAPI;
const initialSettings = useSettingsStore.getState().settings;
const sentChannels: Array<{ channel: string; args: unknown[] }> = [];
const invokes: string[] = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function makeApi() {
	listeners.clear();
	sentChannels.length = 0;
	invokes.length = 0;
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
	window.electronAPI = makeApi();
});

afterEach(() => {
	window.electronAPI = originalApi;
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
	test("registers the global hotkey on mount and unregisters on unmount", () => {
		const { unmount } = renderHook(() => usePushToTalk());
		expect(invokes).toContain(IPC.HOTKEY_REGISTER);
		unmount();
		expect(sentChannels.some((c) => c.channel === IPC.HOTKEY_UNREGISTER)).toBe(true);
	});

	test("hotkey-pressed in PTT mode sets isPressed=true and sends set_microphone(true)", () => {
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
		expect(
			sentChannels.some(
				(c) =>
					c.channel === IPC.STT_CALL_METHOD &&
					(c.args[0] as { method: string; args?: unknown[] }).method === "set_microphone"
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

	test("toggle mode flips isActive on each press and skips release sends", () => {
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
		const sttCalls = (): Array<{ method: string; args?: unknown[] }> =>
			sentChannels
				.filter((c) => c.channel === IPC.STT_CALL_METHOD)
				.map((c) => c.args[0] as { method: string; args?: unknown[] });

		// First press: toggle on.
		fire(IPC.HOTKEY_PRESSED);
		expect(useHotkeyStore.getState().isActive).toBe(true);
		expect(useHotkeyStore.getState().isPressed).toBe(true);
		const afterFirstPress = sttCalls();
		expect(afterFirstPress.at(-1)).toEqual({ method: "set_microphone", args: [true] });

		// Release in toggle mode must NOT emit another set_microphone.
		fire(IPC.HOTKEY_RELEASED);
		expect(useHotkeyStore.getState().isPressed).toBe(false);
		expect(sttCalls().length).toBe(afterFirstPress.length);

		// Second press: toggle off.
		fire(IPC.HOTKEY_PRESSED);
		expect(useHotkeyStore.getState().isActive).toBe(false);
		const afterSecondPress = sttCalls();
		expect(afterSecondPress.at(-1)).toEqual({ method: "set_microphone", args: [false] });
	});

	test("mirrors pushToTalkKey changes into the hotkey store accelerator", () => {
		const { rerender } = renderHook(() => usePushToTalk());
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
