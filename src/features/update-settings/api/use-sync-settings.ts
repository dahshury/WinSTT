import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import {
	hasSettingsBackend,
	onSettingsChanged,
	settingsLoadStrict,
	settingsSave,
	sttRequestDiarizationToggle,
	sttSetParameter,
} from "@/shared/api/ipc-client";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import {
	markIpcLoadResolved,
	recentIpcLoadAt,
} from "@/shared/lib/ipc-load-timing";

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
	deriveIpcLoadUpdate,
	isModeChanged,
	scheduleSave,
	shouldSyncOnConnect,
} from "../lib/sync-helpers";
import { useSettingsHydrationStore } from "../model/settings-hydration-store";

const DEPS: SyncDeps = {
	sttRequestDiarizationToggle,
	sttSetParameter,
};

export function useSyncSettings(): void {
	const settings = useSettingsStore((s) => s.settings);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const setSettings = useSettingsStore((s) => s.setSettings);
	const hydrationStatus = useSettingsHydrationStore((s) => s.status);
	const setHydrationStatus = useSettingsHydrationStore((s) => s.setStatus);
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const prevRef = useRef(settings);
	const loadedOnceRef = useRef(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestSettingsRef = useRef(settings);
	const hasSyncedOnConnect = useRef(false);
	const fromBroadcastRef = useRef(false);
	const fromIpcLoadRef = useRef(false);
	const hasIpcLoadResolvedRef = useRef(false);
	// Last settings value we know persisted store has — set on initial load and
	// after every successful debounced save. The broadcast merge uses this as
	// the baseline for "what's user-dirty" so a `settings:changed` from another
	// window can't wipe an unsaved local change the user just made.
	const lastSavedRef = useRef<AppSettings | undefined>(undefined);
	latestSettingsRef.current = settings;

	// Reconcile with the backend store (source of truth) after localStorage hydration.
	// Without a backend (plain Vite/browser), leave the local cache as the editable
	// source and suppress backend side effects.
	useEffect(() => {
		const loadBaseline = useSettingsStore.getState().settings;
		let cancelled = false;
		const backendAvailable = hasSettingsBackend();
		if (!backendAvailable) {
			hasIpcLoadResolvedRef.current = true;
			setHydrationStatus("unavailable");
			return () => {
				cancelled = true;
			};
		}
		setHydrationStatus("loading");
		settingsLoadStrict()
			.then((loaded) => {
				if (cancelled) {
					return;
				}
				const current = useSettingsStore.getState().settings;
				const { merged, nextFromIpcLoad } = deriveIpcLoadUpdate(
					loaded,
					current,
					loadBaseline,
				);
				hasIpcLoadResolvedRef.current = true;
				fromIpcLoadRef.current = nextFromIpcLoad;
				lastSavedRef.current = loaded;
				markIpcLoadResolved();
				setSettings(merged);
				setHydrationStatus("ready");
			})
			.catch((error: unknown) => {
				if (cancelled) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				console.error("[settings] failed to hydrate backend settings:", error);
				setHydrationStatus("error", message);
			});
		return () => {
			cancelled = true;
		};
	}, [setHydrationStatus, setSettings]);

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
				fromBroadcastRef.current,
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
	// Gated on `hasIpcLoadResolvedRef.current` so we don't sync the stale Zustand-persist
	// localStorage cache before the canonical persisted store snapshot has arrived.
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
				hasIpcLoadResolvedRef.current && hydrationStatus === "ready",
			)
		) {
			hasSyncedOnConnect.current = true;
			syncToServer(DEPS, latestSettingsRef.current);
		}
		// Reset flag when server is not running so settings are re-synced next time
		if (serverStatus === "idle") {
			hasSyncedOnConnect.current = false;
		}
	}, [serverStatus, isLoaded, hydrationStatus]);

	// Flush any pending debounced save on window close or unmount
	useEffect(() => {
		const flush = () =>
			flushPendingSave(debounceRef, latestSettingsRef, lastSavedRef);
		window.addEventListener("beforeunload", flush);
		return () => {
			window.removeEventListener("beforeunload", flush);
			flush();
		};
	}, []);

	// Sync settings changes to persisted store and STT server
	useEffect(() => {
		if (!isLoaded || hydrationStatus !== "ready") {
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

		// Save to persisted store: flush immediately for recording mode changes
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
			() => performScheduledSave(latestSettingsRef, lastSavedRef),
			300,
		);

		return () => cancelPendingSave(debounceRef);
	}, [settings, isLoaded, hydrationStatus]);
}

/** Cancel any pending debounced save (called from effect-cleanup, CC 2). */
function cancelPendingSave(debounceRef: {
	current: ReturnType<typeof setTimeout> | null;
}): void {
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
export function sectionsDiffer(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) !== JSON.stringify(b);
}

export function collectChangedSections(
	current: AppSettings,
	lastSaved: AppSettings,
): Partial<AppSettings> {
	const patch: Record<string, unknown> = {};
	for (const key of Object.keys(current) as Array<keyof AppSettings>) {
		if (sectionsDiffer(current[key], lastSaved[key])) {
			patch[key] = current[key];
		}
	}
	return patch as Partial<AppSettings>;
}

function diffAgainstLastSaved(
	current: AppSettings,
	lastSaved: AppSettings | undefined,
): Partial<AppSettings> {
	return lastSaved ? collectChangedSections(current, lastSaved) : current;
}

function hasAnyKey(obj: Partial<AppSettings>): boolean {
	return Object.keys(obj).length > 0;
}

function patchIncludesRecordingModeChange(
	patch: Partial<AppSettings>,
	lastSaved: AppSettings | undefined,
): boolean {
	const nextMode = patch.general?.recordingMode;
	return nextMode != null && nextMode !== lastSaved?.general?.recordingMode;
}

const LOCAL_CACHE_COLLECTION_KEYS = ["dictionary", "snippets"] as const;

function patchIncludesLocalCollectionMigration(
	patch: Partial<AppSettings>,
	lastSaved: AppSettings | undefined,
): boolean {
	return LOCAL_CACHE_COLLECTION_KEYS.some((key) => {
		const next = patch[key];
		const previous = lastSaved?.[key];
		return (
			Array.isArray(next) &&
			next.length > 0 &&
			Array.isArray(previous) &&
			previous.length === 0
		);
	});
}

/**
 * Body of the debounced scheduleSave callback, extracted so the IPC-load
 * guard, the diff-vs-baseline check, and the lastSavedRef advance are
 * unit-testable without standing up the whole hook.
 *
 * - Suppresses saves inside the IPC-load reconciliation window (a transient
 *   revert from `setSettings(loaded)` would otherwise be persisted, the
 *   original 'switching to tiny' death-spiral cause).
 * - Only sends sections that differ from the last-saved baseline, so a
 *   stale-snapshot window can't clobber values another window just persisted.
 */
export function performScheduledSave(
	latestSettingsRef: { current: AppSettings },
	lastSavedRef: { current: AppSettings | undefined },
	saveSettings: (settings: Partial<AppSettings>) => void = settingsSave,
): void {
	const s = latestSettingsRef.current;
	const patch = diffAgainstLastSaved(s, lastSavedRef.current);
	if (!hasAnyKey(patch)) {
		return;
	}
	if (
		Date.now() - recentIpcLoadAt() < SAVE_IPC_LOAD_GUARD_MS &&
		!patchIncludesRecordingModeChange(patch, lastSavedRef.current) &&
		!patchIncludesLocalCollectionMigration(patch, lastSavedRef.current)
	) {
		return;
	}
	saveSettings(patch);
	lastSavedRef.current = s;
}

/**
 * Cancel any pending debounced save AND immediately flush the latest settings
 * to persisted store. Used on window close / unmount so a fast-close doesn't
 * lose changes that hadn't been written yet (CC 2). Also advances
 * `lastSavedRef` so a later broadcast merge still sees the flushed state as
 * the saved baseline.
 */
function flushPendingSave(
	debounceRef: { current: ReturnType<typeof setTimeout> | null },
	latestSettingsRef: { current: AppSettings },
	lastSavedRef: { current: AppSettings | undefined },
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
