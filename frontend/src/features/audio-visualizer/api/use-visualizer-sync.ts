"use client";

import { useCallback, useEffect, useRef } from "react";
import { onRecordingStart, onRecordingStop } from "@/shared/api/ipc-client";
import { useVisualizerStore } from "../model/visualizer-store";

const POINT_COUNT = 64;
/** Smoothing factor: 0 = frozen, 1 = instant. Lower = smoother. */
const SMOOTHING = 0.12;

/**
 * Subscribes to recording IPC events and drives the visualizer store
 * with smooth synthetic frequency data while recording is active.
 */
export function useVisualizerSync() {
	const setActive = useVisualizerStore((s) => s.setActive);
	const setFrequencyData = useVisualizerStore((s) => s.setFrequencyData);
	const rafRef = useRef(0);
	const activeRef = useRef(false);

	// Persistent state across frames (not React state - mutated in rAF)
	const currentRef = useRef(new Float32Array(POINT_COUNT));
	const targetRef = useRef(new Float32Array(POINT_COUNT));
	const phasesRef = useRef(new Float32Array(POINT_COUNT));
	const retargetTimerRef = useRef(0);

	/** Pick new random target amplitudes every ~120ms for organic drift. */
	const pickTargets = useCallback(() => {
		const targets = targetRef.current;
		const phases = phasesRef.current;
		const t = performance.now() / 1000;

		for (let i = 0; i < POINT_COUNT; i++) {
			const phase = phases[i] ?? 0;
			const center = Math.abs(i - POINT_COUNT / 2) / (POINT_COUNT / 2);
			const centerBoost = 1 - center * 0.45;

			// Layered waves for slow, breathing movement
			const wave1 = Math.sin(phase + t * 1.8) * 0.3;
			const wave2 = Math.sin(phase * 0.7 + t * 2.6) * 0.2;
			const wave3 = Math.sin(phase * 1.3 + t * 0.9) * 0.15;
			const jitter = (Math.random() - 0.5) * 0.15;

			const raw = (0.35 + wave1 + wave2 + wave3 + jitter) * centerBoost;
			targets[i] = Math.max(0.04, Math.min(1, raw));
		}
	}, []);

	const animate = useCallback(() => {
		if (!activeRef.current) {
			return;
		}

		const current = currentRef.current;
		const targets = targetRef.current;
		const out = new Uint8Array(POINT_COUNT);

		for (let i = 0; i < POINT_COUNT; i++) {
			// Exponential smoothing toward target
			const c = current[i] ?? 0;
			const t = targets[i] ?? 0;
			const next = c + (t - c) * SMOOTHING;
			current[i] = next;
			out[i] = Math.round(next * 255);
		}

		setFrequencyData(out);

		// Re-pick targets periodically for natural drift
		retargetTimerRef.current++;
		if (retargetTimerRef.current >= 7) {
			retargetTimerRef.current = 0;
			pickTargets();
		}

		rafRef.current = requestAnimationFrame(animate);
	}, [setFrequencyData, pickTargets]);

	useEffect(() => {
		const unsubStart = onRecordingStart(() => {
			activeRef.current = true;
			setActive(true);

			// Initialize phases once per recording session
			const phases = phasesRef.current;
			for (let i = 0; i < POINT_COUNT; i++) {
				phases[i] = Math.random() * Math.PI * 2;
			}
			currentRef.current.fill(0);
			pickTargets();
			retargetTimerRef.current = 0;
			rafRef.current = requestAnimationFrame(animate);
		});

		const unsubStop = onRecordingStop(() => {
			activeRef.current = false;
			setActive(false);
			cancelAnimationFrame(rafRef.current);
			// Fade out: set all to zero
			setFrequencyData(new Uint8Array(POINT_COUNT));
		});

		return () => {
			unsubStart();
			unsubStop();
			activeRef.current = false;
			cancelAnimationFrame(rafRef.current);
		};
	}, [setActive, setFrequencyData, animate, pickTargets]);
}
