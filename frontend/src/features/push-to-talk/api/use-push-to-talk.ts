"use client";

import { useEffect } from "react";
import { useSettingsStore } from "@/features/update-settings";
import {
	hotkeyRegister,
	hotkeyUnregister,
	onHotkeyPressed,
	onHotkeyReleased,
	sttCallMethod,
	sttSetParameter,
} from "@/shared/api/ipc-client";
import { useHotkeyStore } from "../model/hotkey-store";

export function usePushToTalk() {
	const setPressed = useHotkeyStore((s) => s.setPressed);
	const setAccelerator = useHotkeyStore((s) => s.setAccelerator);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const hotkeySettings = useSettingsStore((s) => s.settings.hotkey);

	// Sync accelerator from settings store
	useEffect(() => {
		if (hotkeySettings?.pushToTalkKey) {
			setAccelerator(hotkeySettings.pushToTalkKey);
		}
	}, [hotkeySettings?.pushToTalkKey, setAccelerator]);

	// Register the global hotkey and subscribe to press/release events
	useEffect(() => {
		hotkeyRegister(accelerator);

		const unsubPressed = onHotkeyPressed(() => {
			setPressed(true);
			// PTT pattern: set silence duration high, unmute, start recording
			sttSetParameter("post_speech_silence_duration", 9999);
			sttCallMethod("set_microphone", [true]);
			sttCallMethod("wakeup");
		});

		const unsubReleased = onHotkeyReleased(() => {
			setPressed(false);
			// PTT pattern: set silence duration low, mute (injects silence frames)
			sttSetParameter("post_speech_silence_duration", 0.15);
			sttCallMethod("set_microphone", [false]);
		});

		return () => {
			hotkeyUnregister(accelerator);
			unsubPressed();
			unsubReleased();
		};
	}, [setPressed, accelerator]);
}
