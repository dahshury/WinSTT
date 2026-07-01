import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	hotkeyRegister,
	onCaptureActive,
	onHotkeyPressed,
	onHotkeyReleased,
	onRecordingStop,
	onSttSessionAborted,
	sttSetParameter,
} from "@/shared/api/ipc-client";
import type { RecordingMode } from "@/shared/config/recording-mode-color";
import { useHotkeyStore } from "../model/hotkey-store";

/** Modes driven entirely by the server (loopback / wake word) — the hotkey
 * must not touch `set_microphone`. */
const SERVER_DRIVEN_MODES = new Set<RecordingMode>(["listen", "wakeword"]);

/** Pure decision for a hotkey press. `null` → ignore the press entirely.
 * `persistActive` is true only for toggle mode, where the running active
 * state must be flipped and mirrored into the store; ptt leaves it alone
 * (the server bundles `wakeup()` with `set_microphone(true)`). */
function decidePressAction(
	mode: RecordingMode,
	currentActive: boolean,
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
	const setMicPhase = useHotkeyStore((s) => s.setMicPhase);
	const setActive = useHotkeyStore((s) => s.setActive);
	const setAccelerator = useHotkeyStore((s) => s.setAccelerator);
	const pushToTalkKey = useSettingsStore(
		(s) => s.settings.hotkey?.pushToTalkKey,
	);
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);
	const onboarded = useSettingsStore(
		(s) => s.settings.general?.onboarded ?? false,
	);
	const isActiveRef = useRef(false);
	// Initialised with a stable literal (not the reactive `recordingMode`) so
	// the ref isn't touched with render-time reactive state — which
	// `react-hooks-js/refs` flags. The effect below syncs the live value before
	// any hotkey handler (subscribed in later effects) can read it.
	const recordingModeRef = useRef<RecordingMode>("ptt");
	const onboardedRef = useRef(false);
	useEffect(() => {
		recordingModeRef.current = recordingMode;
	}, [recordingMode]);
	useEffect(() => {
		onboardedRef.current = onboarded;
	}, [onboarded]);

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
	// The backend also arms the WinSTT key at init, so the hotkey is
	// live before this effect even runs; this effect just keeps it in sync on key changes.
	useEffect(() => {
		if (!onboarded || !pushToTalkKey) {
			return;
		}
		setAccelerator(pushToTalkKey);
		hotkeyRegister(pushToTalkKey);
	}, [onboarded, pushToTalkKey, setAccelerator]);

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
				if (!onboardedRef.current) {
					return;
				}
				const mode = recordingModeRef.current as RecordingMode;
				const decision = decidePressAction(mode, isActiveRef.current);
				if (decision === null) {
					return;
				}
				// A press that STARTS a recording enters the "opening" phase — the mic is
				// being opened but hasn't confirmed audio yet (backend `stt:capture-active`
				// promotes it to "live"). A toggle press that STOPS recording goes straight
				// back to idle. This is what keeps the badge from blinking "recording"
				// before Windows has actually opened the device.
				setMicPhase(decision.micOn ? "opening" : "idle");
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
		[setMicPhase, setActive],
	);

	// Mic is confirmed open and delivering audio (backend emits `stt:capture-active`
	// on the first captured frame). Promote the badge from "opening" to "live" so the
	// recording indicator reflects real capture, not the keypress.
	useEffect(
		() =>
			onCaptureActive(() => {
				if (!onboardedRef.current) {
					return;
				}
				setMicPhase("live");
			}),
		[setMicPhase],
	);

	// Release handler — UI state ONLY. The backend handler.rs stops the recorder on the PTT
	// key release; the renderer no longer issues `set_microphone(false)`.
	useEffect(
		() =>
			onHotkeyReleased(() => {
				if (!onboardedRef.current) {
					return;
				}
				const mode = recordingModeRef.current as RecordingMode;
				if (SERVER_DRIVEN_MODES.has(mode)) {
					return;
				}
				// Only PTT ends its recording on key-up; toggle keeps recording after the
				// key lifts, so its badge must stay live until the recorder actually stops
				// (`stt:recording-stop`). Mirrors `shouldReleaseMicOnUp`.
				if (shouldReleaseMicOnUp(mode)) {
					setMicPhase("idle");
				}
				// NOTE: no `set_microphone(false)` here — see press handler. The PTT-release
				// decision (`shouldReleaseMicOnUp`) is now enforced backend-side in handler.rs.
			}),
		[setMicPhase],
	);

	// The recorder stopped (PTT release, VAD silence in toggle/listen/wakeword, or a
	// manual stop). Return the badge to idle — this is the authoritative "no longer
	// recording" signal across every mode (and a safety net for PTT).
	useEffect(() => {
		return onRecordingStop(() => {
			setMicPhase("idle");
		});
	}, [setMicPhase]);

	// User-initiated cancel (overlay X button, Escape). The server
	// already aborted the recorder + released the mic; mirror that into the
	// renderer's toggle state so the next hotkey press starts a fresh
	// recording instead of toggling off a session the server's already
	// killed (toggle mode's "press twice to restart" UX bug).
	useEffect(
		() =>
			onSttSessionAborted(() => {
				isActiveRef.current = false;
				setActive(false);
				setMicPhase("idle");
			}),
		[setActive, setMicPhase],
	);

	// Reset toggle state on unmount.
	useEffect(
		() => () => {
			isActiveRef.current = false;
			setActive(false);
		},
		[setActive],
	);
}
