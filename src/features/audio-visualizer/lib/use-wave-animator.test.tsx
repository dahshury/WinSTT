import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { Uniforms } from "../ui/ReactShaderToy";
import { useWaveAnimator } from "./use-wave-animator";

function createUniforms(): Uniforms {
	return {
		uSpeed: { type: "1f", value: 0 },
		uAmplitude: { type: "1f", value: 0 },
		uFrequency: { type: "1f", value: 0 },
		uMix: { type: "1f", value: 0 },
	} as unknown as Uniforms;
}

describe("useWaveAnimator", () => {
	test("hook executes without throwing for each state", () => {
		const states = [
			"disconnected",
			"listening",
			"thinking",
			"connecting",
			"speaking",
		] as const;
		for (const state of states) {
			const { unmount } = renderHook(() => {
				const ref = useRef<Uniforms>(createUniforms());
				useWaveAnimator(state, ref);
				return ref;
			});
			unmount();
		}
	});

	test("writes uSpeed value to the uniforms ref for non-default states", () => {
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useWaveAnimator("disconnected", ref);
			return ref;
		});
		// disconnected uses DEFAULT_SPEED = 5
		expect(
			(result.current.current as unknown as { uSpeed: { value: number } })
				.uSpeed.value,
		).toBe(5);
	});

	test("writes a faster speed for connecting state", () => {
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useWaveAnimator("connecting", ref);
			return ref;
		});
		// connecting uses DEFAULT_SPEED * 4 = 20
		expect(
			(result.current.current as unknown as { uSpeed: { value: number } })
				.uSpeed.value,
		).toBe(20);
	});
});
