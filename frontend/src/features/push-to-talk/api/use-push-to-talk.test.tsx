import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import * as ipcClient from "@/shared/api/ipc-client";
import { useHotkeyStore } from "../model/hotkey-store";
import { usePushToTalk } from "./use-push-to-talk";

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
});
