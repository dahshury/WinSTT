"use client";

import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
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

export function usePushToTalk(): void {
	const setPressed = useHotkeyStore((s) => s.setPressed);
	const setActive = useHotkeyStore((s) => s.setActive);
	const setAccelerator = useHotkeyStore((s) => s.setAccelerator);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const pushToTalkKey = useSettingsStore((s) => s.settings.hotkey?.pushToTalkKey);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const smartEndpoint = useSettingsStore((s) => s.settings.quality?.smartEndpoint ?? false);
	const isActiveRef = useRef(false);
	const recordingModeRef = useRef(recordingMode);
	const smartEndpointRef = useRef(smartEndpoint);
	recordingModeRef.current = recordingMode;
	smartEndpointRef.current = smartEndpoint;

	// Mirror pushToTalkKey from the settings store into the hotkey store using
	// React's render-time adjustment pattern instead of useEffect — there's no
	// async boundary, this is pure store-to-store derivation.
	const [prevPushToTalkKey, setPrevPushToTalkKey] = useState(pushToTalkKey);
	if (prevPushToTalkKey !== pushToTalkKey) {
		setPrevPushToTalkKey(pushToTalkKey);
		if (pushToTalkKey) {
			setAccelerator(pushToTalkKey);
		}
	}

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

	// Press handler — refs let us avoid re-subscribing when mode changes.
	useEffect(() => {
		return onHotkeyPressed(() => {
			const mode = recordingModeRef.current;

			if (mode === "listen") {
				return;
			}
			setPressed(true);

			// The server WS handler bundles `wakeup()` with `set_microphone(true)`,
			// so one frame per press is enough.
			if (mode === "ptt") {
				sttCallMethod("set_microphone", [true]);
				return;
			}
			const nowActive = !isActiveRef.current;
			isActiveRef.current = nowActive;
			setActive(nowActive);
			sttCallMethod("set_microphone", [nowActive]);
		});
	}, [setPressed, setActive]);

	// Release handler.
	useEffect(
		() =>
			onHotkeyReleased(() => {
				const mode = recordingModeRef.current;

				if (mode === "listen") {
					return;
				}
				setPressed(false);

				if (mode === "ptt") {
					sttCallMethod("set_microphone", [false]);
				}
			}),
		[setPressed]
	);

	// Toggle-mode auto-reset is handled by the server; we still subscribe so the
	// channel doesn't accumulate unbound listeners.
	useEffect(() => {
		return onRecordingStop(() => {
			// no-op
		});
	}, []);

	// Reset toggle state on unmount.
	useEffect(
		() => () => {
			isActiveRef.current = false;
			setActive(false);
		},
		[setActive]
	);
}
