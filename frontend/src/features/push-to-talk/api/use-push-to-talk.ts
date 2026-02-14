"use client";

import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/features/update-settings";
import {
	hotkeyRegister,
	hotkeyUnregister,
	onHotkeyPressed,
	onHotkeyReleased,
	onRecordingStop,
	sttCallMethod,
	sttSetParameter,
} from "@/shared/api/ipc-client";
import { useHotkeyStore } from "../model/hotkey-store";

export function usePushToTalk() {
	const setPressed = useHotkeyStore((s) => s.setPressed);
	const setActive = useHotkeyStore((s) => s.setActive);
	const setAccelerator = useHotkeyStore((s) => s.setAccelerator);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const hotkeySettings = useSettingsStore((s) => s.settings.hotkey);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const smartEndpoint = useSettingsStore((s) => s.settings.quality?.smartEndpoint ?? false);
	const isActiveRef = useRef(false);
	const recordingModeRef = useRef(recordingMode);
	const smartEndpointRef = useRef(smartEndpoint);
	recordingModeRef.current = recordingMode;
	smartEndpointRef.current = smartEndpoint;

	// Sync accelerator from settings store
	useEffect(() => {
		if (hotkeySettings?.pushToTalkKey) {
			setAccelerator(hotkeySettings.pushToTalkKey);
		}
	}, [hotkeySettings?.pushToTalkKey, setAccelerator]);

	// Register the global hotkey — only re-runs when accelerator actually changes
	useEffect(() => {
		hotkeyRegister(accelerator);
		return () => {
			hotkeyUnregister(accelerator);
		};
	}, [accelerator]);

	// Sync silence endpoint based on recording mode — set once, not per keypress
	useEffect(() => {
		if (recordingMode === "ptt" && !smartEndpoint) {
			sttSetParameter("silence_endpoint_enabled", false);
		} else {
			sttSetParameter("silence_endpoint_enabled", true);
		}
	}, [recordingMode, smartEndpoint]);

	// Subscribe to press/release events — uses refs for mode to avoid re-subscribing
	useEffect(() => {
		let unsubRecordingStop: (() => void) | undefined;

		const unsubPressed = onHotkeyPressed(() => {
			const mode = recordingModeRef.current;

			if (mode === "listen") {
				return;
			}
			setPressed(true);

			if (mode === "ptt") {
				sttCallMethod("set_microphone", [true]);
				sttCallMethod("wakeup");
			} else {
				const nowActive = !isActiveRef.current;
				isActiveRef.current = nowActive;
				setActive(nowActive);

				if (nowActive) {
					sttCallMethod("set_microphone", [true]);
					sttCallMethod("wakeup");
				} else {
					sttCallMethod("set_microphone", [false]);
				}
			}
		});

		const unsubReleased = onHotkeyReleased(() => {
			const mode = recordingModeRef.current;

			if (mode === "listen") {
				return;
			}
			setPressed(false);

			if (mode === "ptt") {
				sttCallMethod("set_microphone", [false]);
			}
		});

		unsubRecordingStop = onRecordingStop(() => {
			// Only relevant in toggle mode — auto-reset handled by server
		});

		return () => {
			unsubPressed();
			unsubReleased();
			unsubRecordingStop?.();
			isActiveRef.current = false;
			setActive(false);
		};
	}, [setPressed, setActive]);
}
