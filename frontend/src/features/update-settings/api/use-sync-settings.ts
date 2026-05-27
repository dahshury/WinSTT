import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import {
	autostartSet,
	onSettingsChanged,
	settingsLoad,
	settingsSave,
	sttRequestDiarizationToggle,
	sttSetParameter,
} from "@/shared/api/ipc-client";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import { markIpcLoadResolved, recentIpcLoadAt } from "@/shared/lib/ipc-load-timing";

// Window during which we treat any debounced disk save as "potentially
// racing a setSettings(loaded) revert". When the debounce timer fires
// within this window, we re-check the latest settings against the value
// the IPC load just stamped — if they match a load-induced revert, the
// save is suppressed (we'd otherwise persist whichever transient state
// won the StrictMode-double-mount race, which has been the source of
// the recurring "disk gets stale tiny" → "switching to tiny" loop).
// Matches the guard in `useSyncActiveModel`.
const SAVE_IPC_LOAD_GUARD_MS = 500;

import { type SyncDeps, syncToServer } from "../lib/sync-actions";
import {
	advanceSkipRefs,
	deriveBroadcastUpdate,
	isModeChanged,
	scheduleSave,
	shouldSyncOnConnect,
} from "../lib/sync-helpers";

const DEPS: SyncDeps = {
	autostartSet,
	sttRequestDiarizationToggle,
	sttSetParameter,
};

export function useSyncSettings(): void {
	const settings = useSettingsStore((s) => s.settings);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const setSettings = useSettingsStore((s) => s.setSettings);
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const prevRef = useRef(settings);
	const loadedOnceRef = useRef(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestSettingsRef = useRef(settings);
	const hasSyncedOnConnect = useRef(false);
	const fromBroadcastRef = useRef(false);
	const fromIpcLoadRef = useRef(false);
	// Last settings value we know electron-store has — set on initial load and
	// after every successful debounced save. The broadcast merge uses this as
	// the baseline for "what's user-dirty" so a `settings:changed` from another
	// window can't wipe an unsaved local change the user just made.
	const lastSavedRef = useRef<AppSettings | undefined>(undefined);
	latestSettingsRef.current = settings;

	// Reconcile with electron-store (source of truth) after localStorage hydration.
	// localStorage hydration already set isLoaded, so this just patches any drift.
	useEffect(() => {
		settingsLoad().then((loaded) => {
			fromIpcLoadRef.current = true;
			lastSavedRef.current = loaded;
			markIpcLoadResolved();
			setSettings(loaded);
		});
	}, [setSettings]);

	// Listen for settings changed from other windows (e.g. settings window → main window).
	// Validate through Zod schema to ensure defaults are filled for any missing fields.
	//
	// Per-section merge: if the user has unsaved changes in a top-level section
	// (current[section] differs from `lastSavedRef`), keep the local value;
	// otherwise accept the broadcast. Without this, another window's save —
	// which always broadcasts a full snapshot — would `setSettings(decoded)`
	// over the user's just-clicked toggle inside the 300ms debounce window
	// AND the subsequent `[settings, isLoaded]` cleanup would cancel the
	// pending save, silently dropping the change.
	useEffect(() => {
		const applyBroadcast = (incoming: AppSettings): void => {
			const current = useSettingsStore.getState().settings;
			const { merged, nextFromBroadcast } = deriveBroadcastUpdate(
				incoming,
				current,
				lastSavedRef.current,
				fromBroadcastRef.current
			);
			// The broadcast IS the persisted disk state (the sender just wrote it).
			// Advance our baseline so a subsequent legitimate broadcast against an
			// already-cleanly-applied state isn't misclassified as "user-dirty".
			// Without this, applying broadcast A leaves lastSavedRef pointing at
			// the pre-A baseline (the save-effect's update path is skipped via
			// fromBroadcastRef so it never re-stamps lastSavedRef), so a later
			// broadcast B sees `current = A, lastSaved = pre-A` → divergence →
			// `keep local`, and B silently drops. This was the second-order cause
			// of the "switching never reaches the main window" symptom after the
			// secrets-walker fix.
			lastSavedRef.current = incoming;
			fromBroadcastRef.current = nextFromBroadcast;
			setSettings(merged);
		};
		return onSettingsChanged(applyBroadcast);
	}, [setSettings]);

	// When server signals ready (recorder fully initialized), push all saved settings.
	// Gated on `fromIpcLoadRef.current` so we don't sync the stale Zustand-persist
	// localStorage cache before the canonical electron-store snapshot has arrived.
	// See shouldSyncOnConnect for the full rationale — short version: localStorage
	// hydration flips `isLoaded` to true synchronously with potentially-stale data;
	// without the IPC gate, the first sync after connect re-asserts the cache via
	// `sttSetParameter("model", stale)` and the server swaps to the wrong model.
	useEffect(() => {
		if (
			shouldSyncOnConnect(
				serverStatus,
				isLoaded,
				hasSyncedOnConnect.current,
				fromIpcLoadRef.current
			)
		) {
			hasSyncedOnConnect.current = true;
			syncToServer(DEPS, latestSettingsRef.current);
		}
		// Reset flag when server is not running so settings are re-synced next time
		if (serverStatus === "idle") {
			hasSyncedOnConnect.current = false;
		}
	}, [serverStatus, isLoaded]);

	// Flush any pending debounced save on window close or unmount
	useEffect(() => {
		const flush = () => flushPendingSave(debounceRef, latestSettingsRef, lastSavedRef);
		window.addEventListener("beforeunload", flush);
		return () => {
			window.removeEventListener("beforeunload", flush);
			flush();
		};
	}, []);

	// Sync settings changes to electron-store and STT server
	useEffect(() => {
		if (!isLoaded) {
			return;
		}

		const prev = prevRef.current;
		prevRef.current = settings;

		if (
			advanceSkipRefs({
				loadedOnce: loadedOnceRef,
				fromBroadcast: fromBroadcastRef,
				fromIpcLoad: fromIpcLoadRef,
			})
		) {
			return;
		}

		// Sync changed parameters to STT server and system settings (immediate)
		syncToServer(DEPS, settings, prev);

		// Save to electron-store: flush immediately for recording mode changes
		// so the broadcast reaches other windows without delay.
		// Debounce everything else to avoid rapid writes from sliders.
		//
		// Wrap `settingsSave` so `lastSavedRef` keeps tracking the canonical
		// post-save baseline. The merge in `onSettingsChanged` uses this to
		// decide which sections the user has unsaved changes in.
		//
		// IPC-load guard: when the debounce fires, re-check whether we're
		// still inside the boot reconciliation window. If yes, the latest
		// settings might be a transient revert from a setSettings(loaded)
		// call that hasn't been re-corrected by adoptRuntime yet — saving
		// here would persist stale state to disk (the original 'switching
		// to tiny' death-spiral cause). useSyncActiveModel re-asserts the
		// runtime value after the window closes; a later settings change
		// will schedule a fresh save with the corrected value. The guard
		// uses the shared module-level timestamp set in settingsLoad.then.
		scheduleSave(
			settings,
			isModeChanged(settings, prev),
			debounceRef,
			(_captured) => {
				const sinceIpcLoad = Date.now() - recentIpcLoadAt();
				// Read the LATEST store snapshot at fire time, not the value
				// captured at schedule time. A broadcast arriving inside the
				// debounce window already updated the store; firing with the
				// stale capture would broadcast an outdated section back and
				// race with the originator's save (the dynamic-island
				// overlay-mode snap-back: VAD-triggered save in the main
				// window captured general=floating-bottom at T+10, the user
				// clicked dynamic-island in the settings window which saved
				// at T+300, then the main window's T+310 save fired with the
				// captured stale general and broadcast floating-bottom back —
				// the settings window's merge saw current==lastSaved
				// post-save and accepted the stale broadcast, reverting the
				// Switcher).
				const s = latestSettingsRef.current;
				if (sinceIpcLoad < SAVE_IPC_LOAD_GUARD_MS) {
					return;
				}
				// Only send sections that actually differ from the last-saved
				// baseline. This window may hold a stale snapshot of a
				// section another window owns (e.g. main holds floating-bottom
				// for general while the settings window just persisted
				// dynamic-island); without the diff we'd echo that stale
				// section back into electron-store and clobber the live
				// value. Same partial-save contract callers like
				// useVadCalibration already use — see `settingsSave` JSDoc.
				const patch = diffAgainstLastSaved(s, lastSavedRef.current);
				if (!hasAnyKey(patch)) {
					return;
				}
				settingsSave(patch);
				lastSavedRef.current = s;
			},
			300
		);

		return () => cancelPendingSave(debounceRef);
	}, [settings, isLoaded]);
}

/** Cancel any pending debounced save (called from effect-cleanup, CC 2). */
function cancelPendingSave(debounceRef: { current: ReturnType<typeof setTimeout> | null }): void {
	if (debounceRef.current) {
		clearTimeout(debounceRef.current);
		debounceRef.current = null;
	}
}

/**
 * Build a partial settings patch containing only the top-level sections that
 * differ from `lastSaved`. When `lastSaved` is undefined (first save in the
 * session), send everything so the canonical disk snapshot is established.
 */
function diffAgainstLastSaved(
	current: AppSettings,
	lastSaved: AppSettings | undefined
): Partial<AppSettings> {
	if (!lastSaved) {
		return current;
	}
	const patch: Record<string, unknown> = {};
	for (const key of Object.keys(current) as Array<keyof AppSettings>) {
		if (JSON.stringify(current[key]) !== JSON.stringify(lastSaved[key])) {
			patch[key] = current[key];
		}
	}
	return patch as Partial<AppSettings>;
}

function hasAnyKey(obj: Partial<AppSettings>): boolean {
	return Object.keys(obj).length > 0;
}

/**
 * Cancel any pending debounced save AND immediately flush the latest settings
 * to electron-store. Used on window close / unmount so a fast-close doesn't
 * lose changes that hadn't been written yet (CC 2). Also advances
 * `lastSavedRef` so a later broadcast merge still sees the flushed state as
 * the saved baseline.
 */
function flushPendingSave(
	debounceRef: { current: ReturnType<typeof setTimeout> | null },
	latestSettingsRef: { current: AppSettings },
	lastSavedRef: { current: AppSettings | undefined }
): void {
	if (debounceRef.current) {
		clearTimeout(debounceRef.current);
		debounceRef.current = null;
		const latest = latestSettingsRef.current;
		const patch = diffAgainstLastSaved(latest, lastSavedRef.current);
		if (!hasAnyKey(patch)) {
			return;
		}
		settingsSave(patch);
		lastSavedRef.current = latest;
	}
}
