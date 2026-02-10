"use client";

import { Slider as BaseSlider } from "@base-ui/react/slider";

export interface SliderProps {
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	step: number;
	disabled?: boolean;
	"aria-label"?: string;
}

export function Slider({
	value,
	onChange,
	min,
	max,
	step,
	disabled,
	"aria-label": ariaLabel,
}: SliderProps) {
	return (
		<BaseSlider.Root
			aria-label={ariaLabel}
			className="min-w-0 flex-1"
			disabled={disabled}
			max={max}
			min={min}
			onValueChange={(v) => onChange(v as number)}
			step={step}
			value={value}
		>
			<BaseSlider.Control className="flex w-full touch-none select-none items-center py-2">
				<BaseSlider.Track className="relative h-1 w-full select-none rounded-sm bg-surface-tertiary">
					<BaseSlider.Indicator className="absolute h-full rounded-sm bg-teal" />
					<BaseSlider.Thumb className="absolute size-3.5 cursor-pointer select-none rounded-full bg-foreground outline-1 outline-border focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface" />
				</BaseSlider.Track>
			</BaseSlider.Control>
		</BaseSlider.Root>
	);
}
