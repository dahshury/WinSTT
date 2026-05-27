import {
	animate,
	type MotionValue,
	useMotionValue,
	useReducedMotion,
	useTransform,
} from "motion/react";
import type React from "react";
import { type Dispatch, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

// Drag detection & rubber band
const CLICK_THRESHOLD = 3;
const DEAD_ZONE = 32;
const MAX_CURSOR_RANGE = 200;
const MAX_STRETCH = 8;

// Layout offsets used by the "handle dodges label/value" calculation.
const HANDLE_BUFFER = 8;
const LABEL_OFFSET = 12 + 4;
const VALUE_OFFSET = 12 - 8;

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

function decimalsForStep(step: number): number {
	const s = step.toString();
	const dot = s.indexOf(".");
	return dot === -1 ? 0 : s.length - dot - 1;
}

function roundValue(val: number, min: number, max: number, step: number): number {
	const snapped = min + Math.round((val - min) / step) * step;
	const bounded = clamp(snapped, min, max);
	return Number.parseFloat(bounded.toFixed(decimalsForStep(step)));
}

function snapToDecile(rawValue: number, min: number, max: number): number {
	const normalized = (rawValue - min) / (max - min);
	const nearest = Math.round(normalized * 10) / 10;
	if (Math.abs(normalized - nearest) <= 0.031_25) {
		return min + nearest * (max - min);
	}
	return rawValue;
}

export interface InteractionState {
	isDragging: boolean;
	isHovered: boolean;
	isInteracting: boolean;
	keyboardFocusRing: boolean;
}

export type InteractionAction =
	| { type: "pointerDown" }
	| { type: "dragStart" }
	| { type: "pointerUp" }
	| { type: "mouseEnter" }
	| { type: "mouseLeave" }
	| { type: "focusRingOn" }
	| { type: "focusRingOff" };

const INITIAL_INTERACTION: InteractionState = {
	isInteracting: false,
	isDragging: false,
	isHovered: false,
	keyboardFocusRing: false,
};

function interactionReducer(state: InteractionState, action: InteractionAction): InteractionState {
	switch (action.type) {
		case "pointerDown":
			return { ...state, isInteracting: true, keyboardFocusRing: false };
		case "dragStart":
			return state.isDragging ? state : { ...state, isDragging: true };
		case "pointerUp":
			return { ...state, isInteracting: false, isDragging: false };
		case "mouseEnter":
			return state.isHovered ? state : { ...state, isHovered: true };
		case "mouseLeave":
			return state.isHovered ? { ...state, isHovered: false } : state;
		case "focusRingOn":
			return state.keyboardFocusRing ? state : { ...state, keyboardFocusRing: true };
		case "focusRingOff":
			return state.keyboardFocusRing ? { ...state, keyboardFocusRing: false } : state;
		default:
			return state;
	}
}

export interface UseSliderInteractionArgs {
	disabled?: boolean | undefined;
	labelRef: React.RefObject<HTMLSpanElement | null>;
	max: number;
	min: number;
	onChange: (next: number) => void;
	step: number;
	trackRef: React.RefObject<HTMLDivElement | null>;
	value: number;
	valueRef: React.RefObject<HTMLSpanElement | null>;
	wrapperRef: React.RefObject<HTMLDivElement | null>;
}

export interface UseSliderInteractionResult {
	dispatchInteraction: Dispatch<InteractionAction>;
	dodge: { left: number; right: number };
	fillWidth: MotionValue<string>;
	handleKeyDown: (e: React.KeyboardEvent) => void;
	handleLeft: MotionValue<string>;
	handlePointerDown: (e: React.PointerEvent) => void;
	handlePointerMove: (e: React.PointerEvent) => void;
	handlePointerUp: (e: React.PointerEvent) => void;
	interaction: InteractionState;
	percentage: number;
	rubberWidth: MotionValue<string>;
	rubberX: MotionValue<number>;
	shouldReduceMotion: boolean | null;
	showKeyboardFocusRing: () => void;
}

export function useSliderInteraction({
	disabled,
	labelRef,
	max,
	min,
	onChange,
	step,
	trackRef,
	value,
	valueRef,
	wrapperRef,
}: UseSliderInteractionArgs): UseSliderInteractionResult {
	const shouldReduceMotion = useReducedMotion();

	const [interaction, dispatchInteraction] = useReducer(interactionReducer, INITIAL_INTERACTION);
	const { isInteracting } = interaction;

	const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
	const pendingPointerFocusRef = useRef(false);
	const isClickRef = useRef(true);
	const animRef = useRef<ReturnType<typeof animate> | null>(null);
	const wrapperRectRef = useRef<DOMRect | null>(null);
	const scaleRef = useRef(1);

	const range = max - min || 1;
	const percentage = ((value - min) / range) * 100;

	const fillPercent = useMotionValue(percentage);
	const fillWidth = useTransform(fillPercent, (pct) => `${pct}%`);
	const handleLeft = useTransform(fillPercent, (pct) => `max(4px, calc(${pct}% - 8px))`);

	const rubberStretch = useMotionValue(0);
	const rubberWidth = useTransform(rubberStretch, (s) => `calc(100% + ${Math.abs(s)}px)`);
	const rubberX = useTransform(rubberStretch, (s) => (s < 0 ? s : 0));

	useEffect(() => {
		if (!(isInteracting || animRef.current)) {
			fillPercent.jump(percentage);
		}
	}, [percentage, isInteracting, fillPercent]);

	function positionToValue(clientX: number): number {
		const rect = wrapperRectRef.current;
		if (!rect) {
			return min;
		}
		const sceneX = (clientX - rect.left) / scaleRef.current;
		const nativeWidth = wrapperRef.current?.offsetWidth ?? rect.width;
		const percent = clamp(sceneX / nativeWidth, 0, 1);
		return clamp(min + percent * range, min, max);
	}

	function percentFromValue(v: number): number {
		return ((v - min) / range) * 100;
	}

	function animateFillTo(targetPercent: number): void {
		animRef.current?.stop();
		if (shouldReduceMotion) {
			fillPercent.jump(targetPercent);
			animRef.current = null;
			return;
		}
		animRef.current = animate(fillPercent, targetPercent, {
			type: "spring",
			stiffness: 300,
			damping: 25,
			mass: 0.8,
			onComplete: () => {
				animRef.current = null;
			},
		});
	}

	function computeRubberStretch(clientX: number, sign: number): number {
		const rect = wrapperRectRef.current;
		if (!rect) {
			return 0;
		}
		const distancePast = sign < 0 ? rect.left - clientX : clientX - rect.right;
		const overflow = Math.max(0, distancePast - DEAD_ZONE);
		return sign * MAX_STRETCH * Math.sqrt(Math.min(overflow / MAX_CURSOR_RANGE, 1));
	}

	function handlePointerDown(e: React.PointerEvent): void {
		if (disabled) {
			return;
		}
		e.preventDefault();
		(e.target as HTMLElement).setPointerCapture(e.pointerId);

		pointerDownPos.current = { x: e.clientX, y: e.clientY };
		isClickRef.current = true;
		dispatchInteraction({ type: "pointerDown" });
		pendingPointerFocusRef.current = true;

		trackRef.current?.focus({ preventScroll: true });
		requestAnimationFrame(() => {
			pendingPointerFocusRef.current = false;
		});

		const wrapper = wrapperRef.current;
		if (wrapper) {
			const rect = wrapper.getBoundingClientRect();
			wrapperRectRef.current = rect;
			scaleRef.current = rect.width / wrapper.offsetWidth;
		}
	}

	function handlePointerMove(e: React.PointerEvent): void {
		if (!(isInteracting && pointerDownPos.current)) {
			return;
		}
		const dx = e.clientX - pointerDownPos.current.x;
		const dy = e.clientY - pointerDownPos.current.y;

		if (isClickRef.current && Math.hypot(dx, dy) > CLICK_THRESHOLD) {
			isClickRef.current = false;
			dispatchInteraction({ type: "dragStart" });
		}

		if (isClickRef.current) {
			return;
		}

		const rect = wrapperRectRef.current;
		if (rect && !shouldReduceMotion) {
			if (e.clientX < rect.left) {
				rubberStretch.jump(computeRubberStretch(e.clientX, -1));
			} else if (e.clientX > rect.right) {
				rubberStretch.jump(computeRubberStretch(e.clientX, 1));
			} else {
				rubberStretch.jump(0);
			}
		}

		const newValue = positionToValue(e.clientX);
		animRef.current?.stop();
		animRef.current = null;
		fillPercent.jump(percentFromValue(newValue));
		onChange(roundValue(newValue, min, max, step));
	}

	function handlePointerUp(e: React.PointerEvent): void {
		if (!isInteracting) {
			return;
		}
		if (isClickRef.current) {
			const rawValue = positionToValue(e.clientX);
			const discreteSteps = range / step;
			const target = discreteSteps <= 10 ? rawValue : snapToDecile(rawValue, min, max);
			const snapped = roundValue(target, min, max, step);
			animateFillTo(percentFromValue(snapped));
			onChange(snapped);
		}
		if (!shouldReduceMotion && rubberStretch.get() !== 0) {
			animate(rubberStretch, 0, { type: "spring", visualDuration: 0.35, bounce: 0.15 });
		}
		dispatchInteraction({ type: "pointerUp" });
		pointerDownPos.current = null;
	}

	function showKeyboardFocusRing(): void {
		// Skip flagging this as a "keyboard focus" if focus came from a
		// pointer-down that we synthetically forwarded into the track (the
		// pointer-down handler sets pendingPointerFocusRef for one frame).
		if (!pendingPointerFocusRef.current) {
			dispatchInteraction({ type: "focusRingOn" });
		}
	}

	function handleKeyDown(e: React.KeyboardEvent): void {
		if (disabled) {
			return;
		}
		const arrowStep = e.shiftKey ? step * 10 : step;
		let next: number | null = null;
		switch (e.key) {
			case "ArrowRight":
			case "ArrowUp":
				next = value + arrowStep;
				break;
			case "ArrowLeft":
			case "ArrowDown":
				next = value - arrowStep;
				break;
			case "Home":
				next = min;
				break;
			case "End":
				next = max;
				break;
			default:
				return;
		}
		e.preventDefault();
		dispatchInteraction({ type: "focusRingOn" });
		const snapped = roundValue(next, min, max, step);
		animateFillTo(percentFromValue(snapped));
		onChange(snapped);
	}

	// Measure label + value to derive "dodge" thresholds so the handle fades
	// when it would overlap either text.
	const [dodge, setDodge] = useState({ left: 38, right: 72 });
	useLayoutEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) {
			return;
		}
		const measure = () => {
			const trackWidth = wrapper.offsetWidth;
			if (trackWidth <= 0) {
				return;
			}
			const labelEl = labelRef.current;
			const valueEl = valueRef.current;
			const left = labelEl
				? ((LABEL_OFFSET + labelEl.offsetWidth + HANDLE_BUFFER) / trackWidth) * 100
				: 38;
			const right = valueEl
				? ((trackWidth - VALUE_OFFSET - valueEl.offsetWidth - HANDLE_BUFFER) / trackWidth) * 100
				: 72;
			setDodge((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(wrapper);
		if (labelRef.current) {
			observer.observe(labelRef.current);
		}
		if (valueRef.current) {
			observer.observe(valueRef.current);
		}
		return () => observer.disconnect();
	}, [wrapperRef, labelRef, valueRef]);

	return {
		dispatchInteraction,
		dodge,
		fillWidth,
		showKeyboardFocusRing,
		handleKeyDown,
		handleLeft,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		interaction,
		percentage,
		rubberWidth,
		rubberX,
		shouldReduceMotion,
	};
}

export { decimalsForStep };
