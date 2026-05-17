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
import {
	advanceSkipRefs,
	autoStartChanged,
	computeSilenceTiming,
	getPrevSmartEndpoint,
	getRecordingMode,
	getSmartEndpoint,
	isModeChanged,
	scheduleSave,
	shouldSendInitial,
	shouldSendOnChange,
	shouldSyncOnConnect,
	silenceTimingNeedsUpdate,
} from "../lib/sync-helpers";

/** camelCase → snake_case mapping for audio parameters sent to the STT server */
const AUDIO_PARAM_MAP: Record<string, AllowedParameter> = {
	sileroSensitivity: "silero_sensitivity",
	postSpeechSilenceDuration: "post_speech_silence_duration",
	wakeWordActivationDelay: "wake_word_activation_delay",
	inputDeviceIndex: "input_device_index",
};

/** Send a parameter only when it changed (incremental) or is non-null (initial). */
function sendIfChanged<V>(
	value: V | undefined | null,
	prevValue: V | undefined | null,
	param: AllowedParameter,
	isInitial: boolean
) {
	const shouldSend = isInitial ? shouldSendInitial(value) : shouldSendOnChange(value, prevValue);
	if (shouldSend) {
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
	// Intentionally NOT syncing `model.model` via set_parameter: every model
	// change in the UI goes through `sttReloadModel` (stt:reload-model), which
	// is the canonical swap path. Mirroring it here would fire a second swap
	// — the recorder's `model.setter` spawns its own swap thread — and the two
	// races produce duplicate downloads, duplicate Loading logs, and the
	// download-cancel/revert dance we saw in production.
}

function syncQualityParams(settings: AppSettings, prev: AppSettings | undefined) {
	const smartEndpoint = getSmartEndpoint(settings);
	const prevSmartEndpoint = getPrevSmartEndpoint(prev);
	const mode = getRecordingMode(settings);
	const isInitial = !prev;

	if (
		silenceTimingNeedsUpdate(
			smartEndpoint,
			prevSmartEndpoint,
			settings.general?.recordingMode,
			prev?.general?.recordingMode,
			isInitial
		)
	) {
		sttSetParameter("silence_timing", computeSilenceTiming(smartEndpoint, mode));
	}

	const quality = settings.quality;
	const prevQuality = prev?.quality;
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
	if (autoStartChanged(settings, prev)) {
		autostartSet(settings.general!.autoStart!);
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
		syncToServer(settings, prev);

		// Save to electron-store: flush immediately for recording mode changes
		// so the broadcast reaches other windows without delay.
		// Debounce everything else to avoid rapid writes from sliders.
		scheduleSave(settings, isModeChanged(settings, prev), debounceRef, settingsSave, 300);

		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
		};
	}, [settings, isLoaded]);
}
