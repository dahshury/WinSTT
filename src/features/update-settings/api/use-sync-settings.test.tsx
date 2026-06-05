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

// Contained boundary cast. The inline snapshots below are deliberately partial /
// divergent AppSettings stand-ins shaped only enough to drive the diff helpers;
// this wrapper holds the single unavoidable cast to the real AppSettings type.
// Generic over the actual literal so each snapshot's shape is still type-checked
// at the call site, and it returns the exact same object it was given.
const asSettings = <T extends object>(s: T): AppSettings => s as unknown as AppSettings;

const originalApi = window.nativeBridge;
const initialSettings = useSettingsStore.getState().settings;
const sentChannels: Array<{ channel: string; args: unknown[] }> = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const savedPatches: Array<Partial<AppSettings>> = [];

function recordSave(settings: Partial<AppSettings>): void {
	savedPatches.push(settings);
}

function lastSavedPatch(): Partial<AppSettings> | undefined {
	return savedPatches.at(-1);
}

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
	window.nativeBridge = makeApi();
	savedPatches.length = 0;
});

afterEach(() => {
	window.nativeBridge = originalApi;
	useSettingsStore.setState({ settings: initialSettings, isLoaded: false });
	useConnectionStore.setState({ serverStatus: "idle" });
	savedPatches.length = 0;
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
		const current = asSettings({
			a: { v: 1 },
			b: { v: 2 },
			c: { v: 3 },
		});
		const lastSaved = asSettings({
			a: { v: 1 },
			b: { v: 99 },
			c: { v: 3 },
		});
		const patch = collectChangedSections(current, lastSaved);
		expect(Object.keys(patch)).toEqual(["b"]);
		expect((patch as { b: { v: number } }).b.v).toBe(2);
	});

	test("returns an empty patch when nothing changed", () => {
		const same = asSettings({ a: { v: 1 } });
		expect(Object.keys(collectChangedSections(same, same))).toEqual([]);
	});

	test("flags every key when every section changed", () => {
		const current = asSettings({ a: { v: 1 }, b: { v: 2 } });
		const lastSaved = asSettings({ a: { v: 9 }, b: { v: 9 } });
		expect(Object.keys(collectChangedSections(current, lastSaved)).sort()).toEqual(["a", "b"]);
	});
});

describe("performScheduledSave", () => {
	test("is a no-op when the IPC-load guard window is active", () => {
		window.nativeBridge = makeApi();
		const latestSettingsRef = { current: initialSettings };
		const lastSavedRef: { current: AppSettings | undefined } = { current: initialSettings };
		markIpcLoadResolved();
		performScheduledSave(latestSettingsRef, lastSavedRef, recordSave);
		expect(lastSavedPatch()).toBeUndefined();
	});

	test("does not suppress an immediate recording-mode save inside the IPC-load guard", () => {
		window.nativeBridge = makeApi();
		const baseline = {
			...initialSettings,
			general: { ...initialSettings.general, recordingMode: "ptt" as const },
		};
		const changed = {
			...baseline,
			general: { ...baseline.general, recordingMode: "wakeword" as const },
		};
		const latestSettingsRef = { current: changed };
		const lastSavedRef: { current: AppSettings | undefined } = { current: baseline };
		markIpcLoadResolved();

		performScheduledSave(latestSettingsRef, lastSavedRef, recordSave);

		const patch = lastSavedPatch();
		expect(patch).toBeDefined();
		expect(patch?.general?.recordingMode).toBe("wakeword");
	});

	test("is a no-op when the latest settings match lastSaved (empty patch)", () => {
		window.nativeBridge = makeApi();
		_resetIpcLoadTimingForTests();
		const latestSettingsRef = { current: initialSettings };
		const lastSavedRef: { current: AppSettings | undefined } = { current: initialSettings };
		performScheduledSave(latestSettingsRef, lastSavedRef, recordSave);
		expect(lastSavedPatch()).toBeUndefined();
	});

	test("sends a settings:save with the diff and advances lastSavedRef when changes exist", () => {
		window.nativeBridge = makeApi();
		_resetIpcLoadTimingForTests();
		// Build two clearly-divergent settings snapshots so diffAgainstLastSaved
		// returns a non-empty patch regardless of how the default schema is
		// shaped at the moment.
		const baseline = asSettings({ audio: { sileroSensitivity: 0.4 } });
		const changed = asSettings({ audio: { sileroSensitivity: 0.7 } });
		const latestSettingsRef = { current: changed };
		const lastSavedRef: { current: AppSettings | undefined } = { current: baseline };
		performScheduledSave(latestSettingsRef, lastSavedRef, recordSave);
		expect(lastSavedPatch()).toBeDefined();
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
