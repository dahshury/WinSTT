import {
	type AnimationPlaybackControlsWithThen,
	animate,
	useMotionValue,
	type ValueAnimationTransition,
} from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { useVisualizerStore } from "../model/visualizer-store";
import type { Uniforms } from "../ui/ReactShaderToy";
import type { AgentState } from "./audio-visualizer";

const DEFAULT_AMPLITUDE = 2;
const DEFAULT_FREQUENCY = 0.5;
const DEFAULT_SCALE = 0.2;
const DEFAULT_BRIGHTNESS = 1.5;
const DEFAULT_TRANSITION: ValueAnimationTransition = { duration: 0.5, ease: "easeOut" };
const DEFAULT_PULSE_TRANSITION: ValueAnimationTransition = {
	duration: 0.35,
	ease: "easeOut",
	repeat: Number.POSITIVE_INFINITY,
	repeatType: "mirror",
};

/**
 * Creates an animated motion value that writes directly to a mutable ref
 * instead of triggering React state updates. This avoids re-renders on
 * every animation frame — the ReactShaderToy render loop reads from the
 * uniforms ref instead of from React props.
 */
function useRefAnimatedValue(
	initialValue: number,
	uniformsRef: React.RefObject<Uniforms>,
	uniformName: string,
	uniformType: string
) {
	const motionValue = useMotionValue(initialValue);
	const controlsRef = useRef<AnimationPlaybackControlsWithThen | null>(null);

	// Write every motion value change directly into the shared uniforms ref
	useEffect(() => {
		const unsubscribe = motionValue.on("change", (v: number) => {
			const uniforms = uniformsRef.current;
			if (uniforms?.[uniformName]) {
				uniforms[uniformName] = { type: uniformType, value: v };
			}
		});
		return unsubscribe;
	}, [motionValue, uniformsRef, uniformName, uniformType]);

	const animateFn = useCallback(
		(targetValue: number | number[], transition: ValueAnimationTransition) => {
			controlsRef.current = animate(motionValue, targetValue, transition);
		},
		[motionValue]
	);

	return { motionValue, controls: controlsRef, animate: animateFn };
}

export function useAuraAnimator(state: AgentState, uniformsRef: React.RefObject<Uniforms>): void {
	const { animate: animateScale, motionValue: scaleMotionValue } = useRefAnimatedValue(
		DEFAULT_SCALE,
		uniformsRef,
		"uScale",
		"1f"
	);
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
	const { animate: animateBrightness } = useRefAnimatedValue(
		DEFAULT_BRIGHTNESS,
		uniformsRef,
		"uMix",
		"1f"
	);

	const audioLevel = useVisualizerStore((s) => s.audioLevel);

	// @crap-exclude rAF callback — covered via E2E (state-driven animation transitions)
	useEffect(() => {
		switch (state) {
			case "disconnected":
				// Speed is written directly to the ref (no animation needed)
				if (uniformsRef.current?.uSpeed) {
					uniformsRef.current.uSpeed = { type: "1f", value: 10 };
				}
				animateScale(0.2, DEFAULT_TRANSITION);
				animateAmplitude(1.2, DEFAULT_TRANSITION);
				animateFrequency(0.4, DEFAULT_TRANSITION);
				animateBrightness(1.0, DEFAULT_TRANSITION);
				return;
			case "listening":
				if (uniformsRef.current?.uSpeed) {
					uniformsRef.current.uSpeed = { type: "1f", value: 20 };
				}
				animateScale(0.3, { type: "spring", duration: 1.0, bounce: 0.35 });
				animateAmplitude(1.0, DEFAULT_TRANSITION);
				animateFrequency(0.7, DEFAULT_TRANSITION);
				animateBrightness([1.5, 2.0], DEFAULT_PULSE_TRANSITION);
				return;
			case "thinking":
			case "connecting":
			case "initializing":
				if (uniformsRef.current?.uSpeed) {
					uniformsRef.current.uSpeed = { type: "1f", value: 30 };
				}
				animateScale(0.3, DEFAULT_TRANSITION);
				animateAmplitude(0.5, DEFAULT_TRANSITION);
				animateFrequency(1, DEFAULT_TRANSITION);
				animateBrightness([0.5, 2.5], DEFAULT_PULSE_TRANSITION);
				return;
			case "speaking":
				if (uniformsRef.current?.uSpeed) {
					uniformsRef.current.uSpeed = { type: "1f", value: 70 };
				}
				animateScale(0.3, DEFAULT_TRANSITION);
				animateAmplitude(0.75, DEFAULT_TRANSITION);
				animateFrequency(1.25, DEFAULT_TRANSITION);
				animateBrightness(1.5, DEFAULT_TRANSITION);
				return;
			default:
				return;
		}
	}, [state, uniformsRef, animateScale, animateAmplitude, animateFrequency, animateBrightness]);

	useEffect(() => {
		const shouldApply = shouldApplyAudioLevelScale(
			state,
			audioLevel,
			scaleMotionValue.isAnimating()
		);
		if (shouldApply) {
			animateScale(0.2 + 0.2 * audioLevel, { duration: 0 });
		}
	}, [state, audioLevel, scaleMotionValue, animateScale]);
}

/**
 * Pure predicate for the audio-level branch of `useAuraAnimator`. Extracted
 * so the call-site useEffect stays at CC=2 (single `if`) and the branching
 * logic — `speaking` AND non-zero level AND not already animating — can be
 * exhaustively unit-tested without renderHook.
 */
export function shouldApplyAudioLevelScale(
	state: AgentState,
	audioLevel: number,
	isAnimating: boolean
): boolean {
	return state === "speaking" && audioLevel > 0 && !isAnimating;
}
