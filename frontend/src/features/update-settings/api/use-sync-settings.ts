"use client";

import type { components } from "@spec/schema";
import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/features/connect-server";
import { onSettingsChanged, settingsLoad, settingsSave, sttSetParameter } from "@/shared/api/ipc-client";
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
}

export function useSyncSettings() {
	const settings = useSettingsStore((s) => s.settings);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const setSettings = useSettingsStore((s) => s.setSettings);
	const connectionStatus = useConnectionStore((s) => s.connectionStatus);
	const prevRef = useRef(settings);
	const loadedOnceRef = useRef(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestSettingsRef = useRef(settings);
	const hasSyncedOnConnect = useRef(false);
	const fromBroadcastRef = useRef(false);
	latestSettingsRef.current = settings;

	// On mount: load from electron-store (if available) to override localStorage.
	// Electron-store is the source of truth when running in Electron.
	// If not in Electron, the persist middleware already restored from localStorage.
	useEffect(() => {
		settingsLoad().then((loaded) => {
			if (loaded && typeof loaded === "object" && Object.keys(loaded).length > 0) {
				setSettings(loaded);
			} else {
				// No electron-store data — mark as loaded so syncing activates.
				// Settings are already populated from persist middleware or defaults.
				setSettings(useSettingsStore.getState().settings);
			}
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
	}, []);

	// Listen for settings changed from other windows (e.g. settings window → main window)
	useEffect(() => {
		const unsub = onSettingsChanged((incoming: AppSettings) => {
			fromBroadcastRef.current = true;
			setSettings(incoming);
		});
		return unsub;
	}, [setSettings]);

	// When connection is first established, push all saved settings to the server
	useEffect(() => {
		if (connectionStatus === "connected" && isLoaded && !hasSyncedOnConnect.current) {
			hasSyncedOnConnect.current = true;
			syncAllToServer(latestSettingsRef.current);
		}
		// Reset flag on disconnect so settings are re-synced on reconnect
		if (connectionStatus === "disconnected") {
			hasSyncedOnConnect.current = false;
		}
	}, [connectionStatus, isLoaded]);

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

		// Skip saving and server sync if this update came from a broadcast
		// (the source window already saved to electron-store and synced to the server)
		if (fromBroadcastRef.current) {
			fromBroadcastRef.current = false;
			return;
		}

		// Debounce saves to electron-store
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
		}
		debounceRef.current = setTimeout(() => {
			settingsSave(settings);
			debounceRef.current = null;
		}, 300);

		// Sync changed parameters to STT server (immediate, not debounced)
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
	}, [settings, isLoaded]);
}
