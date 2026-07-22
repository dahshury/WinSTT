import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { commands } from "@/bindings";

const tauriCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
const originalSettingsCommands = {
	winsttGetSettingsSnapshot: commands.winsttGetSettingsSnapshot,
	winsttPatchSettings: commands.winsttPatchSettings,
};
import { useConnectionStore } from "@/entities/connection";
import {
	useSettingsHydrationStore,
	useSettingsStore,
} from "@/entities/setting";
import { IPC } from "@test/mocks/legacy-ipc";
import {
	appSettingsSchema,
	type AppSettingsOutput as AppSettings,
} from "@/shared/config/settings-schema";
import {
	_resetIpcLoadTimingForTests,
	markIpcLoadResolved,
} from "@/shared/lib/ipc-load-timing";
import {
	collectChangedSections,
	performScheduledSave,
	sectionsDiffer,
	useSyncSettings,
} from "./use-sync-settings";

const asSettings = <T extends object>(s: T): AppSettings =>
	s as unknown as AppSettings;

const originalApi = window.nativeBridge;
const sentChannels: Array<{ channel: string; args: unknown[] }> = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const savedPatches: Partial<AppSettings>[] = [];
let initialSettings = appSettingsSchema.parse({});
let settingsRevision = 0;

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
			return undefined;
		},
		send: (channel: string, ...args: unknown[]) => {
			sentChannels.push({ channel, args });
			if (channel === IPC.SETTINGS_SAVE) {
				const payload = args[0] as { settings?: unknown } | undefined;
				tauriCalls.push({
					cmd: "winstt_patch_settings",
					args: { settings: payload?.settings },
				});
			}
		},
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb),
				);
			};
		},
	};
}

beforeEach(() => {
	initialSettings = appSettingsSchema.parse({});
	settingsRevision = 0;
	commands.winsttGetSettingsSnapshot = async () => ({
		revision: settingsRevision,
		settings: initialSettings as never,
	});
	commands.winsttPatchSettings = async ({ baseRevision, settings }) => {
		tauriCalls.push({
			cmd: "winstt_patch_settings",
			args: { settings },
		});
		if (baseRevision !== settingsRevision) {
			return {
				status: "ok",
				data: {
					applied: false,
					changedSections: [],
					result: null,
					snapshot: {
						revision: settingsRevision,
						settings: initialSettings as never,
					},
				},
			};
		}
		initialSettings = appSettingsSchema.parse({
			...initialSettings,
			...settings,
		});
		settingsRevision += 1;
		return {
			status: "ok",
			data: {
				applied: true,
				changedSections: Object.keys(settings),
				snapshot: {
					revision: settingsRevision,
					settings: initialSettings as never,
				},
			},
		};
	};
	useSettingsStore.setState({ settings: initialSettings, isLoaded: false });
	useSettingsHydrationStore.getState().reset();
	useConnectionStore.setState({ serverStatus: "idle" });
	window.nativeBridge = makeApi();
	tauriCalls.length = 0;
	savedPatches.length = 0;
});

afterEach(() => {
	cleanup();
	commands.winsttGetSettingsSnapshot =
		originalSettingsCommands.winsttGetSettingsSnapshot;
	commands.winsttPatchSettings = originalSettingsCommands.winsttPatchSettings;
	window.nativeBridge = originalApi;
	useSettingsStore.setState({ settings: initialSettings, isLoaded: false });
	useSettingsHydrationStore.getState().reset();
	useConnectionStore.setState({ serverStatus: "idle" });
	savedPatches.length = 0;
});

describe("sectionsDiffer", () => {
	test("returns false when two objects serialize identically", () => {
		expect(sectionsDiffer({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(
			false,
		);
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
		expect(
			Object.keys(collectChangedSections(current, lastSaved)).sort(),
		).toEqual(["a", "b"]);
	});
});

describe("performScheduledSave", () => {
	test("is a no-op when the IPC-load guard window is active", () => {
		window.nativeBridge = makeApi();
		const latestSettingsRef = { current: initialSettings };
		const lastSavedRef: { current: AppSettings | undefined } = {
			current: initialSettings,
		};
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
		const lastSavedRef: { current: AppSettings | undefined } = {
			current: baseline,
		};
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
		const lastSavedRef: { current: AppSettings | undefined } = {
			current: initialSettings,
		};
		performScheduledSave(latestSettingsRef, lastSavedRef, recordSave);
		expect(lastSavedPatch()).toBeUndefined();
	});

	test("sends a settings:save with the diff and advances lastSavedRef when changes exist", async () => {
		window.nativeBridge = makeApi();
		_resetIpcLoadTimingForTests();
		// Build two clearly-divergent settings snapshots so diffAgainstLastSaved
		// returns a non-empty patch regardless of how the default schema is
		// shaped at the moment.
		const baseline = asSettings({ audio: { sileroSensitivity: 0.4 } });
		const changed = asSettings({ audio: { sileroSensitivity: 0.7 } });
		const latestSettingsRef = { current: changed };
		const lastSavedRef: { current: AppSettings | undefined } = {
			current: baseline,
		};
		// Audit #46: performScheduledSave now awaits a confirmed save ack before
		// advancing the baseline, so the advance assertion must await it too.
		await performScheduledSave(latestSettingsRef, lastSavedRef, recordSave);
		expect(lastSavedPatch()).toBeDefined();
		expect(lastSavedRef.current).toBe(changed);
	});

	test("fires onSaveSuccess (and not onSaveError) on a confirmed write", async () => {
		// The success hook clears the "save failed, will be retried" toast once a
		// retry actually lands, so the notice can't outlive the problem.
		window.nativeBridge = makeApi();
		_resetIpcLoadTimingForTests();
		const baseline = asSettings({ audio: { sileroSensitivity: 0.4 } });
		const changed = asSettings({ audio: { sileroSensitivity: 0.7 } });
		const latestSettingsRef = { current: changed };
		const lastSavedRef: { current: AppSettings | undefined } = {
			current: baseline,
		};
		let sawSuccess = false;
		let sawError = false;
		await performScheduledSave(latestSettingsRef, lastSavedRef, recordSave, {
			onSaveError: () => {
				sawError = true;
			},
			onSaveSuccess: () => {
				sawSuccess = true;
			},
		});
		expect(sawSuccess).toBe(true);
		expect(sawError).toBe(false);
	});

	test("does NOT advance lastSavedRef when the save is rejected (stays dirty for retry)", async () => {
		// Audit #46: a rejected backend write must leave the baseline untouched so
		// the section reads dirty and is re-sent, instead of silently "clean".
		window.nativeBridge = makeApi();
		_resetIpcLoadTimingForTests();
		const baseline = asSettings({ audio: { sileroSensitivity: 0.4 } });
		const changed = asSettings({ audio: { sileroSensitivity: 0.7 } });
		const latestSettingsRef = { current: changed };
		const lastSavedRef: { current: AppSettings | undefined } = {
			current: baseline,
		};
		let sawError = false;
		await performScheduledSave(
			latestSettingsRef,
			lastSavedRef,
			() => Promise.reject(new Error("backend down")),
			{
				onSaveError: () => {
					sawError = true;
				},
			},
		);
		expect(sawError).toBe(true);
		expect(lastSavedRef.current).toBe(baseline);
	});
});

describe("useSyncSettings", () => {
	test("subscribes to SETTINGS_CHANGED on mount", () => {
		renderHook(() => useSyncSettings());
		expect(listeners.has(IPC.SETTINGS_CHANGED)).toBe(true);
	});

	test("marks hydration unavailable without a persistent settings backend", async () => {
		const maybeWindow = window as unknown as {
			__TAURI_INTERNALS__?: unknown;
			nativeBridge: Window["nativeBridge"] | undefined;
		};
		const previousInternals = maybeWindow.__TAURI_INTERNALS__;
		maybeWindow.nativeBridge = undefined;
		maybeWindow.__TAURI_INTERNALS__ = undefined;

		try {
			renderHook(() => useSyncSettings());

			await waitFor(() => {
				expect(useSettingsHydrationStore.getState().status).toBe("unavailable");
			});
			expect(useSettingsStore.getState().settings).toBe(initialSettings);
		} finally {
			maybeWindow.__TAURI_INTERNALS__ = previousInternals;
		}
	});

	test("keeps a failed hydration explicit until the user requests a retry", async () => {
		let loadAttempts = 0;
		commands.winsttGetSettingsSnapshot = async () => {
			loadAttempts += 1;
			if (loadAttempts === 1) {
				throw new Error("settings backend unavailable");
			}
			return { revision: 0, settings: initialSettings as never };
		};

		renderHook(() => useSyncSettings());
		await waitFor(() =>
			expect(useSettingsHydrationStore.getState().status).toBe("error"),
		);
		expect(useSettingsHydrationStore.getState().error).toBe(
			"settings backend unavailable",
		);
		expect(loadAttempts).toBe(1);

		act(() => {
			useSettingsHydrationStore.getState().requestRetry();
		});
		await waitFor(() =>
			expect(useSettingsHydrationStore.getState().status).toBe("ready"),
		);
		expect(loadAttempts).toBe(2);
	});

	test("retries failed hydration when SETTINGS_CHANGED proves the backend is responsive", async () => {
		const external = {
			...initialSettings,
			audio: { ...initialSettings.audio, sileroSensitivity: 0.83 },
		};
		let loadAttempts = 0;
		commands.winsttGetSettingsSnapshot = async () => {
			loadAttempts += 1;
			if (loadAttempts === 1) {
				throw new Error("transient startup failure");
			}
			return { revision: 4, settings: external as never };
		};

		renderHook(() => useSyncSettings());
		await waitFor(() =>
			expect(useSettingsHydrationStore.getState().status).toBe("error"),
		);

		act(() => {
			for (const listener of listeners.get(IPC.SETTINGS_CHANGED) ?? []) {
				listener({
					changedSections: ["audio"],
					revision: 4,
					settings: external,
				});
			}
		});

		await waitFor(() =>
			expect(useSettingsHydrationStore.getState().status).toBe("ready"),
		);
		expect(loadAttempts).toBe(2);
		expect(useSettingsStore.getState().settings.audio.sileroSensitivity).toBe(
			0.83,
		);
	});

	test("flushes any pending debounced save on unmount", () => {
		// At this stage the hook isLoaded is false, so no save is enqueued — the
		// 'flush' on unmount path is exercised but is a no-op. No assertion needed
		// other than 'unmount does not throw'.
		const { unmount } = renderHook(() => useSyncSettings());
		expect(() => unmount()).not.toThrow();
	});

	test("does not flush the full local cache when unmounted before backend hydration", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: {
					...initialSettings.general,
					recordingMode: "toggle",
				},
			},
			isLoaded: true,
		});

		const { unmount } = renderHook(() => useSyncSettings());
		unmount();

		expect(
			tauriCalls.some((call) => call.cmd === "winstt_patch_settings"),
		).toBe(false);
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

	test("the FIRST user toggle after boot hydration is persisted (not eaten by a stale fromIpcLoad flag)", async () => {
		// The exact "first boot" condition the user hit: post-processing starts
		// OFF (the schema default that hydration resolves to), then the user
		// flips it ON. Before the fix, hydration left `fromIpcLoad` set and the
		// very first user change was silently skipped — the toggle never reached
		// the backend, so the Ollama model state never changed. Only the SECOND
		// toggle stuck. This guards the end-to-end frontend sync path.
		useSettingsStore.setState({ settings: initialSettings, isLoaded: false });

		renderHook(() => useSyncSettings());
		await waitFor(() =>
			expect(useSettingsHydrationStore.getState().status).toBe("ready"),
		);

		tauriCalls.length = 0;
		// User clicks the toggle well after boot settles (past the 500ms IPC-load
		// guard) — the realistic timing of a manual click.
		_resetIpcLoadTimingForTests();
		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: true });
		});

		// The debounced (300ms) save MUST reach the backend with enabled=true.
		await waitFor(
			() => {
				const saves = tauriCalls.filter(
					(c) => c.cmd === "winstt_patch_settings",
				);
				expect(saves.length).toBeGreaterThan(0);
			},
			{ timeout: 1500 },
		);
		const saved = tauriCalls
			.filter((c) => c.cmd === "winstt_patch_settings")
			.at(-1)?.args as
			| { settings?: { llm?: { dictation?: { enabled?: boolean } } } }
			| undefined;
		expect(saved?.settings?.llm?.dictation?.enabled).toBe(true);
	});

	test("consecutive toggles each persist (first ON then OFF — no dropped change)", async () => {
		// Both the first AND the second toggle must reach the backend, so a
		// disable→enable→disable sequence flips the Ollama model load state every
		// time — not only on the second click.
		useSettingsStore.setState({ settings: initialSettings, isLoaded: false });
		renderHook(() => useSyncSettings());
		await waitFor(() =>
			expect(useSettingsHydrationStore.getState().status).toBe("ready"),
		);

		const enabledValues = (): Array<boolean | undefined> =>
			tauriCalls
				.filter((c) => c.cmd === "winstt_patch_settings")
				.map(
					(c) =>
						(
							c.args as {
								settings?: { llm?: { dictation?: { enabled?: boolean } } };
							}
						)?.settings?.llm?.dictation?.enabled,
				);

		tauriCalls.length = 0;
		_resetIpcLoadTimingForTests();
		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: true });
		});
		await waitFor(() => expect(enabledValues().at(-1)).toBe(true), {
			timeout: 1500,
		});

		_resetIpcLoadTimingForTests();
		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: false });
		});
		await waitFor(() => expect(enabledValues().at(-1)).toBe(false), {
			timeout: 1500,
		});
	});

	test("rebases a stale patch on the authoritative revision and retries once", async () => {
		useSettingsStore.setState({ settings: initialSettings, isLoaded: false });
		renderHook(() => useSyncSettings());
		await waitFor(() =>
			expect(useSettingsHydrationStore.getState().status).toBe("ready"),
		);

		const external = {
			...initialSettings,
			audio: { ...initialSettings.audio, sileroSensitivity: 0.82 },
		};
		const attempts: number[] = [];
		commands.winsttPatchSettings = async ({ baseRevision, settings }) => {
			attempts.push(baseRevision);
			if (attempts.length === 1) {
				return {
					status: "ok",
					data: {
						applied: false,
						changedSections: [],
						result: null,
						snapshot: { revision: 1, settings: external as never },
					},
				};
			}
			return {
				status: "ok",
				data: {
					applied: true,
					changedSections: Object.keys(settings),
					snapshot: {
						revision: 2,
						settings: { ...external, ...settings } as never,
					},
				},
			};
		};

		_resetIpcLoadTimingForTests();
		act(() => {
			useSettingsStore.getState().updateLlmDictation({ enabled: true });
		});
		await waitFor(() => expect(attempts).toEqual([0, 1]), { timeout: 1500 });
	});
});
