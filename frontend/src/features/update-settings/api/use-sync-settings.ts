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
import { decodeSettingsPayload } from "@/shared/api/settings-codec";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import { type SyncDeps, syncToServer } from "../lib/sync-actions";
import {
	advanceSkipRefs,
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
	latestSettingsRef.current = settings;

	// Reconcile with electron-store (source of truth) after localStorage hydration.
	// localStorage hydration already set isLoaded, so this just patches any drift.
	useEffect(() => {
		settingsLoad().then((loaded) => {
			fromIpcLoadRef.current = true;
			setSettings(loaded);
		});
	}, [setSettings]);

	// Listen for settings changed from other windows (e.g. settings window → main window)
	// Validate through Zod schema to ensure defaults are filled for any missing fields.
	useEffect(() => {
		const unsub = onSettingsChanged((incoming: AppSettings) => {
			fromBroadcastRef.current = true;
			setSettings(decodeSettingsPayload(incoming));
		});
		return unsub;
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
		const flush = () => flushPendingSave(debounceRef, latestSettingsRef);
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
		scheduleSave(settings, isModeChanged(settings, prev), debounceRef, settingsSave, 300);

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
 * lose changes that hadn't been written yet (CC 2).
 */
function flushPendingSave(
	debounceRef: { current: ReturnType<typeof setTimeout> | null },
	latestSettingsRef: { current: AppSettings }
): void {
	if (debounceRef.current) {
		clearTimeout(debounceRef.current);
		debounceRef.current = null;
		settingsSave(latestSettingsRef.current);
	}
}
