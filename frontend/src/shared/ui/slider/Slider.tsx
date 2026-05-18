"use client";

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

export type SliderVariant = "pips" | "scrubber";

export interface SliderProps {
	"aria-label"?: string;
	className?: string;
	disabled?: boolean;
	formatValue?: (v: number) => string;
	label?: string;
	max: number;
	min: number;
	onChange: (value: number) => void;
	step: number;
	value: number;
	variant?: SliderVariant;
}

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

function roundValue(val: number, step: number): number {
	const raw = Math.round(val / step) * step;
	return Number.parseFloat(raw.toFixed(decimalsForStep(step)));
}

// Magnetic snap to the nearest decile when within 3.125% of it.
function snapToDecile(rawValue: number, min: number, max: number): number {
	const normalized = (rawValue - min) / (max - min);
	const nearest = Math.round(normalized * 10) / 10;
	if (Math.abs(normalized - nearest) <= 0.031_25) {
		return min + nearest * (max - min);
	}
	return rawValue;
}

function computeHandleOpacity(isActive: boolean, valueDodge: boolean, isDragging: boolean): number {
	if (!isActive) {
		return 0;
	}
	if (valueDodge) {
		return 0.1;
	}
	return isDragging ? 0.8 : 0.5;
}

export function Slider({
	"aria-label": ariaLabel,
	className,
	disabled,
	formatValue,
	label,
	max,
	min,
	onChange,
	step,
	value,
}: SliderProps) {
	const substrate = useSurface();
	// Lift two levels above the surrounding substrate so the track stays
	// distinct against ElevatedSurface-wrapped controls (which already sit one
	// step above their section). One-step lift was too subtle on dark theme.
	const trackLevel = Math.min(substrate + 2, 8);
	const trackBgClass = surfaceBg(trackLevel);

	const shouldReduceMotion = useReducedMotion();

	const wrapperRef = useRef<HTMLDivElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const labelRef = useRef<HTMLSpanElement>(null);
	const valueRef = useRef<HTMLSpanElement>(null);

	const [isInteracting, setIsInteracting] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [isHovered, setIsHovered] = useState(false);
	// Ring only for Tab focus or keyboard value nudges, not pointer press/drag.
	const [keyboardFocusRing, setKeyboardFocusRing] = useState(false);

	// Pointer session state — mutable, does not trigger re-renders.
	const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
	const pendingPointerFocusRef = useRef(false);
	const isClickRef = useRef(true);
	const animRef = useRef<ReturnType<typeof animate> | null>(null);
	const wrapperRectRef = useRef<DOMRect | null>(null);
	const scaleRef = useRef(1);

	const range = max - min || 1;
	const percentage = ((value - min) / range) * 100;
	const isActive = isInteracting || isHovered;
	const displayValue = formatValue ? formatValue(value) : value.toFixed(decimalsForStep(step));

	// Fill + handle driven by a single motion value for imperative updates.
	const fillPercent = useMotionValue(percentage);
	const fillWidth = useTransform(fillPercent, (pct) => `${pct}%`);
	const handleLeft = useTransform(fillPercent, (pct) => `max(4px, calc(${pct}% - 8px))`);

	// Rubber band: widens the track and pulls it left when dragged past bounds.
	const rubberStretch = useMotionValue(0);
	const rubberWidth = useTransform(rubberStretch, (s) => `calc(100% + ${Math.abs(s)}px)`);
	const rubberX = useTransform(rubberStretch, (s) => (s < 0 ? s : 0));

	// Sync from props when not interacting and no spring is in flight.
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

	// Animate fill to a target percent, or jump instantly when the user prefers
	// reduced motion. Position still updates — only the spring is skipped.
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
		setIsInteracting(true);
		pendingPointerFocusRef.current = true;
		setKeyboardFocusRing(false);

		// Pointer interactions should move focus to the slider so subsequent
		// keyboard input is received and focus styles match the active state.
		trackRef.current?.focus({ preventScroll: true });
		requestAnimationFrame(() => {
			pendingPointerFocusRef.current = false;
		});

		// Snapshot the wrapper rect so later math is immune to layout shifts.
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
			setIsDragging(true);
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
		onChange(roundValue(newValue, step));
	}

	function handlePointerUp(e: React.PointerEvent): void {
		if (!isInteracting) {
			return;
		}
		if (isClickRef.current) {
			// Coarse sliders (≤10 positions) snap to the nearest step;
			// continuous sliders keep the decile-magnetic behavior.
			const rawValue = positionToValue(e.clientX);
			const discreteSteps = range / step;
			const snapped =
				discreteSteps <= 10
					? clamp(min + Math.round((rawValue - min) / step) * step, min, max)
					: snapToDecile(rawValue, min, max);
			animateFillTo(percentFromValue(snapped));
			onChange(roundValue(snapped, step));
		}
		if (!shouldReduceMotion && rubberStretch.get() !== 0) {
			animate(rubberStretch, 0, { type: "spring", visualDuration: 0.35, bounce: 0.15 });
		}
		setIsInteracting(false);
		setIsDragging(false);
		pointerDownPos.current = null;
	}

	function handleKeyDown(e: React.KeyboardEvent): void {
		if (disabled) {
			return;
		}
		// Shift + Arrow is a Figma-style fast nudge: jumps by 10x the step.
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
		setKeyboardFocusRing(true);
		const snapped = roundValue(clamp(next, min, max), step);
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
	}, []);

	const valueDodge = percentage < dodge.left || percentage > dodge.right;
	const handleOpacity = computeHandleOpacity(isActive, valueDodge, isDragging);

	const discreteSteps = range / step;
	const hashMarkCount = discreteSteps <= 10 ? Math.max(0, Math.round(discreteSteps) - 1) : 9;
	const hashMarkPct = (i: number) =>
		discreteSteps <= 10 ? (((i + 1) * step) / range) * 100 : (i + 1) * 10;

	return (
		<div
			className={cn("relative h-9 w-full", disabled && "pointer-events-none opacity-50", className)}
			data-slot="elastic-slider"
			ref={wrapperRef}
		>
			<motion.div
				aria-disabled={disabled || undefined}
				aria-label={ariaLabel ?? label}
				aria-orientation="horizontal"
				aria-valuemax={max}
				aria-valuemin={min}
				aria-valuenow={value}
				aria-valuetext={displayValue}
				className={cn(
					"group/elastic-slider absolute inset-0 cursor-pointer touch-none select-none overflow-hidden rounded-lg outline-none",
					trackBgClass,
					"data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-accent/50 data-[focus-visible=true]:ring-offset-1 data-[focus-visible=true]:ring-offset-bg-base"
				)}
				data-active={isActive}
				data-focus-visible={keyboardFocusRing}
				data-slot="elastic-slider-track"
				onBlur={() => setKeyboardFocusRing(false)}
				onFocus={() => {
					if (!pendingPointerFocusRef.current) {
						setKeyboardFocusRing(true);
					}
				}}
				onKeyDown={handleKeyDown}
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={() => setIsHovered(false)}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				ref={trackRef}
				role="slider"
				style={{ width: rubberWidth, x: rubberX }}
				tabIndex={disabled ? -1 : 0}
			>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0"
					data-slot="elastic-slider-hash-marks"
				>
					{Array.from({ length: hashMarkCount }, (_, i) => {
						const pct = hashMarkPct(i);
						return (
							<div
								className={cn(
									"absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200",
									"bg-transparent group-data-[active=true]/elastic-slider:bg-foreground/40"
								)}
								key={`hash-${pct}`}
								style={{ left: `${pct}%` }}
							/>
						);
					})}
				</div>

				<motion.div
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute inset-y-0 left-0 transition-colors",
						"bg-foreground/15 group-data-[active=true]/elastic-slider:bg-foreground/25"
					)}
					data-slot="elastic-slider-fill"
					style={{ width: fillWidth }}
				/>

				<motion.div
					animate={{
						opacity: handleOpacity,
						scaleX: isActive ? 1 : 0.25,
						scaleY: isActive && valueDodge ? 0.75 : 1,
					}}
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 h-5 w-1 rounded-full bg-foreground"
					data-slot="elastic-slider-handle"
					style={{ left: handleLeft, y: "-50%" }}
					transition={
						shouldReduceMotion
							? { duration: 0 }
							: {
									scaleX: { type: "spring", visualDuration: 0.25, bounce: 0.15 },
									scaleY: { type: "spring", visualDuration: 0.2, bounce: 0.1 },
									opacity: { duration: 0.15 },
								}
					}
				/>

				{label ? (
					<span
						aria-hidden="true"
						className={cn(
							"pointer-events-none absolute top-1/2 left-3 inline-flex -translate-y-1/2 items-center font-medium text-sm/none transition-colors duration-100",
							"text-foreground-secondary group-data-[active=true]/elastic-slider:text-foreground"
						)}
						data-slot="elastic-slider-label"
						ref={labelRef}
					>
						{label}
					</span>
				) : null}

				<span
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-medium font-mono text-sm/none tabular-nums transition-colors duration-100",
						"text-foreground-secondary group-data-[active=true]/elastic-slider:text-foreground"
					)}
					data-slot="elastic-slider-value"
					ref={valueRef}
				>
					{displayValue}
				</span>
			</motion.div>
		</div>
	);
}
