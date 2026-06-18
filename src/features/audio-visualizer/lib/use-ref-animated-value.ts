import {
	type AnimationPlaybackControlsWithThen,
	animate,
	useMotionValue,
	useMotionValueEvent,
	type ValueAnimationTransition,
} from "motion/react";
import { useRef } from "react";
import type { Uniforms } from "../ui/ReactShaderToy";

/**
 * Creates an animated motion value that writes directly to a mutable ref
 * instead of triggering React state updates. This avoids re-renders on every
 * animation frame — the ReactShaderToy render loop reads from the uniforms ref
 * instead of from React props.
 *
 * Shared by the WebGL shader animators (`useWaveAnimator`, `useAuraAnimator`),
 * which drive shader uniforms off the same per-frame, render-free pattern.
 */
export function useRefAnimatedValue(
	initialValue: number,
	uniformsRef: React.RefObject<Uniforms>,
	uniformName: string,
	uniformType: string,
) {
	const motionValue = useMotionValue(initialValue);
	const controlsRef = useRef<AnimationPlaybackControlsWithThen | null>(null);

	// Write every motion value change directly into the shared uniforms ref.
	useMotionValueEvent(motionValue, "change", (v: number) => {
		const uniforms = uniformsRef.current;
		if (uniforms?.[uniformName]) {
			uniforms[uniformName] = { type: uniformType, value: v };
		}
	});

	const animateFn = (
		targetValue: number | number[],
		transition: ValueAnimationTransition,
	) => {
		controlsRef.current = animate(motionValue, targetValue, transition);
	};

	return { motionValue, controls: controlsRef, animate: animateFn };
}
