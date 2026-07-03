import { NumberField } from "@base-ui/react/number-field";
import { cn } from "@/shared/lib/cn";
import {
	surfaceBg,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";

export interface NumberStepperProps {
	disabled?: boolean;
	max?: number;
	min?: number;
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
}: NumberStepperProps) {
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
