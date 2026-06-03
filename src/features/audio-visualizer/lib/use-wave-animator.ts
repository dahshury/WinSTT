import type { ValueAnimationTransition } from "motion/react";
import { useEffect } from "react";
import { useVisualizerStore } from "../model/visualizer-store";
import type { Uniforms } from "../ui/ReactShaderToy";
import type { AgentState } from "./audio-visualizer";
import { useRefAnimatedValue } from "./use-ref-animated-value";

const DEFAULT_SPEED = 5;
// Amplitude is in UV space (canvas height = 1.0). Server-side audioLevel is
// `rms / 10000` on int16 samples, which peaks much lower than LiveKit's
// useTrackVolume (the upstream reference's source) — typical speech sits
// around 0.05–0.25. We boost the idle baseline and use a perceptual sqrt
// curve in the speaking branch so the wave visibly fills the canvas instead
// of barely deviating a few percent.
const DEFAULT_AMPLITUDE = 0.08;
const MAX_SPEAKING_AMPLITUDE = 0.4;
const SPEAKING_AMPLITUDE_BASE = 0.06;
const SPEAKING_AMPLITUDE_GAIN = 0.9;
const DEFAULT_FREQUENCY = 10;
const DEFAULT_TRANSITION: ValueAnimationTransition = { duration: 0.2, ease: "easeOut" };

export function useWaveAnimator(state: AgentState, uniformsRef: React.RefObject<Uniforms>): void {
	const { animate: animateAmplitude } = useRefAnimatedValue(
		DEFAULT_AMPLITUDE,
		uniformsRef,
		"uAmplitude",
		"1f"
	);
	const { animate: animateFrequency } = useRefAnimatedValue(
		DEFAULT_FREQUENCY,
		uniformsRef,
		"uFrequency",
		"1f"
	);
	const { animate: animateOpacity } = useRefAnimatedValue(1.0, uniformsRef, "uMix", "1f");

	const audioLevel = useVisualizerStore((s) => s.audioLevel);

	// @crap-exclude rAF callback — covered via E2E (state-driven animation transitions)
	useEffect(() => {
		switch (state) {
			case "disconnected":
				if (uniformsRef.current?.uSpeed) {
					uniformsRef.current.uSpeed = { type: "1f", value: DEFAULT_SPEED };
				}
				animateAmplitude(0, DEFAULT_TRANSITION);
				animateFrequency(0, DEFAULT_TRANSITION);
				animateOpacity(1.0, DEFAULT_TRANSITION);
				return;
			case "listening":
				if (uniformsRef.current?.uSpeed) {
					uniformsRef.current.uSpeed = { type: "1f", value: DEFAULT_SPEED };
				}
				animateAmplitude(DEFAULT_AMPLITUDE, DEFAULT_TRANSITION);
				animateFrequency(DEFAULT_FREQUENCY, DEFAULT_TRANSITION);
				animateOpacity([1.0, 0.3], {
					duration: 0.75,
					repeat: Number.POSITIVE_INFINITY,
					repeatType: "mirror",
				});
				return;
			case "thinking":
			case "connecting":
			case "initializing":
				if (uniformsRef.current?.uSpeed) {
					uniformsRef.current.uSpeed = { type: "1f", value: DEFAULT_SPEED * 4 };
				}
				animateAmplitude(DEFAULT_AMPLITUDE / 4, DEFAULT_TRANSITION);
				animateFrequency(DEFAULT_FREQUENCY * 4, DEFAULT_TRANSITION);
				animateOpacity([1.0, 0.3], {
					duration: 0.4,
					repeat: Number.POSITIVE_INFINITY,
					repeatType: "mirror",
				});
				return;
			default:
				if (uniformsRef.current?.uSpeed) {
					uniformsRef.current.uSpeed = { type: "1f", value: DEFAULT_SPEED * 2 };
				}
				animateAmplitude(DEFAULT_AMPLITUDE, DEFAULT_TRANSITION);
				animateFrequency(DEFAULT_FREQUENCY, DEFAULT_TRANSITION);
				animateOpacity(1.0, DEFAULT_TRANSITION);
				return;
		}
	}, [state, uniformsRef, animateAmplitude, animateFrequency, animateOpacity]);

	useEffect(() => {
		if (state === "speaking") {
			const perceptual = Math.sqrt(Math.max(0, audioLevel));
			const amplitude = Math.min(
				MAX_SPEAKING_AMPLITUDE,
				SPEAKING_AMPLITUDE_BASE + SPEAKING_AMPLITUDE_GAIN * perceptual
			);
			animateAmplitude(amplitude, { duration: 0 });
			animateFrequency(20 + 60 * audioLevel, { duration: 0 });
		}
	}, [state, audioLevel, animateAmplitude, animateFrequency]);
}
