import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type React from "react";

// motion/react's `useReducedMotion` lazily initializes a module-global listener
// the FIRST time it runs and never re-reads `window.matchMedia` afterwards (see
// framer-motion's `hasReducedMotionListener` cache). That makes overriding
// matchMedia per-test ineffective. Mock the module so `useReducedMotion` reads a
// test-controlled flag while every other motion export (animate / useMotionValue
// / useTransform) keeps its real implementation.
let reducedMotionFlag = false;
mock.module("motion/react", () => {
	const actual = require("motion/react");
	return {
		...actual,
		useReducedMotion: () => reducedMotionFlag,
	};
});

const {
	decimalsForStep,
	useSliderInteraction,
}: typeof import("./use-slider-interaction") = require("./use-slider-interaction");
type UseSliderInteractionArgs = import("./use-slider-interaction").UseSliderInteractionArgs;

// ── Fake DOM geometry ─────────────────────────────────────────────────
// happy-dom returns 0 for every layout metric. The hook's pointer math reads
// `wrapper.getBoundingClientRect()`, `wrapper.offsetWidth`, and the label/value
// `offsetWidth`. Stub those so positionToValue / computeRubberStretch / the
// dodge measurement compute real numbers.
interface Geometry {
	left: number;
	right: number;
	width: number;
}

function makeEl(tag: string, geo: Partial<Geometry & { offsetWidth: number }>): HTMLElement {
	const el = document.createElement(tag);
	const width = geo.width ?? 0;
	const left = geo.left ?? 0;
	el.getBoundingClientRect = () =>
		({
			left,
			right: geo.right ?? left + width,
			top: 0,
			bottom: 9,
			width,
			height: 9,
			x: left,
			y: 0,
			toJSON: () => ({}),
		}) as DOMRect;
	Object.defineProperty(el, "offsetWidth", {
		configurable: true,
		value: geo.offsetWidth ?? width,
	});
	return el;
}

function refOf<T>(el: T | null): React.RefObject<T | null> {
	return { current: el };
}

interface Harness {
	args: UseSliderInteractionArgs;
	onChange: ReturnType<typeof mock<(n: number) => void>>;
}

function buildArgs(
	overrides: Partial<UseSliderInteractionArgs> = {},
	geo: { wrapper?: Partial<Geometry & { offsetWidth: number }> } = {}
): Harness {
	const onChange = mock<(n: number) => void>(() => undefined);
	// Default wrapper spans clientX 0..100 with 100px width so percent === clientX.
	const wrapper = makeEl("div", geo.wrapper ?? { left: 0, width: 100, offsetWidth: 100 });
	const track = makeEl("div", {});
	const label = makeEl("span", { offsetWidth: 20 });
	const valueEl = makeEl("span", { offsetWidth: 20 });
	const args: UseSliderInteractionArgs = {
		disabled: undefined,
		labelRef: refOf<HTMLSpanElement>(label as HTMLSpanElement),
		max: 100,
		min: 0,
		onChange,
		step: 1,
		trackRef: refOf<HTMLDivElement>(track as HTMLDivElement),
		value: 0,
		valueRef: refOf<HTMLSpanElement>(valueEl as HTMLSpanElement),
		wrapperRef: refOf<HTMLDivElement>(wrapper as HTMLDivElement),
		...overrides,
	};
	return { args, onChange };
}

function pointerEvent(
	type: string,
	props: { clientX?: number; clientY?: number; pointerId?: number; target?: EventTarget }
): React.PointerEvent {
	const target = (props.target ?? makeEl("div", {})) as HTMLElement;
	if (typeof target.setPointerCapture !== "function") {
		(target as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () =>
			undefined;
	}
	return {
		type,
		clientX: props.clientX ?? 0,
		clientY: props.clientY ?? 0,
		pointerId: props.pointerId ?? 1,
		target,
		preventDefault: () => undefined,
	} as unknown as React.PointerEvent;
}

function keyEvent(key: string, shiftKey = false): React.KeyboardEvent {
	return {
		key,
		shiftKey,
		preventDefault: () => undefined,
	} as unknown as React.KeyboardEvent;
}

beforeEach(() => {
	reducedMotionFlag = false;
});

afterEach(() => {
	cleanup();
	reducedMotionFlag = false;
});

describe("decimalsForStep", () => {
	test("integer steps have zero decimals", () => {
		expect(decimalsForStep(1)).toBe(0);
		expect(decimalsForStep(10)).toBe(0);
		expect(decimalsForStep(2)).toBe(0);
	});

	test("counts the digits after the decimal point", () => {
		expect(decimalsForStep(0.1)).toBe(1);
		expect(decimalsForStep(0.25)).toBe(2);
		expect(decimalsForStep(0.005)).toBe(3);
	});
});

describe("useSliderInteraction — derived state", () => {
	test("percentage maps value within [min,max] to 0..100", () => {
		const { args } = buildArgs({ min: 0, max: 200, value: 50 });
		const { result } = renderHook(() => useSliderInteraction(args));
		expect(result.current.percentage).toBe(25);
	});

	test("guards a zero-width range (max === min) against divide-by-zero", () => {
		// range = max - min || 1, so percentage is (value-min)/1*100, never NaN.
		const { args } = buildArgs({ min: 5, max: 5, value: 5 });
		const { result } = renderHook(() => useSliderInteraction(args));
		expect(Number.isNaN(result.current.percentage)).toBe(false);
		expect(result.current.percentage).toBe(0);
	});

	test("initial interaction state is fully inactive", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		expect(result.current.interaction).toEqual({
			isInteracting: false,
			isDragging: false,
			isHovered: false,
			keyboardFocusRing: false,
		});
	});

	test("shouldReduceMotion reflects the motion preference (false by default)", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		expect(result.current.shouldReduceMotion).toBe(false);
	});
});

describe("interaction reducer via dispatchInteraction", () => {
	test("pointerDown sets isInteracting and clears keyboardFocusRing", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.dispatchInteraction({ type: "focusRingOn" }));
		expect(result.current.interaction.keyboardFocusRing).toBe(true);
		act(() => result.current.dispatchInteraction({ type: "pointerDown" }));
		expect(result.current.interaction.isInteracting).toBe(true);
		expect(result.current.interaction.keyboardFocusRing).toBe(false);
	});

	test("mouseEnter / mouseLeave toggle isHovered and are idempotent", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.dispatchInteraction({ type: "mouseEnter" }));
		expect(result.current.interaction.isHovered).toBe(true);
		const stateRef = result.current.interaction;
		// Re-entering when already hovered returns the SAME state object (no-op branch).
		act(() => result.current.dispatchInteraction({ type: "mouseEnter" }));
		expect(result.current.interaction).toBe(stateRef);
		act(() => result.current.dispatchInteraction({ type: "mouseLeave" }));
		expect(result.current.interaction.isHovered).toBe(false);
		const leftRef = result.current.interaction;
		// Leaving when not hovered is a no-op (returns same state).
		act(() => result.current.dispatchInteraction({ type: "mouseLeave" }));
		expect(result.current.interaction).toBe(leftRef);
	});

	test("focusRingOn / focusRingOff toggle keyboardFocusRing idempotently", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		const initial = result.current.interaction;
		// Off when already off is a no-op.
		act(() => result.current.dispatchInteraction({ type: "focusRingOff" }));
		expect(result.current.interaction).toBe(initial);
		act(() => result.current.dispatchInteraction({ type: "focusRingOn" }));
		expect(result.current.interaction.keyboardFocusRing).toBe(true);
		const onRef = result.current.interaction;
		act(() => result.current.dispatchInteraction({ type: "focusRingOn" }));
		expect(result.current.interaction).toBe(onRef);
		act(() => result.current.dispatchInteraction({ type: "focusRingOff" }));
		expect(result.current.interaction.keyboardFocusRing).toBe(false);
	});

	test("pointerUp clears both isInteracting and isDragging", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.dispatchInteraction({ type: "pointerDown" }));
		act(() => result.current.dispatchInteraction({ type: "dragStart" }));
		expect(result.current.interaction.isDragging).toBe(true);
		act(() => result.current.dispatchInteraction({ type: "pointerUp" }));
		expect(result.current.interaction.isInteracting).toBe(false);
		expect(result.current.interaction.isDragging).toBe(false);
	});

	test("dragStart is idempotent once dragging", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.dispatchInteraction({ type: "dragStart" }));
		const dragRef = result.current.interaction;
		act(() => result.current.dispatchInteraction({ type: "dragStart" }));
		expect(result.current.interaction).toBe(dragRef);
	});
});

describe("handleKeyDown", () => {
	test("ArrowRight / ArrowUp increment by step", () => {
		const { args, onChange } = buildArgs({ value: 5, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("ArrowRight")));
		expect(onChange).toHaveBeenLastCalledWith(6);
		act(() => result.current.handleKeyDown(keyEvent("ArrowUp")));
		expect(onChange).toHaveBeenLastCalledWith(6);
	});

	test("ArrowLeft / ArrowDown decrement by step", () => {
		const { args, onChange } = buildArgs({ value: 5, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("ArrowLeft")));
		expect(onChange).toHaveBeenLastCalledWith(4);
		act(() => result.current.handleKeyDown(keyEvent("ArrowDown")));
		expect(onChange).toHaveBeenLastCalledWith(4);
	});

	test("Shift multiplies the step by 10", () => {
		const { args, onChange } = buildArgs({ value: 20, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("ArrowRight", true)));
		expect(onChange).toHaveBeenLastCalledWith(30);
	});

	test("Home jumps to min, End jumps to max", () => {
		const { args, onChange } = buildArgs({ value: 50, min: 0, max: 100 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("Home")));
		expect(onChange).toHaveBeenLastCalledWith(0);
		act(() => result.current.handleKeyDown(keyEvent("End")));
		expect(onChange).toHaveBeenLastCalledWith(100);
	});

	test("clamps an increment past max back to max", () => {
		const { args, onChange } = buildArgs({ value: 100, min: 0, max: 100, step: 5 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("ArrowRight")));
		expect(onChange).toHaveBeenLastCalledWith(100);
	});

	test("keyboard nudge snaps onto the MIN-anchored grid (min=3 step=2 → 5, not 4)", () => {
		const { args, onChange } = buildArgs({ value: 3, min: 3, max: 21, step: 2 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("ArrowRight")));
		expect(onChange).toHaveBeenLastCalledWith(5);
	});

	test("an unhandled key is ignored (no onChange, no focus ring)", () => {
		const { args, onChange } = buildArgs({ value: 5 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("Tab")));
		expect(onChange).not.toHaveBeenCalled();
		expect(result.current.interaction.keyboardFocusRing).toBe(false);
	});

	test("a handled key turns on the keyboard focus ring", () => {
		const { args } = buildArgs({ value: 5 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("ArrowRight")));
		expect(result.current.interaction.keyboardFocusRing).toBe(true);
	});

	test("disabled slider ignores all keys", () => {
		const { args, onChange } = buildArgs({ value: 5, disabled: true });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handleKeyDown(keyEvent("ArrowRight")));
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("showKeyboardFocusRing", () => {
	test("turns on the focus ring when focus did NOT come from a pointer-down", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.showKeyboardFocusRing());
		expect(result.current.interaction.keyboardFocusRing).toBe(true);
	});

	test("suppresses the focus ring for the frame right after a pointer-down", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		// pointerDown sets pendingPointerFocusRef = true for one rAF frame; the
		// synthetic track.focus() forwards into showKeyboardFocusRing, which must
		// NOT flag this as a keyboard focus.
		act(() => {
			result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 10 }));
			result.current.showKeyboardFocusRing();
		});
		expect(result.current.interaction.keyboardFocusRing).toBe(false);
	});
});

describe("handlePointerDown", () => {
	test("disabled slider does not enter the interacting state", () => {
		const { args } = buildArgs({ disabled: true });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 10 })));
		expect(result.current.interaction.isInteracting).toBe(false);
	});

	test("enabled slider enters interacting state and captures the pointer", () => {
		const { args } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		const target = makeEl("div", {});
		let captured = -1;
		(target as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = (id) => {
			captured = id;
		};
		act(() =>
			result.current.handlePointerDown(
				pointerEvent("pointerdown", { clientX: 10, pointerId: 7, target })
			)
		);
		expect(result.current.interaction.isInteracting).toBe(true);
		expect(captured).toBe(7);
	});
});

describe("handlePointerMove", () => {
	test("ignores moves when not interacting", () => {
		const { args, onChange } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 50 })));
		expect(onChange).not.toHaveBeenCalled();
	});

	test("a move within the click threshold does NOT start a drag or change value", () => {
		const { args, onChange } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 10 })));
		// Move only 2px — below CLICK_THRESHOLD (3) → stays a click, returns early.
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 12 })));
		expect(result.current.interaction.isDragging).toBe(false);
		expect(onChange).not.toHaveBeenCalled();
	});

	test("a move past the threshold starts a drag and emits the snapped value", () => {
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 10 })));
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 40 })));
		expect(result.current.interaction.isDragging).toBe(true);
		// wrapper spans 0..100 (100px) so clientX 40 → value 40.
		expect(onChange).toHaveBeenLastCalledWith(40);
	});

	test("clamps a drag past the right edge to max", () => {
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 10 })));
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 500 })));
		expect(onChange).toHaveBeenLastCalledWith(100);
	});

	test("clamps a drag past the left edge to min", () => {
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 90 })));
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: -300 })));
		expect(onChange).toHaveBeenLastCalledWith(0);
	});

	test("positionToValue returns min when no wrapper rect was captured (null-rect guard)", () => {
		// wrapperRef is null at pointer-down, so wrapperRectRef stays null. A drag
		// past the threshold then calls positionToValue with a null rect → returns
		// min (and the rubber branch is skipped because rect is falsy).
		const { args, onChange } = buildArgs({
			min: 7,
			max: 100,
			step: 1,
			wrapperRef: refOf<HTMLDivElement>(null),
		});
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 50 })));
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 90 })));
		expect(result.current.interaction.isDragging).toBe(true);
		expect(onChange).toHaveBeenLastCalledWith(7);
	});

	test("dragging inside the track bounds resets the rubber stretch (else branch)", () => {
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 10 })));
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 50 })));
		expect(result.current.rubberX.get()).toBe(0);
		expect(onChange).toHaveBeenLastCalledWith(50);
	});
});

describe("handlePointerUp — click-to-set", () => {
	test("ignores pointer-up when not interacting", () => {
		const { args, onChange } = buildArgs();
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerUp(pointerEvent("pointerup", { clientX: 50 })));
		expect(onChange).not.toHaveBeenCalled();
	});

	test("a click (no drag) on a coarse slider (≤10 steps) snaps to the raw rounded value", () => {
		// range/step = 100/10 = 10 ⇒ discreteSteps <= 10, so rawValue path (no decile snap).
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 10 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 30 })));
		act(() => result.current.handlePointerUp(pointerEvent("pointerup", { clientX: 30 })));
		expect(onChange).toHaveBeenLastCalledWith(30);
		expect(result.current.interaction.isInteracting).toBe(false);
	});

	test("a click on a fine slider (>10 steps) near a decile snaps to the decile", () => {
		// range/step = 100/1 = 100 > 10 ⇒ snapToDecile applies. clientX 31 → 31% ;
		// nearest decile is 30%, |0.31-0.30|=0.01 <= 0.03125 ⇒ snaps to 30.
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 31 })));
		act(() => result.current.handlePointerUp(pointerEvent("pointerup", { clientX: 31 })));
		expect(onChange).toHaveBeenLastCalledWith(30);
	});

	test("a click on a fine slider far from any decile keeps the raw value", () => {
		// clientX 35 → 35%; nearest decile 40% or 30%, |0.35-0.4|=0.05 > 0.03125 ⇒ no snap.
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 35 })));
		act(() => result.current.handlePointerUp(pointerEvent("pointerup", { clientX: 35 })));
		expect(onChange).toHaveBeenLastCalledWith(35);
	});

	test("a real drag-then-release does NOT re-emit a click value", () => {
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 10 })));
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 60 })));
		onChange.mockClear();
		act(() => result.current.handlePointerUp(pointerEvent("pointerup", { clientX: 60 })));
		// isClickRef was cleared by the drag, so pointerUp skips the click-set path.
		expect(onChange).not.toHaveBeenCalled();
		expect(result.current.interaction.isInteracting).toBe(false);
	});
});

describe("reduced-motion path", () => {
	function forceReducedMotion(): void {
		reducedMotionFlag = true;
	}

	test("a keyboard nudge under reduced motion jumps the fill (no spring) and still emits onChange", () => {
		forceReducedMotion();
		const { args, onChange } = buildArgs({ value: 5, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		expect(result.current.shouldReduceMotion).toBe(true);
		act(() => result.current.handleKeyDown(keyEvent("ArrowRight")));
		expect(onChange).toHaveBeenLastCalledWith(6);
	});

	test("a drag under reduced motion does not compute rubber stretch", () => {
		forceReducedMotion();
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 1 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 50 })));
		// Drag far past the right edge — but reduced motion skips the rubber branch.
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 400 })));
		expect(result.current.rubberX.get()).toBe(0);
		expect(onChange).toHaveBeenLastCalledWith(100);
	});

	test("click-release under reduced motion still emits the snapped value", () => {
		forceReducedMotion();
		const { args, onChange } = buildArgs({ min: 0, max: 100, step: 10 });
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 20 })));
		act(() => result.current.handlePointerUp(pointerEvent("pointerup", { clientX: 20 })));
		expect(onChange).toHaveBeenLastCalledWith(20);
	});
});

describe("rubber band stretch on drag past edges", () => {
	test("dragging past the right edge beyond the dead zone stretches positively", () => {
		const { args } = buildArgs(
			{ min: 0, max: 100, step: 1 },
			{ wrapper: { left: 0, right: 100, width: 100, offsetWidth: 100 } }
		);
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 50 })));
		// clientX 250 → distancePast = 250-100 = 150; overflow = 150-32 = 118 (>0)
		// ⇒ positive stretch. rubberX is 0 for positive stretch (only negative shifts x).
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: 250 })));
		// fillWidth includes the absolute stretch → > 100% width string.
		expect(result.current.rubberWidth.get()).not.toBe("calc(100% + 0px)");
		expect(result.current.rubberX.get()).toBe(0);
	});

	test("dragging past the left edge beyond the dead zone produces a negative rubberX shift", () => {
		const { args } = buildArgs(
			{ min: 0, max: 100, step: 1 },
			{ wrapper: { left: 0, right: 100, width: 100, offsetWidth: 100 } }
		);
		const { result } = renderHook(() => useSliderInteraction(args));
		act(() => result.current.handlePointerDown(pointerEvent("pointerdown", { clientX: 50 })));
		// clientX -200 → distancePast = left - clientX = 0 - (-200) = 200; overflow huge
		// ⇒ negative stretch ⇒ rubberX < 0.
		act(() => result.current.handlePointerMove(pointerEvent("pointermove", { clientX: -200 })));
		expect(result.current.rubberX.get()).toBeLessThan(0);
	});
});

describe("dodge measurement (ResizeObserver layout)", () => {
	test("computes dodge thresholds from label/value widths on mount", async () => {
		const { args } = buildArgs(
			{},
			{ wrapper: { left: 0, right: 200, width: 200, offsetWidth: 200 } }
		);
		const { result } = renderHook(() => useSliderInteraction(args));
		// useLayoutEffect runs synchronously after commit. label offsetWidth = 20:
		// left = (LABEL_OFFSET(16) + 20 + HANDLE_BUFFER(8)) / 200 * 100 = 22.
		expect(result.current.dodge.left).toBeCloseTo(22, 5);
		// right = (200 - VALUE_OFFSET(4) - 20 - 8) / 200 * 100 = 84.
		expect(result.current.dodge.right).toBeCloseTo(84, 5);
	});

	test("falls back to default dodge when the wrapper has zero width", () => {
		const { args } = buildArgs({}, { wrapper: { left: 0, right: 0, width: 0, offsetWidth: 0 } });
		const { result } = renderHook(() => useSliderInteraction(args));
		// trackWidth <= 0 ⇒ measure returns early, dodge stays at the seed default.
		expect(result.current.dodge).toEqual({ left: 38, right: 72 });
	});

	test("uses the 38/72 default when label and value refs are absent", () => {
		const { args } = buildArgs({
			labelRef: refOf<HTMLSpanElement>(null),
			valueRef: refOf<HTMLSpanElement>(null),
			wrapperRef: refOf<HTMLDivElement>(
				makeEl("div", { width: 200, offsetWidth: 200 }) as HTMLDivElement
			),
		});
		const { result } = renderHook(() => useSliderInteraction(args));
		expect(result.current.dodge).toEqual({ left: 38, right: 72 });
	});

	test("does not crash when the wrapper ref is null (early return)", () => {
		const { args } = buildArgs({ wrapperRef: refOf<HTMLDivElement>(null) });
		const { result } = renderHook(() => useSliderInteraction(args));
		// No wrapper ⇒ the layout effect returns early; dodge stays at the default.
		expect(result.current.dodge).toEqual({ left: 38, right: 72 });
	});
});
