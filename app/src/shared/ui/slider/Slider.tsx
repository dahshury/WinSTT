import { domAnimation, LazyMotion, m as motion } from "motion/react";
import { useRef } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { SliderFillBar } from "./SliderFillBar";
import { SliderHandle } from "./SliderHandle";
import { SliderHashMarks } from "./SliderHashMarks";
import { decimalsForStep, useSliderInteraction } from "./use-slider-interaction";

type SliderVariant = "pips" | "scrubber";

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

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
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
	value: rawValue,
}: SliderProps) {
	// Clamp the incoming value so a stale persisted out-of-range number (e.g. a
	// pre-fix `22` from when the snap grid was zero-anchored) renders as `max`
	// instead of overflowing the track and displaying an unreachable number.
	const value = clamp(rawValue, min, max);
	const substrate = useSurface();
	// Lift two levels above the surrounding substrate so the track stays
	// distinct against ElevatedSurface-wrapped controls (which already sit one
	// step above their section). One-step lift was too subtle on dark theme.
	const trackLevel = Math.min(substrate + 2, 8);
	const trackBgClass = surfaceBg(trackLevel);

	const wrapperRef = useRef<HTMLDivElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const labelRef = useRef<HTMLSpanElement>(null);
	const valueRef = useRef<HTMLSpanElement>(null);

	const {
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
	} = useSliderInteraction({
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
	});

	const { isInteracting, isDragging, isHovered, keyboardFocusRing } = interaction;
	const isActive = isInteracting || isHovered;
	const displayValue = formatValue ? formatValue(value) : value.toFixed(decimalsForStep(step));

	const valueDodge = percentage < dodge.left || percentage > dodge.right;
	const handleOpacity = computeHandleOpacity(isActive, valueDodge, isDragging);

	const range = max - min || 1;
	const discreteSteps = range / step;
	const hashMarkCount = discreteSteps <= 10 ? Math.max(0, Math.round(discreteSteps) - 1) : 9;
	const hashMarkPct = (i: number) =>
		discreteSteps <= 10 ? (((i + 1) * step) / range) * 100 : (i + 1) * 10;

	return (
		<LazyMotion features={domAnimation} strict>
			<div
				className={cn(
					"relative h-9 w-full",
					disabled && "pointer-events-none opacity-50",
					className
				)}
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
					onBlur={() => dispatchInteraction({ type: "focusRingOff" })}
					onFocus={showKeyboardFocusRing}
					onKeyDown={handleKeyDown}
					onMouseEnter={() => dispatchInteraction({ type: "mouseEnter" })}
					onMouseLeave={() => dispatchInteraction({ type: "mouseLeave" })}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					ref={trackRef}
					role="slider"
					style={{ width: rubberWidth, x: rubberX }}
					tabIndex={disabled ? -1 : 0}
				>
					<SliderHashMarks count={hashMarkCount} pctFor={hashMarkPct} />
					<SliderFillBar fillWidth={fillWidth} />
					<SliderHandle
						handleLeft={handleLeft}
						isActive={isActive}
						isDragging={isDragging}
						opacity={handleOpacity}
						shouldReduceMotion={shouldReduceMotion}
						valueDodge={valueDodge}
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
		</LazyMotion>
	);
}
