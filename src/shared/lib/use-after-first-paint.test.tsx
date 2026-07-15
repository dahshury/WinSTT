import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useAfterFirstPaint } from "./use-after-first-paint";

const realRequestAnimationFrame = window.requestAnimationFrame;
const realCancelAnimationFrame = window.cancelAnimationFrame;
let callbacks: FrameRequestCallback[] = [];

beforeEach(() => {
	callbacks = [];
	window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		callbacks.push(callback);
		return callbacks.length;
	}) as typeof window.requestAnimationFrame;
	window.cancelAnimationFrame = (() =>
		undefined) as typeof window.cancelAnimationFrame;
});

afterEach(() => {
	window.requestAnimationFrame = realRequestAnimationFrame;
	window.cancelAnimationFrame = realCancelAnimationFrame;
});

describe("useAfterFirstPaint", () => {
	test("opens the boundary only after two animation frames", () => {
		const { result, unmount } = renderHook(() => useAfterFirstPaint());
		expect(result.current).toBeFalse();

		act(() => callbacks.shift()?.(0));
		expect(result.current).toBeFalse();

		act(() => callbacks.shift()?.(16));
		expect(result.current).toBeTrue();
		unmount();
	});
});
