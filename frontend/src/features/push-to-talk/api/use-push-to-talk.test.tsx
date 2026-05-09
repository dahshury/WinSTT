import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { useHotkeyStore } from "../model/hotkey-store";
import { usePushToTalk } from "./use-push-to-talk";

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
		renderHook(() => usePushToTalk());
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
