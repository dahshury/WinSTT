"use client";

import { useEffect, useRef } from "react";
import {
	onAudioLevel,
	onFullSentence,
	onRecordingStart,
	onRecordingStop,
	onVadStart,
	onVadStop,
} from "@/shared/api/ipc-client";
import { useVisualizerStore } from "../model/visualizer-store";

/** Sentence pulse decay per frame. */
const PULSE_DECAY = 0.03;
/** How quickly audio level decays each frame while fading out (~300-500ms at 60fps). */
const FADE_DECAY = 0.06;

/**
 * Subscribes to recording / VAD / audio-level IPC events and drives the
 * visualizer store with real RMS audio levels from the server.
 */
export function useVisualizerSync(): void {
	const recordingStarted = useVisualizerStore((s) => s.recordingStarted);
	const recordingStopped = useVisualizerStore((s) => s.recordingStopped);
	const setSpeaking = useVisualizerStore((s) => s.setSpeaking);
	const setAudioLevel = useVisualizerStore((s) => s.setAudioLevel);
	const setSentencePulse = useVisualizerStore((s) => s.setSentencePulse);

	const rafRef = useRef(0);
	const activeRef = useRef(false);
	const fadingRef = useRef(false);

	// Mutable accumulators updated from IPC callbacks, read in rAF loop.
	const rawLevelRef = useRef(0);
	const sentenceFiredRef = useRef(false);

	// Smoothed values persisted across frames.
	const pulseRef = useRef(0);

	// Hold the latest animate fn in a ref so subscription effects can schedule
	// frames without listing it as a dependency (the function closes over
	// store setters which are stable, but the ref keeps things honest).
	// @crap-exclude rAF callback — covered via E2E
	const animateRef = useRef<() => void>(() => {
		// noop placeholder, replaced on every render below
	});
	animateRef.current = () => {
		if (fadingRef.current) {
			rawLevelRef.current = Math.max(0, rawLevelRef.current - FADE_DECAY);
			setAudioLevel(rawLevelRef.current);

			const decayedPulse = Math.max(0, pulseRef.current - PULSE_DECAY);
			pulseRef.current = decayedPulse;
			setSentencePulse(decayedPulse);

			if (rawLevelRef.current < 0.001) {
				fadingRef.current = false;
				activeRef.current = false;
				setAudioLevel(0);
				setSentencePulse(0);
				return;
			}
			rafRef.current = requestAnimationFrame(() => animateRef.current());
			return;
		}

		if (!activeRef.current) {
			return;
		}

		setAudioLevel(rawLevelRef.current);

		let pulse = pulseRef.current;
		if (sentenceFiredRef.current) {
			pulse = 1;
			sentenceFiredRef.current = false;
		} else {
			pulse = Math.max(0, pulse - PULSE_DECAY);
		}
		pulseRef.current = pulse;
		setSentencePulse(pulse);

		rafRef.current = requestAnimationFrame(() => animateRef.current());
	};

	useEffect(() => {
		// Cancel any in-flight frame before scheduling a new one. Without
		// this, rapid PTT cycles (recording_stop → fade in progress →
		// recording_start) leak an extra rAF callback each cycle. The
		// callbacks each call requestAnimationFrame(animate) again, so the
		// scheduled-frame count grows exponentially and the renderer drowns
		// — which keeps the overlay BrowserWindow too busy to process its
		// hide() IPC, leaving the pill stuck on screen.
		return onRecordingStart(() => {
			cancelAnimationFrame(rafRef.current);
			fadingRef.current = false;
			activeRef.current = true;
			rawLevelRef.current = 0;
			pulseRef.current = 0;
			// Reset isRecording + audioLevel + sentencePulse in one store
			// update so the visualizer doesn't briefly render the previous
			// cycle's last frame after the pill re-shows.
			recordingStarted();
			rafRef.current = requestAnimationFrame(() => animateRef.current());
		});
	}, [recordingStarted]);

	useEffect(
		() =>
			onRecordingStop(() => {
				recordingStopped();
				fadingRef.current = true;
				if (!activeRef.current) {
					cancelAnimationFrame(rafRef.current);
					activeRef.current = true;
					rafRef.current = requestAnimationFrame(() => animateRef.current());
				}
			}),
		[recordingStopped]
	);

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
			fadingRef.current = false;
			cancelAnimationFrame(rafRef.current);
		},
		[]
	);
}
