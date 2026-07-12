import { useEffect, useLayoutEffect, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	onAudioLevel,
	onFullSentence,
	onLoopbackStopped,
	onRecordingStart,
	onRecordingStop,
	onSttSessionAborted,
	onVadStart,
	onVadStop,
} from "@/shared/api/ipc-client";
import { useVisualizerStore } from "../model/visualizer-store";

/** Sentence pulse decay per frame. */
const PULSE_DECAY = 0.03;

/**
 * Subscribes to recording / VAD / audio-level IPC events and drives the
 * visualizer store with real RMS audio levels from the server.
 *
 * The rAF loop only runs while a recording is in progress. On
 * `recording_stop`, the store is committed to zero synchronously via
 * `recordingStopped()` — there is deliberately no post-stop fade-out tween.
 * A fade driven by rAF would pause along with the rest of the renderer
 * while the main window is hidden, leaving the last frame's audioLevel
 * frozen in the store and flashing the visualizer on next show. Snapping
 * to zero at the data layer is what makes hidden→shown paint correctly
 * from the first frame; visual smoothness, if needed, belongs to the
 * rendering layer (e.g. CSS transitions on bar height).
 */
export function useVisualizerSync(): void {
	const recordingStarted = useVisualizerStore((s) => s.recordingStarted);
	const recordingStopped = useVisualizerStore((s) => s.recordingStopped);
	const setSpeaking = useVisualizerStore((s) => s.setSpeaking);
	const setAudioLevel = useVisualizerStore((s) => s.setAudioLevel);
	const setSentencePulse = useVisualizerStore((s) => s.setSentencePulse);
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);

	const rafRef = useRef(0);
	const activeRef = useRef(false);

	// Mutable accumulators updated from IPC callbacks, read in rAF loop.
	const rawLevelRef = useRef(0);
	const sentenceFiredRef = useRef(false);

	// Smoothed values persisted across frames.
	const pulseRef = useRef(0);

	// Last value actually committed to the store, so the rAF loop can skip a
	// `set` (and the useAgentState/animator recompute it triggers downstream)
	// on frames where nothing changed — e.g. sustained silence or a fully
	// decayed pulse sitting at 0.
	const committedLevelRef = useRef(0);
	const committedPulseRef = useRef(0);

	// Tracks the previously-seen recordingMode so the effect below can tell
	// "mode actually changed" apart from "hook just mounted".
	const prevRecordingModeRef = useRef(recordingMode);

	// Hold the latest animate fn in a ref so subscription effects can schedule
	// frames without listing it as a dependency (the function closes over
	// store setters which are stable, but the ref keeps things honest).
	// @crap-exclude rAF callback — covered via E2E
	const animateRef = useRef<() => void>(() => undefined);
	// Same trick for the shared teardown used by recording-stop, session-abort,
	// loopback-stop, and recording-mode-change: keeping it behind a ref means
	// the IPC subscription effects below can depend on a stable reference
	// instead of resubscribing every render.
	const resetRef = useRef<() => void>(() => undefined);
	// Keep the latest animate fn in the ref without writing `.current` during
	// render (the React Compiler forbids that). A layout effect runs before any
	// rAF the subscription effects schedule, so `animateRef.current` is fresh
	// before the first frame ticks. It closes over the stable store setters and
	// refs, so it never goes stale between renders.
	useLayoutEffect(() => {
		animateRef.current = () => {
			if (!activeRef.current) {
				return;
			}

			if (rawLevelRef.current !== committedLevelRef.current) {
				committedLevelRef.current = rawLevelRef.current;
				setAudioLevel(rawLevelRef.current);
			}

			let pulse = pulseRef.current;
			if (sentenceFiredRef.current) {
				pulse = 1;
				sentenceFiredRef.current = false;
			} else {
				pulse = Math.max(0, pulse - PULSE_DECAY);
			}
			// Always advance the decay, even when the commit below is skipped,
			// so a pulse sitting just above 0 keeps decaying toward it instead
			// of freezing at its last-committed value.
			pulseRef.current = pulse;
			if (pulse !== committedPulseRef.current) {
				committedPulseRef.current = pulse;
				setSentencePulse(pulse);
			}

			rafRef.current = requestAnimationFrame(() => animateRef.current());
		};
	}, [setAudioLevel, setSentencePulse]);

	// Shared teardown for recording-stop, session-abort, loopback-stop, and
	// recording-mode-change — every path that means "whatever was happening
	// is over, the store's truth is zero now". Cheap to call redundantly: a
	// second reset on an already-idle hook just no-ops through
	// `recordingStopped()`'s already-zero state.
	useLayoutEffect(() => {
		resetRef.current = () => {
			cancelAnimationFrame(rafRef.current);
			activeRef.current = false;
			rawLevelRef.current = 0;
			pulseRef.current = 0;
			sentenceFiredRef.current = false;
			committedLevelRef.current = 0;
			committedPulseRef.current = 0;
			recordingStopped();
		};
	}, [recordingStopped]);

	useEffect(() => {
		// Cancel any in-flight frame before scheduling a new one. Without
		// this, rapid PTT cycles leak an extra rAF callback each cycle —
		// each callback calls requestAnimationFrame(animate) again, so the
		// scheduled-frame count grows exponentially and the renderer drowns
		// (which keeps the overlay BrowserWindow too busy to process its
		// hide() IPC, leaving the pill stuck on screen).
		return onRecordingStart(() => {
			cancelAnimationFrame(rafRef.current);
			activeRef.current = true;
			rawLevelRef.current = 0;
			pulseRef.current = 0;
			committedLevelRef.current = 0;
			committedPulseRef.current = 0;
			// Reset isRecording + audioLevel + sentencePulse in one store
			// update so the visualizer doesn't briefly render the previous
			// cycle's last frame after the pill re-shows.
			recordingStarted();
			rafRef.current = requestAnimationFrame(() => animateRef.current());
		});
	}, [recordingStarted]);

	// Store committed to zero atomically — see `recordingStopped` docstring
	// for why this beats an rAF fade for hidden windows.
	useEffect(() => onRecordingStop(() => resetRef.current()), []);

	// User-initiated cancel. The server's abort flow doesn't emit
	// RecordingStopped (it only flips the state machine to INACTIVE), and the
	// relay's session-aborted gate now drops no_audio_detected too — so
	// without an explicit reset here the rAF loop keeps ticking and the
	// visualizer is stuck rendering the last frame's amplitude (the bars
	// stay tall, the radial dots keep spinning) until the next recording
	// kicks in. Treat the abort as a synthetic recording_stop.
	useEffect(
		() =>
			onSttSessionAborted(() => {
				resetRef.current();
				setSpeaking(false);
			}),
		[setSpeaking],
	);

	// The backend emits this when it tears down a loopback (listen-mode)
	// session — e.g. on mode switch or manual stop. `useListenMode` reacts to
	// it for its own isListening flag; the visualizer needs its own
	// subscription so a lingering rAF loop / stale isRecording doesn't
	// outlive the session that started it. Redundant with the recordingMode
	// effect below and with `stt:recording-stop` when both fire — resetting
	// twice is a harmless no-op.
	useEffect(() => onLoopbackStopped(() => resetRef.current()), []);

	// Switching recordingMode (e.g. listen -> ptt) doesn't itself emit a
	// recording-lifecycle IPC event, so a stale isRecording=true + a running
	// rAF loop left over from the mode being exited would otherwise persist
	// until the next start/stop cycle happened to clear it — including
	// lighting useAgentState's frozen "listening" center dot with nothing
	// actually recording. Treat any mode change as "whatever was happening
	// under the old mode is over". Guarded against firing on mount (where
	// prevRecordingModeRef is seeded from the first render's value) so this
	// doesn't perform a redundant reset before anything has happened.
	useEffect(() => {
		if (prevRecordingModeRef.current === recordingMode) {
			return;
		}
		prevRecordingModeRef.current = recordingMode;
		resetRef.current();
	}, [recordingMode]);

	useEffect(() => {
		const unsubVadStart = onVadStart(() => setSpeaking(true));
		const unsubVadStop = onVadStop(() => setSpeaking(false));
		return () => {
			unsubVadStart();
			unsubVadStop();
		};
	}, [setSpeaking]);

	useEffect(() => {
		const unsubAudioLevel = onAudioLevel((level) => {
			rawLevelRef.current = level;
		});
		const unsubSentence = onFullSentence(() => {
			sentenceFiredRef.current = true;
		});
		return () => {
			unsubAudioLevel();
			unsubSentence();
		};
	}, []);

	useEffect(
		() => () => {
			activeRef.current = false;
			cancelAnimationFrame(rafRef.current);
		},
		[],
	);
}
