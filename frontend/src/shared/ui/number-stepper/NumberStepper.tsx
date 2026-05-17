"use client";

import { NumberField } from "@base-ui/react/number-field";
import { surfaceClasses, surfaceHoverBg, useSurface } from "@/shared/lib/surface";

export interface NumberStepperProps {
	disabled?: boolean;
	max?: number;
	min?: number;
	onChange: (value: number) => void;
	smallStep?: number;
	step?: number;
	value: number;
}

export function NumberStepper({
	value,
	onChange,
	min,
	max,
	step = 1,
	smallStep,
	disabled,
}: NumberStepperProps) {
	const substrate = useSurface();
	const buttonLevel = Math.min(substrate + 1, 8);
	const hoverLevel = Math.min(buttonLevel + 1, 8);
	return (
		<NumberField.Root
			disabled={disabled}
			max={max}
			min={min}
			onValueChange={(v) => {
				if (v !== null) {
					onChange(v);
				}
			}}
			smallStep={smallStep}
			step={step}
			value={value}
		>
			<NumberField.Group className="inline-flex rounded-md focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-1 focus-within:ring-offset-surface-1">
				<NumberField.Decrement
					className={`flex size-8 cursor-pointer select-none items-center justify-center rounded-r-none rounded-l-md ${surfaceClasses(buttonLevel)} p-0 text-foreground-secondary outline-none ${surfaceHoverBg(hoverLevel)}`}
				>
					<MinusIcon />
				</NumberField.Decrement>
				<NumberField.Input className="h-8 w-[60px] border-border border-x-0 border-y bg-transparent text-center font-mono text-body text-foreground tabular-nums caret-accent outline-none" />
				<NumberField.Increment
					className={`flex size-8 cursor-pointer select-none items-center justify-center rounded-r-md rounded-l-none ${surfaceClasses(buttonLevel)} p-0 text-foreground-secondary outline-none ${surfaceHoverBg(hoverLevel)}`}
				>
					<PlusIcon />
				</NumberField.Increment>
			</NumberField.Group>
		</NumberField.Root>
	);
}

function PlusIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="10"
			stroke="currentColor"
			strokeWidth="1.6"
			viewBox="0 0 10 10"
			width="10"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M0 5H5M10 5H5M5 5V0M5 5V10" />
		</svg>
	);
}

function MinusIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="10"
			stroke="currentColor"
			strokeWidth="1.6"
			viewBox="0 0 10 10"
			width="10"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M0 5H10" />
		</svg>
	);
}
