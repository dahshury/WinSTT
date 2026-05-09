"use client";

import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import {
	autostartSet,
	onSettingsChanged,
	settingsLoad,
	settingsSave,
	sttSetParameter,
} from "@/shared/api/ipc-client";
import type { AllowedParameter, AppSettingsSaveInput as AppSettings } from "@/shared/api/models";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";

/** camelCase → snake_case mapping for audio parameters sent to the STT server */
const AUDIO_PARAM_MAP: Record<string, AllowedParameter> = {
	sileroSensitivity: "silero_sensitivity",
	postSpeechSilenceDuration: "post_speech_silence_duration",
	wakeWordActivationDelay: "wake_word_activation_delay",
};

/** Send a parameter only when it changed (incremental) or is non-null (initial). */
function sendIfChanged<V>(
	value: V | undefined | null,
	prevValue: V | undefined | null,
	param: AllowedParameter,
	isInitial: boolean
) {
	if (isInitial) {
		if (value != null) {
			sttSetParameter(param, value);
		}
	} else if (value !== prevValue) {
		sttSetParameter(param, value);
	}
}

function syncAudioParams(settings: AppSettings, prev: AppSettings | undefined) {
	const audio = settings.audio;
	if (!audio) {
		return;
	}
	const prevAudio = prev?.audio;
	const isInitial = !prev;
	for (const [camelKey, snakeKey] of Object.entries(AUDIO_PARAM_MAP)) {
		const key = camelKey as keyof typeof audio;
		sendIfChanged(audio[key], prevAudio?.[key], snakeKey, isInitial);
	}
}

function syncModelParams(settings: AppSettings, prev: AppSettings | undefined) {
	const model = settings.model;
	const prevModel = prev?.model;
	const isInitial = !prev;
	sendIfChanged(model?.language, prevModel?.language, "language", isInitial);
	sendIfChanged(model?.model, prevModel?.model, "model", isInitial);
}

function syncQualityParams(settings: AppSettings, prev: AppSettings | undefined) {
	const smartEndpoint = settings.quality?.smartEndpoint ?? false;
	const prevSmartEndpoint = prev?.quality?.smartEndpoint ?? false;
	const mode = settings.general?.recordingMode ?? "ptt";
	const modeChanged = !prev || settings.general?.recordingMode !== prev.general?.recordingMode;

	if (modeChanged || smartEndpoint !== prevSmartEndpoint) {
		sttSetParameter("silence_timing", smartEndpoint || mode === "toggle" || mode === "listen");
	}

	const quality = settings.quality;
	const prevQuality = prev?.quality;
	const isInitial = !prev;
	sendIfChanged(
		quality?.smartEndpoint,
		prevQuality?.smartEndpoint,
		"smart_endpoint_enabled",
		isInitial
	);
	sendIfChanged(
		quality?.smartEndpointSpeed,
		prevQuality?.smartEndpointSpeed,
		"detection_speed",
		isInitial
	);
}

function syncSystemParams(settings: AppSettings, prev: AppSettings | undefined) {
	if (!prev) {
		return;
	}
	const general = settings.general;
	const prevGeneral = prev.general;
	if (general?.autoStart !== prevGeneral?.autoStart && general?.autoStart != null) {
		autostartSet(general.autoStart);
	}
}

/**
 * Sync settings to the STT server (and Electron system settings).
 *
 * - If `prev` is undefined → initial connect: push all non-null settings.
 * - If `prev` is provided → incremental: push only changed keys.
 */
function syncToServer(settings: AppSettings, prev?: AppSettings) {
	syncAudioParams(settings, prev);
	syncModelParams(settings, prev);
	syncQualityParams(settings, prev);
	syncSystemParams(settings, prev);
}

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
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
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
		if (serverStatus === "running" && isLoaded && !hasSyncedOnConnect.current) {
			hasSyncedOnConnect.current = true;
			syncToServer(latestSettingsRef.current);
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
		syncToServer(settings, prev);

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

		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
		};
	}, [settings, isLoaded]);
}
