"use client";

import type { components } from "@spec/schema";
import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/features/connect-server";
import {
	autostartSet,
	onSettingsChanged,
	settingsLoad,
	settingsSave,
	sttSetParameter,
} from "@/shared/api/ipc-client";
import { useSettingsStore } from "../model/settings-store";

type AllowedParameter = components["schemas"]["AllowedParameter"];
type AppSettings = components["schemas"]["AppSettings"];

/** camelCase → snake_case mapping for audio parameters sent to the STT server */
const AUDIO_PARAM_MAP: Record<string, AllowedParameter> = {
	sileroSensitivity: "silero_sensitivity",
	postSpeechSilenceDuration: "post_speech_silence_duration",
	wakeWordActivationDelay: "wake_word_activation_delay",
};

/** Push all mapped settings to the STT server */
function syncAllToServer(settings: AppSettings) {
	const audio = settings.audio;
	if (audio) {
		for (const [camelKey, snakeKey] of Object.entries(AUDIO_PARAM_MAP)) {
			const value = audio[camelKey as keyof typeof audio];
			if (value != null) {
				sttSetParameter(snakeKey, value);
			}
		}
	}

	if (settings.model?.language != null) {
		sttSetParameter("language", settings.model.language);
	}

	if (settings.model?.model != null) {
		sttSetParameter("model", settings.model.model);
	}

	// Derive silence_timing from recording mode: PTT disables it, Toggle/Listen enable it
	const mode = settings.general?.recordingMode ?? "ptt";
	sttSetParameter("silence_timing", mode === "toggle" || mode === "listen");
}

/** Sync only the changed parameters to the STT server and Electron system settings. */
function syncChangedToServer(settings: AppSettings, prev: AppSettings) {
	const audio = settings.audio;
	const prevAudio = prev.audio;
	if (audio && prevAudio) {
		for (const [camelKey, snakeKey] of Object.entries(AUDIO_PARAM_MAP)) {
			const key = camelKey as keyof typeof audio;
			if (audio[key] !== prevAudio[key]) {
				sttSetParameter(snakeKey, audio[key]);
			}
		}
	}

	const model = settings.model;
	const prevModel = prev.model;
	if (model?.language !== prevModel?.language && model?.language != null) {
		sttSetParameter("language", model.language);
	}
	if (model?.model !== prevModel?.model && model?.model != null) {
		sttSetParameter("model", model.model);
	}

	// Sync autoStart toggle to Electron's login item settings
	const general = settings.general;
	const prevGeneral = prev.general;
	if (general?.autoStart !== prevGeneral?.autoStart && general?.autoStart != null) {
		autostartSet(general.autoStart);
	}

	// Sync recording mode change → silence_timing parameter on the server
	if (general?.recordingMode !== prevGeneral?.recordingMode && general?.recordingMode != null) {
		sttSetParameter(
			"silence_timing",
			general.recordingMode === "toggle" || general.recordingMode === "listen"
		);
	}
}

export function useSyncSettings() {
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
			if (loaded && typeof loaded === "object" && Object.keys(loaded).length > 0) {
				fromIpcLoadRef.current = true;
				setSettings(loaded);
			}
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
	}, [setSettings]);

	// Listen for settings changed from other windows (e.g. settings window → main window)
	useEffect(() => {
		const unsub = onSettingsChanged((incoming: AppSettings) => {
			fromBroadcastRef.current = true;
			setSettings(incoming);
		});
		return unsub;
	}, [setSettings]);

	// When server signals ready (recorder fully initialized), push all saved settings
	useEffect(() => {
		console.log(
			"[useSyncSettings] serverStatus=",
			serverStatus,
			"isLoaded=",
			isLoaded,
			"synced=",
			hasSyncedOnConnect.current
		);
		if (serverStatus === "running" && isLoaded && !hasSyncedOnConnect.current) {
			hasSyncedOnConnect.current = true;
			console.log("[useSyncSettings] Syncing ALL settings to server");
			syncAllToServer(latestSettingsRef.current);
		}
		// Reset flag when server is not running so settings are re-synced next time
		if (serverStatus === "idle") {
			hasSyncedOnConnect.current = false;
		}
	}, [serverStatus, isLoaded]);

	// Flush any pending debounced save on window close or unmount
	useEffect(() => {
		const flush = () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
				settingsSave(latestSettingsRef.current);
			}
		};
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

		// Skip the very first sync after load — it's the initial hydration, not a user change
		if (!loadedOnceRef.current) {
			loadedOnceRef.current = true;
			return;
		}

		// Skip saving to electron-store when change came from broadcast
		// (the source window or tray already saved to electron-store).
		// The tray handler sends server params directly, so no need to
		// re-sync here — just update the Zustand store and return.
		if (fromBroadcastRef.current) {
			fromBroadcastRef.current = false;
			return;
		}

		// Skip saving back when reconciling from electron-store on mount
		if (fromIpcLoadRef.current) {
			fromIpcLoadRef.current = false;
			return;
		}

		// Sync changed parameters to STT server and system settings (immediate)
		syncChangedToServer(settings, prev);

		// Save to electron-store: flush immediately for recording mode changes
		// so the broadcast reaches other windows without delay.
		// Debounce everything else to avoid rapid writes from sliders.
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
		}
		const modeChanged = settings.general?.recordingMode !== prev.general?.recordingMode;
		if (modeChanged) {
			settingsSave(settings);
			debounceRef.current = null;
		} else {
			debounceRef.current = setTimeout(() => {
				settingsSave(settings);
				debounceRef.current = null;
			}, 300);
		}
	}, [settings, isLoaded]);
}
