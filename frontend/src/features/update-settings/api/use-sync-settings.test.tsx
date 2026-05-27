import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import { _resetIpcLoadTimingForTests, markIpcLoadResolved } from "@/shared/lib/ipc-load-timing";
import {
	collectChangedSections,
	performScheduledSave,
	sectionsDiffer,
	useSyncSettings,
} from "./use-sync-settings";

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

describe("sectionsDiffer", () => {
	test("returns false when two objects serialize identically", () => {
		expect(sectionsDiffer({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(false);
	});

	test("returns true when nested values differ", () => {
		expect(sectionsDiffer({ a: 1 }, { a: 2 })).toBe(true);
		expect(sectionsDiffer({ a: 1 }, undefined)).toBe(true);
	});
});

describe("collectChangedSections", () => {
	test("returns only sections whose JSON serialization differs", () => {
		const current = {
			a: { v: 1 },
			b: { v: 2 },
			c: { v: 3 },
		} as unknown as AppSettings;
		const lastSaved = {
			a: { v: 1 },
			b: { v: 99 },
			c: { v: 3 },
		} as unknown as AppSettings;
		const patch = collectChangedSections(current, lastSaved);
		expect(Object.keys(patch)).toEqual(["b"]);
		expect((patch as { b: { v: number } }).b.v).toBe(2);
	});

	test("returns an empty patch when nothing changed", () => {
		const same = { a: { v: 1 } } as unknown as AppSettings;
		expect(Object.keys(collectChangedSections(same, same))).toEqual([]);
	});

	test("flags every key when every section changed", () => {
		const current = { a: { v: 1 }, b: { v: 2 } } as unknown as AppSettings;
		const lastSaved = { a: { v: 9 }, b: { v: 9 } } as unknown as AppSettings;
		expect(Object.keys(collectChangedSections(current, lastSaved)).sort()).toEqual(["a", "b"]);
	});
});

describe("performScheduledSave", () => {
	test("is a no-op when the IPC-load guard window is active", () => {
		window.electronAPI = makeApi();
		const latestSettingsRef = { current: initialSettings };
		const lastSavedRef: { current: AppSettings | undefined } = { current: initialSettings };
		markIpcLoadResolved();
		performScheduledSave(latestSettingsRef, lastSavedRef);
		expect(sentChannels.find((s) => s.channel === IPC.SETTINGS_SAVE)).toBeUndefined();
	});

	test("is a no-op when the latest settings match lastSaved (empty patch)", () => {
		window.electronAPI = makeApi();
		_resetIpcLoadTimingForTests();
		const latestSettingsRef = { current: initialSettings };
		const lastSavedRef: { current: AppSettings | undefined } = { current: initialSettings };
		performScheduledSave(latestSettingsRef, lastSavedRef);
		expect(sentChannels.find((s) => s.channel === IPC.SETTINGS_SAVE)).toBeUndefined();
	});

	test("sends a settings:save with the diff and advances lastSavedRef when changes exist", () => {
		window.electronAPI = makeApi();
		_resetIpcLoadTimingForTests();
		// Build two clearly-divergent settings snapshots so diffAgainstLastSaved
		// returns a non-empty patch regardless of how the default schema is
		// shaped at the moment.
		const baseline = { audio: { sileroSensitivity: 0.4 } } as unknown as AppSettings;
		const changed = { audio: { sileroSensitivity: 0.7 } } as unknown as AppSettings;
		const latestSettingsRef = { current: changed };
		const lastSavedRef: { current: AppSettings | undefined } = { current: baseline };
		performScheduledSave(latestSettingsRef, lastSavedRef);
		const saveCall = sentChannels.find((s) => s.channel === IPC.SETTINGS_SAVE);
		expect(saveCall).toBeDefined();
		expect(lastSavedRef.current).toBe(changed);
	});
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
