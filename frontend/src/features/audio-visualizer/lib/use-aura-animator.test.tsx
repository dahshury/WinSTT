import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { Uniforms } from "../ui/ReactShaderToy";
import { useAuraAnimator } from "./use-aura-animator";

function createUniforms(): Uniforms {
	return {
		uSpeed: { type: "1f", value: 0 },
		uAmplitude: { type: "1f", value: 0 },
		uFrequency: { type: "1f", value: 0 },
		uMix: { type: "1f", value: 0 },
		uScale: { type: "1f", value: 0 },
	} as unknown as Uniforms;
}

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
		expect((result.current.current as unknown as { uSpeed: { value: number } }).uSpeed.value).toBe(
			10
		);
	});

	test("writes uSpeed=70 for speaking state", () => {
		const { result } = renderHook(() => {
			const ref = useRef<Uniforms>(createUniforms());
			useAuraAnimator("speaking", ref);
			return ref;
		});
		expect((result.current.current as unknown as { uSpeed: { value: number } }).uSpeed.value).toBe(
			70
		);
	});

	test("writes uSpeed=30 for connecting/initializing/thinking states", () => {
		for (const state of ["connecting", "initializing", "thinking"] as const) {
			const { result } = renderHook(() => {
				const ref = useRef<Uniforms>(createUniforms());
				useAuraAnimator(state, ref);
				return ref;
			});
			expect(
				(result.current.current as unknown as { uSpeed: { value: number } }).uSpeed.value
			).toBe(30);
		}
	});
});
