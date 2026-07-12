import { NumberField } from "@base-ui/react/number-field";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import {
	surfaceBg,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";

export interface NumberStepperProps {
	/**
	 * Opt into an accessible announcement when a value change lands on the
	 * `min`/`max` bound (base-ui clamps step interactions and blurred text
	 * silently). Off by default so the many existing consumers are unaffected;
	 * enable it where the clamp would otherwise be invisible. Announcement text
	 * comes from `minClampLabel`/`maxClampLabel` (caller-localized).
	 */
	announceClamp?: boolean;
	disabled?: boolean;
	max?: number;
	/** Localized announcement when the value is pinned to `max`. */
	maxClampLabel?: string;
	min?: number;
	/** Localized announcement when the value is pinned to `min`. */
	minClampLabel?: string;
	onChange: (value: number) => void;
	scrubbable?: boolean;
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
	scrubbable = false,
	announceClamp = false,
	minClampLabel = "Minimum value reached",
	maxClampLabel = "Maximum value reached",
}: NumberStepperProps) {
	// Announcement text for the last boundary the value landed on. Only tracked
	// (and only re-rendered as an sr-only aria-live region) when `announceClamp`
	// is opted into, so default consumers pay nothing.
	const [clampMessage, setClampMessage] = useState("");
	// Self-elevates +1 above the host panel; callers render a bare <NumberStepper/>.
	// The group paints the surface (shown through the transparent center input) and
	// the +/- buttons sit one step above.
	const substrate = Math.min(useSurface() + 1, 8);
	const buttonLevel = Math.min(substrate + 1, 8);
	const hoverLevel = Math.min(buttonLevel + 1, 8);
	const inputClassName = cn(
		"number-stepper-value h-8 w-[60px] border-border border-x-0 border-y bg-transparent text-center font-mono text-body text-foreground tabular-nums caret-accent outline-none",
		scrubbable && "cursor-ew-resize select-none [touch-action:none]",
	);
	const input = <NumberField.Input className={inputClassName} />;

	return (
		<NumberField.Root
			disabled={disabled}
			max={max}
			min={min}
			onValueChange={(v) => {
				if (v !== null) {
					onChange(v);
				}
				if (announceClamp && v !== null) {
					// base-ui has already clamped `v` into [min, max]; announce when it
					// sits exactly on a defined bound so a trimmed overshoot isn't silent.
					if (max !== undefined && v >= max) {
						setClampMessage(maxClampLabel);
					} else if (min !== undefined && v <= min) {
						setClampMessage(minClampLabel);
					} else {
						setClampMessage("");
					}
				}
			}}
			smallStep={smallStep}
			step={step}
			value={value}
		>
			<NumberField.Group
				className={`inline-flex rounded-lg ${surfaceBg(substrate)} shadow-elevated ring-1 ring-divider focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-1 focus-within:ring-offset-surface-1`}
			>
				<NumberField.Decrement
					className={`flex size-8 cursor-pointer select-none items-center justify-center rounded-r-none rounded-l-lg ${surfaceClasses(buttonLevel)} p-0 text-foreground-secondary outline-none ${surfaceHoverBg(hoverLevel)}`}
				>
					<MinusIcon />
				</NumberField.Decrement>
				{scrubbable ? (
					<NumberField.ScrubArea
						className="number-stepper-scrub-area cursor-ew-resize select-none [touch-action:none]"
						pixelSensitivity={3}
					>
						{input}
					</NumberField.ScrubArea>
				) : (
					input
				)}
				<NumberField.Increment
					className={`flex size-8 cursor-pointer select-none items-center justify-center rounded-r-lg rounded-l-none ${surfaceClasses(buttonLevel)} p-0 text-foreground-secondary outline-none ${surfaceHoverBg(hoverLevel)}`}
				>
					<PlusIcon />
				</NumberField.Increment>
			</NumberField.Group>
			{announceClamp ? (
				<span aria-live="polite" className="sr-only" role="status">
					{clampMessage}
				</span>
			) : null}
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
