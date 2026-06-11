import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useVisualizerStore } from "../model/visualizer-store";
import type { Uniforms } from "../ui/ReactShaderToy";
import type { AgentState } from "./audio-visualizer";
import {
	shouldApplyAudioLevelScale,
	useAuraAnimator,
} from "./use-aura-animator";

function createUniforms(): Uniforms {
	return {
		uSpeed: { type: "1f", value: 0 },
		uAmplitude: { type: "1f", value: 0 },
		uFrequency: { type: "1f", value: 0 },
		uMix: { type: "1f", value: 0 },
		uScale: { type: "1f", value: 0 },
	} as unknown as Uniforms;
}

function getUniformValue(ref: React.RefObject<Uniforms>, name: string): number {
	const uniforms = ref.current as unknown as Record<string, { value: number }>;
	return uniforms[name]?.value ?? Number.NaN;
}

beforeEach(() => {
	useVisualizerStore.setState({ audioLevel: 0 });
});

afterEach(() => {
	useVisualizerStore.setState({ audioLevel: 0 });
});

describe("useAuraAnimator", () => {
	test("hook runs without throwing across all canonical states", () => {
		for (const state of [
			"disconnected",
			"listening",
			"thinking",
			"connecting",
			"initializing",
			"speaking",
		] as const) {
			const { unmount } = renderHook(() => {
				const ref = useRef<Uniforms>(createUniforms());
				useAuraAnimator(state, ref);
				return ref;
			});
			unmount();
		}
	});

	test("writes uSpeed=10 for disconnected state", () => {
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useAuraAnimator("disconnected", ref);
			return ref;
		});
		expect(getUniformValue(result.current, "uSpeed")).toBe(10);
	});

	test("writes uSpeed=20 for listening state", () => {
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useAuraAnimator("listening", ref);
			return ref;
		});
		expect(getUniformValue(result.current, "uSpeed")).toBe(20);
	});

	test("writes uSpeed=70 for speaking state", () => {
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useAuraAnimator("speaking", ref);
			return ref;
		});
		expect(getUniformValue(result.current, "uSpeed")).toBe(70);
	});

	test("writes uSpeed=30 for connecting/initializing/thinking states", () => {
		for (const state of ["connecting", "initializing", "thinking"] as const) {
			const { result } = renderHook(() => {
				const ref = useRef<Uniforms>(createUniforms());
				useAuraAnimator(state, ref);
				return ref;
			});
			expect(getUniformValue(result.current, "uSpeed")).toBe(30);
		}
	});

	test("transitions between states update uSpeed (rerender path)", () => {
		const { result, rerender } = renderHook(
			({ state }: { state: AgentState }) => {
				const ref = useRef<Uniforms>(createUniforms());
				useAuraAnimator(state, ref);
				return ref;
			},
			{ initialProps: { state: "disconnected" as AgentState } },
		);
		expect(getUniformValue(result.current, "uSpeed")).toBe(10);
		rerender({ state: "speaking" as AgentState });
		expect(getUniformValue(result.current, "uSpeed")).toBe(70);
		rerender({ state: "listening" as AgentState });
		expect(getUniformValue(result.current, "uSpeed")).toBe(20);
	});

	test("default branch (unknown state) leaves uSpeed at initial value", () => {
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			// Cast to AgentState — the switch's `default` branch handles unmapped values.
			useAuraAnimator(asInvalid<AgentState>("unknown"), ref);
			return ref;
		});
		expect(getUniformValue(result.current, "uSpeed")).toBe(0);
	});

	test("missing uSpeed key in uniforms ref is tolerated (no throw)", () => {
		// Empty uniforms object — `uniformsRef.current?.uSpeed` is undefined,
		// the guarded write is skipped, and no error is raised.
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(asInvalid<Uniforms>({}));
			useAuraAnimator("speaking", ref);
			return ref;
		});
		expect(result.current.current).toBeDefined();
	});

	test("animate() fires motion change listener and writes uScale uniform", async () => {
		// Exercises lines 40-48 of use-aura-animator.ts (the on-change handler).
		// `animate(value, {duration: 0})` resolves on the next animation frame,
		// firing the change listener synchronously within that frame.
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useAuraAnimator("speaking", ref);
			return ref;
		});
		// Wait one frame for motion's runtime to flush the duration:0 animation.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
		const uScale = getUniformValue(result.current, "uScale");
		// `disconnected` -> `speaking` initial render animates uScale toward 0.3
		// or the audioLevel branch may write 0.2 — both prove the change listener fired.
		expect(uScale).toBeGreaterThan(0);
	});

	test("speaking + audioLevel > 0 triggers audio-level branch when no animation is active", async () => {
		// Wait for the state-driven animation on uScale to settle, then bump audioLevel
		// so the second effect's guard `!scaleMotionValue.isAnimating()` passes and
		// the duration:0 set (lines 153-155) actually runs.
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useAuraAnimator("speaking", ref);
			return ref;
		});
		// Let the initial state-driven scale animation (duration 0.5s easeOut) finish.
		await new Promise((r) => setTimeout(r, 700));
		// Trigger the audio-level branch by updating the store.
		act(() => {
			useVisualizerStore.getState().setAudioLevel(0.5);
		});
		// audioLevel=0.5 → 0.2 + 0.2*0.5 = 0.3 with duration:0
		await waitFor(() =>
			expect(getUniformValue(result.current, "uScale")).toBeCloseTo(0.3, 2),
		);
	});

	test("speaking + audioLevel > 0 is suppressed while scale animation is in flight", () => {
		expect(shouldApplyAudioLevelScale("speaking", 0.5, true)).toBe(false);
	});

	test("speaking with audioLevel=0 leaves uScale on its default animation path", async () => {
		// audioLevel > 0 branch must be false, so the duration:0 set is skipped.
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useAuraAnimator("speaking", ref);
			return ref;
		});
		// audioLevel stays 0 from beforeEach
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});
		// State-driven animation drives uScale toward 0.3; the duration:0 audio
		// branch is skipped because audioLevel === 0.
		expect(getUniformValue(result.current, "uScale")).toBeGreaterThan(0);
	});
});

describe("shouldApplyAudioLevelScale", () => {
	test("returns true when speaking, audioLevel > 0, and not animating", () => {
		expect(shouldApplyAudioLevelScale("speaking", 0.5, false)).toBe(true);
	});

	test("returns false when state is not 'speaking'", () => {
		for (const s of [
			"disconnected",
			"listening",
			"thinking",
			"connecting",
			"initializing",
		] as const) {
			expect(shouldApplyAudioLevelScale(s, 0.5, false)).toBe(false);
		}
	});

	test("returns false when audioLevel is 0 (boundary)", () => {
		expect(shouldApplyAudioLevelScale("speaking", 0, false)).toBe(false);
	});

	test("returns false when audioLevel is negative", () => {
		expect(shouldApplyAudioLevelScale("speaking", -0.5, false)).toBe(false);
	});

	test("returns false while an animation is in flight", () => {
		expect(shouldApplyAudioLevelScale("speaking", 0.5, true)).toBe(false);
	});
});

describe("useAuraAnimator (cont.)", () => {
	test("non-speaking state ignores audioLevel changes (integration)", async () => {
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useAuraAnimator("disconnected", ref);
			return ref;
		});
		act(() => {
			useVisualizerStore.getState().setAudioLevel(0.9);
		});
		await new Promise((r) => setTimeout(r, 30));
		// disconnected drives uScale via its state branch, not via audioLevel branch.
		// The audio branch (state !== "speaking") must short-circuit.
		// We assert uScale is not the 0.2 + 0.2*0.9 = 0.38 audio-branch value.
		expect(getUniformValue(result.current, "uScale")).not.toBeCloseTo(0.38, 3);
	});
});
