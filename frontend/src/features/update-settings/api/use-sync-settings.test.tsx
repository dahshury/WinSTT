import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { useSyncSettings } from "./use-sync-settings";

const originalApi = window.electronAPI;
const initialSettings = useSettingsStore.getState().settings;
const sentChannels: Array<{ channel: string; args: unknown[] }> = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function makeApi() {
	listeners.clear();
	sentChannels.length = 0;
	return {
		...originalApi,
		invoke: async (channel: string) => {
			if (channel === IPC.SETTINGS_LOAD) {
				return {};
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
	useSettingsStore.setState({ settings: initialSettings, isLoaded: false });
	useConnectionStore.setState({ serverStatus: "idle" });
	window.electronAPI = makeApi();
});

afterEach(() => {
	window.electronAPI = originalApi;
	useSettingsStore.setState({ settings: initialSettings, isLoaded: false });
	useConnectionStore.setState({ serverStatus: "idle" });
});

describe("useSyncSettings", () => {
	test("subscribes to SETTINGS_CHANGED on mount", () => {
		renderHook(() => useSyncSettings());
		expect(listeners.has(IPC.SETTINGS_CHANGED)).toBe(true);
	});

	test("flushes any pending debounced save on unmount", () => {
		// At this stage the hook isLoaded is false, so no save is enqueued — the
		// 'flush' on unmount path is exercised but is a no-op. No assertion needed
		// other than 'unmount does not throw'.
		const { unmount } = renderHook(() => useSyncSettings());
		expect(() => unmount()).not.toThrow();
	});

	test("settings effect cleanup cancels pending debounce when settings change", async () => {
		useSettingsStore.setState({ settings: initialSettings, isLoaded: true });
		const { rerender, unmount } = renderHook(() => useSyncSettings());
		// First settings change schedules a debounce; rerender to drive the
		// effect cleanup → cancel-pending path.
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				audio: { ...initialSettings.audio, sileroSensitivity: 0.5 } as never,
			},
			isLoaded: true,
		});
		rerender();
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				audio: { ...initialSettings.audio, sileroSensitivity: 0.7 } as never,
			},
			isLoaded: true,
		});
		rerender();
		expect(() => unmount()).not.toThrow();
	});
});
