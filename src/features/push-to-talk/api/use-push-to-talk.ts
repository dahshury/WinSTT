import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	hotkeyRegister,
	onHotkeyPressed,
	onHotkeyReleased,
	onRecordingStop,
	onSttSessionAborted,
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
	const pushToTalkKey = useSettingsStore((s) => s.settings.hotkey?.pushToTalkKey);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const manualToggleStop = useSettingsStore((s) => s.settings.general?.manualToggleStop ?? false);
	const isActiveRef = useRef(false);
	const recordingModeRef = useRef(recordingMode);
	recordingModeRef.current = recordingMode;

	// Register the global hotkey from the persisted PTT key — `settings.hotkey.pushToTalkKey`
	// is the single source of truth. This runs on MOUNT (registering whatever was persisted,
	// even on the very first render) and again whenever the key changes, and mirrors the value
	// into the hotkey store so the pill's HotkeyDisplay shows the active combo.
	//
	// Driven off `pushToTalkKey` rather than the hotkey-store `accelerator` ON PURPOSE: that
	// store seeds `accelerator` to the DEFAULT combo, and the previous "sync only on CHANGE"
	// mirror left it stuck at the default whenever the persisted key was ALREADY non-default
	// at mount (no change event fired to trigger the sync). The backend then got
	// `change_binding(default)` and the user's custom hotkey was never registered — the
	// "I set Win+Ctrl in settings but it stays Ctrl+Space (after a restart)" bug. The change
	// took effect live (a real change DID fire) but reverted on the next launch.
	// See memory/project_ptt_accelerator_default_divergence.md.
	// NOTE: no cleanup `hotkeyUnregister` here ON PURPOSE. `hotkeyRegister` routes through the
	// backend `change_binding`, which ATOMICALLY rebinds the single "transcribe" slot (unregister
	// the old accelerator + register the new one on the hotkey manager thread). A separate
	// cleanup unregister was both redundant AND racy: it goes out as a fire-and-forget `send`
	// while the re-register is an awaited `invoke`, so under React StrictMode's mount→cleanup→
	// mount double-invoke the unregister could land AFTER the final register and leave the hotkey
	// DEAD — the "PTT does nothing out of the box, but starts working after a hot-reload" bug.
	// The backend also arms the WinSTT key at init (shortcut/handy_keys.rs), so the hotkey is
	// live before this effect even runs; this effect just keeps it in sync on key changes.
	useEffect(() => {
		if (!pushToTalkKey) {
			return;
		}
		setAccelerator(pushToTalkKey);
		hotkeyRegister(pushToTalkKey);
	}, [pushToTalkKey, setAccelerator]);

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
	//
	// SINGLE AUTHORITY: the BACKEND (shortcut/handler.rs) now dispatches the recorder for
	// ptt/toggle directly on the hotkey thread — the renderer does NOT call
	// `set_microphone` for ptt/toggle anymore (that was the double-dispatch the Stage
	// machine had to dedupe). This handler updates UI state ONLY (pressed/active pill) and
	// still pushes the recorder-CONFIG knobs (silence-endpoint disables for PTT). listen &
	// wakeword stay server-driven (decidePressAction returns null for them).
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
				// a PTT recording. Re-assert the recorder's auto-stop disables at the
				// exact instant the recording starts so NEITHER the VAD silence
				// endpoint NOR the smart-endpoint pause tuning can fire mid-hold —
				// the "pastes before I lift my finger" bug. This is a recorder-CONFIG
				// knob (sttSetParameter), NOT a mic dispatch — the backend owns the
				// actual start/stop now. See memory/project_ptt_silence_endpoint_sync_race.md.
				if (mode === "ptt" && decision.micOn) {
					sttSetParameter("silence_endpoint_enabled", false);
					sttSetParameter("silence_timing", false);
				}
				// NOTE: no `sttCallMethod("set_microphone", …)` here — the backend's
				// handler.rs already routed this press into the coordinator.
			}),
		[setPressed, setActive]
	);

	// Release handler — UI state ONLY. The backend handler.rs stops the recorder on the PTT
	// key release; the renderer no longer issues `set_microphone(false)`.
	useEffect(
		() =>
			onHotkeyReleased(() => {
				const mode = recordingModeRef.current as RecordingMode;
				if (SERVER_DRIVEN_MODES.has(mode)) {
					return;
				}
				setPressed(false);
				// NOTE: no `set_microphone(false)` here — see press handler. The PTT-release
				// decision (`shouldReleaseMicOnUp`) is now enforced backend-side in handler.rs.
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
