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
 * Audio levels are coalesced into at most one pending rAF commit. Sentence
 * pulses use a short-lived rAF chain that stops once the pulse reaches zero;
 * there is no always-on polling loop while recording. On
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

	const audioFrameRef = useRef(0);
	const pulseFrameRef = useRef(0);
	const activeRef = useRef(false);

	// Mutable accumulators updated from IPC callbacks and committed on the next
	// scheduled frame.
	const rawLevelRef = useRef(0);
	const sentenceFiredRef = useRef(false);

	// Smoothed values persisted across frames.
	const pulseRef = useRef(0);

	// Last value actually committed to the store, so callbacks can skip a
	// `set` (and the useAgentState/animator recompute it triggers downstream)
	// when nothing changed.
	const committedLevelRef = useRef(0);
	const committedPulseRef = useRef(0);

	// Tracks the previously-seen recordingMode so the effect below can tell
	// "mode actually changed" apart from "hook just mounted".
	const prevRecordingModeRef = useRef(recordingMode);

	// Keep the shared teardown used by recording-stop, session-abort,
	// loopback-stop, and recording-mode-change: keeping it behind a ref means
	// the IPC subscription effects below can depend on a stable reference
	// instead of resubscribing every render.
	const resetRef = useRef<() => void>(() => undefined);

	// Shared teardown for recording-stop, session-abort, loopback-stop, and
	// recording-mode-change — every path that means "whatever was happening
	// is over, the store's truth is zero now". Cheap to call redundantly: a
	// second reset on an already-idle hook just no-ops through
	// `recordingStopped()`'s already-zero state.
	useLayoutEffect(() => {
		resetRef.current = () => {
			cancelAnimationFrame(audioFrameRef.current);
			cancelAnimationFrame(pulseFrameRef.current);
			audioFrameRef.current = 0;
			pulseFrameRef.current = 0;
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
		// Cancel any in-flight work from the previous session before starting a
		// new one. Frames are scheduled only when an audio/sentence event arrives.
		return onRecordingStart(() => {
			cancelAnimationFrame(audioFrameRef.current);
			cancelAnimationFrame(pulseFrameRef.current);
			audioFrameRef.current = 0;
			pulseFrameRef.current = 0;
			activeRef.current = true;
			rawLevelRef.current = 0;
			pulseRef.current = 0;
			sentenceFiredRef.current = false;
			committedLevelRef.current = 0;
			committedPulseRef.current = 0;
			// Reset isRecording + audioLevel + sentencePulse in one store
			// update so the visualizer doesn't briefly render the previous
			// cycle's last frame after the pill re-shows.
			recordingStarted();
		});
	}, [recordingStarted]);

	// Store committed to zero atomically — see `recordingStopped` docstring
	// for why this beats an rAF fade for hidden windows.
	useEffect(() => onRecordingStop(() => resetRef.current()), []);

	// User-initiated cancel. The server's abort flow doesn't emit
	// RecordingStopped (it only flips the state machine to INACTIVE), and the
	// relay's session-aborted gate now drops no_audio_detected too — so
	// without an explicit reset here the visualizer is stuck rendering the
	// last frame's amplitude (the bars
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
	// subscription so scheduled visualizer work / stale isRecording doesn't
	// outlive the session that started it. Redundant with the recordingMode
	// effect below and with `stt:recording-stop` when both fire — resetting
	// twice is a harmless no-op.
	useEffect(() => onLoopbackStopped(() => resetRef.current()), []);

	// Switching recordingMode (e.g. listen -> ptt) doesn't itself emit a
	// recording-lifecycle IPC event, so a stale isRecording=true + a running
	// visualizer left over from the mode being exited would otherwise persist
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
		// A lazily-created overlay can mount after recording-start was emitted.
		// Overlay lifecycle reconciliation restores the retained recording snapshot
		// into the shared store, but this hook's private frame-cancellation latch did
		// not see that missed edge. Accept the reconciled store state on the first
		// data event and latch it locally for the rest of the session.
		const ensureActive = (): boolean => {
			if (activeRef.current) {
				return true;
			}
			if (!useVisualizerStore.getState().isRecording) {
				return false;
			}
			activeRef.current = true;
			return true;
		};

		const flushAudioLevel = () => {
			audioFrameRef.current = 0;
			if (
				!activeRef.current ||
				rawLevelRef.current === committedLevelRef.current
			) {
				return;
			}

			committedLevelRef.current = rawLevelRef.current;
			setAudioLevel(rawLevelRef.current);
		};

		const advanceSentencePulse = (): void => {
			pulseFrameRef.current = 0;
			if (!activeRef.current) {
				return;
			}

			const pulse = sentenceFiredRef.current
				? 1
				: Math.max(0, pulseRef.current - PULSE_DECAY);
			sentenceFiredRef.current = false;
			pulseRef.current = pulse;
			if (pulse !== committedPulseRef.current) {
				committedPulseRef.current = pulse;
				setSentencePulse(pulse);
			}

			if (pulse > 0) {
				pulseFrameRef.current = requestAnimationFrame(advanceSentencePulse);
			}
		};

		const unsubAudioLevel = onAudioLevel((level) => {
			if (!ensureActive()) {
				return;
			}
			rawLevelRef.current = level;
			if (audioFrameRef.current === 0) {
				audioFrameRef.current = requestAnimationFrame(flushAudioLevel);
			}
		});
		const unsubSentence = onFullSentence(() => {
			if (!ensureActive()) {
				return;
			}
			sentenceFiredRef.current = true;
			if (pulseFrameRef.current === 0) {
				pulseFrameRef.current = requestAnimationFrame(advanceSentencePulse);
			}
		});
		return () => {
			unsubAudioLevel();
			unsubSentence();
			cancelAnimationFrame(audioFrameRef.current);
			cancelAnimationFrame(pulseFrameRef.current);
			audioFrameRef.current = 0;
			pulseFrameRef.current = 0;
		};
	}, [setAudioLevel, setSentencePulse]);

	useEffect(
		() => () => {
			activeRef.current = false;
			cancelAnimationFrame(audioFrameRef.current);
			cancelAnimationFrame(pulseFrameRef.current);
		},
		[],
	);
}
