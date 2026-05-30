import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	hotkeyRegister,
	hotkeyUnregister,
	onHotkeyPressed,
	onHotkeyReleased,
	onRecordingStop,
	onSttSessionAborted,
	sttCallMethod,
	sttSetParameter,
} from "@/shared/api/ipc-client";
import { useHotkeyStore } from "../model/hotkey-store";

type RecordingMode = "ptt" | "toggle" | "listen" | "wakeword";

/** Modes driven entirely by the server (loopback / wake word) — the hotkey
 * must not touch `set_microphone`. */
const SERVER_DRIVEN_MODES = new Set<RecordingMode>(["listen", "wakeword"]);

/** Pure decision for a hotkey press. `null` → ignore the press entirely.
 * `persistActive` is true only for toggle mode, where the running active
 * state must be flipped and mirrored into the store; ptt leaves it alone
 * (the server bundles `wakeup()` with `set_microphone(true)`). */
function decidePressAction(
	mode: RecordingMode,
	currentActive: boolean
): { micOn: boolean; persistActive: boolean } | null {
	if (SERVER_DRIVEN_MODES.has(mode)) {
		return null;
	}
	if (mode === "ptt") {
		return { micOn: true, persistActive: false };
	}
	return { micOn: !currentActive, persistActive: true };
}

/** Pure decision for a hotkey release. `false` → no microphone send (the
 * server owns toggle/listen/wakeword teardown); only ptt releases the mic. */
function shouldReleaseMicOnUp(mode: RecordingMode): boolean {
	return mode === "ptt";
}

/** Internal — exported solely for colocated unit tests (not in the slice
 * public API). */
export const __test_decidePressAction = decidePressAction;
/** Internal — exported solely for colocated unit tests. */
export const __test_shouldReleaseMicOnUp = shouldReleaseMicOnUp;

export function usePushToTalk(): void {
	const setPressed = useHotkeyStore((s) => s.setPressed);
	const setActive = useHotkeyStore((s) => s.setActive);
	const setAccelerator = useHotkeyStore((s) => s.setAccelerator);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const pushToTalkKey = useSettingsStore((s) => s.settings.hotkey?.pushToTalkKey);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const manualToggleStop = useSettingsStore((s) => s.settings.general?.manualToggleStop ?? false);
	const isActiveRef = useRef(false);
	const recordingModeRef = useRef(recordingMode);
	recordingModeRef.current = recordingMode;

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

	// Sync silence endpoint based on recording mode — set once, not per keypress.
	// PTT mode never uses the silence endpoint (Smart Endpoint doesn't apply
	// here — the key release defines the boundary). Manual-toggle mode also
	// disables it so the recording runs press-to-press without VAD stopping
	// the user mid-pause.
	useEffect(() => {
		const enabled = recordingMode !== "ptt" && !(recordingMode === "toggle" && manualToggleStop);
		sttSetParameter("silence_endpoint_enabled", enabled);
	}, [recordingMode, manualToggleStop]);

	// Press handler — refs let us avoid re-subscribing when mode changes.
	useEffect(
		() =>
			onHotkeyPressed(() => {
				const mode = recordingModeRef.current as RecordingMode;
				const decision = decidePressAction(mode, isActiveRef.current);
				if (decision === null) {
					return;
				}
				setPressed(true);
				if (decision.persistActive) {
					isActiveRef.current = decision.micOn;
					setActive(decision.micOn);
				}
				// PTT hard invariant: the key release is the ONLY thing that ends
				// a PTT recording. Re-assert the server's auto-stop disables at the
				// exact instant the recording starts so NEITHER the VAD silence
				// endpoint NOR the smart-endpoint pause tuning can fire mid-hold —
				// the "pastes before I lift my finger" bug. This is race-free where
				// the mount/connect sync is not: at press time the mode is stably
				// "ptt" and the server is connected+ready (you can't be recording
				// otherwise), so the push can't be dropped by the cold-boot
				// not-ready/not-connected gates that silently swallowed the mount
				// effect. Deduped downstream (electron-main) → one push per session,
				// not per-press. See memory/project_ptt_silence_endpoint_sync_race.md.
				if (mode === "ptt" && decision.micOn) {
					sttSetParameter("silence_endpoint_enabled", false);
					sttSetParameter("silence_timing", false);
				}
				sttCallMethod("set_microphone", [decision.micOn]);
			}),
		[setPressed, setActive]
	);

	// Release handler.
	useEffect(
		() =>
			onHotkeyReleased(() => {
				const mode = recordingModeRef.current as RecordingMode;
				if (SERVER_DRIVEN_MODES.has(mode)) {
					return;
				}
				setPressed(false);
				if (shouldReleaseMicOnUp(mode)) {
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

	// User-initiated cancel (overlay X button, hotkey+Backspace). The server
	// already aborted the recorder + released the mic; mirror that into the
	// renderer's toggle state so the next hotkey press starts a fresh
	// recording instead of toggling off a session the server's already
	// killed (toggle mode's "press twice to restart" UX bug).
	useEffect(
		() =>
			onSttSessionAborted(() => {
				isActiveRef.current = false;
				setActive(false);
				setPressed(false);
			}),
		[setActive, setPressed]
	);

	// Reset toggle state on unmount.
	useEffect(
		() => () => {
			isActiveRef.current = false;
			setActive(false);
		},
		[setActive]
	);
}
