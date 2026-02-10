"use client";

import { useCallback, useEffect, useRef } from "react";
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
export function useVisualizerSync() {
	const setRecording = useVisualizerStore((s) => s.setRecording);
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

	const animate = useCallback(() => {
		// Fading: decay level toward 0, stop once negligible
		if (fadingRef.current) {
			rawLevelRef.current = Math.max(0, rawLevelRef.current - FADE_DECAY);
			setAudioLevel(rawLevelRef.current);

			// Decay pulse during fade too
			let pulse = pulseRef.current;
			pulse = Math.max(0, pulse - PULSE_DECAY);
			pulseRef.current = pulse;
			setSentencePulse(pulse);

			if (rawLevelRef.current < 0.001) {
				fadingRef.current = false;
				activeRef.current = false;
				setAudioLevel(0);
				setSentencePulse(0);
				return; // Stop the rAF loop
			}
			rafRef.current = requestAnimationFrame(animate);
			return;
		}

		if (!activeRef.current) {
			return;
		}

		// Write raw audio level to store
		setAudioLevel(rawLevelRef.current);

		// Sentence pulse: fire to 1 then decay
		let pulse = pulseRef.current;
		if (sentenceFiredRef.current) {
			pulse = 1;
			sentenceFiredRef.current = false;
		} else {
			pulse = Math.max(0, pulse - PULSE_DECAY);
		}
		pulseRef.current = pulse;
		setSentencePulse(pulse);

		rafRef.current = requestAnimationFrame(animate);
	}, [setAudioLevel, setSentencePulse]);

	useEffect(() => {
		const unsubRecStart = onRecordingStart(() => {
			fadingRef.current = false;
			activeRef.current = true;
			setRecording(true);
			rawLevelRef.current = 0;
			pulseRef.current = 0;
			rafRef.current = requestAnimationFrame(animate);
		});

		const unsubRecStop = onRecordingStop(() => {
			setRecording(false);
			setSpeaking(false);
			// Start smooth fade-out instead of instant zero
			fadingRef.current = true;
			// rAF loop continues via fadingRef — animate() handles the decay
			if (!activeRef.current) {
				// If loop wasn't running, start it for the fade
				activeRef.current = true;
				rafRef.current = requestAnimationFrame(animate);
			}
		});

		const unsubVadStart = onVadStart(() => {
			setSpeaking(true);
		});

		const unsubVadStop = onVadStop(() => {
			setSpeaking(false);
		});

		const unsubAudioLevel = onAudioLevel((level) => {
			rawLevelRef.current = level;
		});

		const unsubSentence = onFullSentence(() => {
			sentenceFiredRef.current = true;
		});

		return () => {
			unsubRecStart();
			unsubRecStop();
			unsubVadStart();
			unsubVadStop();
			unsubAudioLevel();
			unsubSentence();
			activeRef.current = false;
			fadingRef.current = false;
			cancelAnimationFrame(rafRef.current);
		};
	}, [setRecording, setSpeaking, animate]);
}
