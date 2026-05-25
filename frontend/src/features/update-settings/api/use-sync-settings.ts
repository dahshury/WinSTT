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
			const { merged, nextFromBroadcast } = deriveBroadcastUpdate(
				incoming,
				useSettingsStore.getState().settings,
				lastSavedRef.current,
				fromBroadcastRef.current
			);
			fromBroadcastRef.current = nextFromBroadcast;
			setSettings(merged);
		};
		return onSettingsChanged(applyBroadcast);
	}, [setSettings]);

	// When server signals ready (recorder fully initialized), push all saved settings
	useEffect(() => {
		if (shouldSyncOnConnect(serverStatus, isLoaded, hasSyncedOnConnect.current)) {
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
		scheduleSave(
			settings,
			isModeChanged(settings, prev),
			debounceRef,
			(s) => {
				settingsSave(s);
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
		settingsSave(latest);
		lastSavedRef.current = latest;
	}
}
