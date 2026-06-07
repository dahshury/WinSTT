import { cva } from "class-variance-authority";
import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/shared/lib/cn";
import type { AgentState, VisualizerSize } from "../lib/audio-visualizer";
import { useAgentState } from "../lib/use-agent-state";
import { useBarAnimator } from "../lib/use-bar-animator";
import { useMultibandVolume } from "../lib/use-multiband-volume";

const barElementVariants = cva(
	[
		"rounded-full transition-colors duration-250 ease-linear",
		"bg-current/10 data-[lk-highlighted=true]:bg-current",
	],
	{
		variants: {
			size: {
				icon: "min-h-[4px] w-[4px]",
				sm: "min-h-[8px] w-[8px]",
				md: "min-h-[16px] w-[16px]",
				lg: "min-h-[32px] w-[32px]",
				xl: "min-h-[64px] w-[64px]",
			},
		},
		defaultVariants: { size: "md" },
	},
);

const barContainerVariants = cva("relative flex items-center justify-center", {
	variants: {
		size: {
			icon: "h-[24px] gap-[2px]",
			sm: "h-[56px] gap-[4px]",
			md: "h-[112px] gap-[8px]",
			lg: "h-[224px] gap-[16px]",
			xl: "h-[448px] gap-[32px]",
		},
	},
	defaultVariants: { size: "md" },
});

export interface AudioVisualizerBarProps {
	barCount?: number | undefined;
	className?: string | undefined;
	color?: `#${string}` | undefined;
	size?: VisualizerSize | undefined;
}

export function resolveBarCount(
	barCount: number | undefined,
	size: VisualizerSize,
): number {
	if (barCount) {
		return barCount;
	}
	if (size === "icon") {
		return 5;
	}
	if (size === "sm") {
		return 7;
	}
	return 9;
}

const BAR_SEQUENCER_INTERVAL: Partial<
	Record<AgentState, number | ((barCount: number) => number)>
> = {
	connecting: (barCount: number) => 2000 / barCount,
	initializing: 2000,
	listening: 500,
	thinking: 150,
};

export function resolveBarSequencerInterval(
	state: AgentState,
	barCount: number,
): number {
	const entry = BAR_SEQUENCER_INTERVAL[state];
	if (entry === undefined) {
		return 1000;
	}
	return typeof entry === "function" ? entry(barCount) : entry;
}

export function AudioVisualizerBar({
	size = "md",
	color,
	barCount,
	className,
	style,
	...props
}: AudioVisualizerBarProps & ComponentProps<"div">) {
	const state = useAgentState();

	const _barCount = resolveBarCount(barCount, size);

	const volumeBands = useMultibandVolume(_barCount);

	const sequencerInterval = resolveBarSequencerInterval(state, _barCount);

	const highlightedIndices = useBarAnimator(
		state,
		_barCount,
		sequencerInterval,
	);
	const bands =
		state === "speaking" ? volumeBands : new Array(_barCount).fill(0);
	const barIds = Array.from(
		{ length: _barCount },
		(_, i) => `bar-${_barCount}-${i}`,
	);

	return (
		<div
			className={cn(barContainerVariants({ size }), className)}
			data-lk-state={state}
			style={{ ...style, color } as CSSProperties}
			{...props}
		>
			{barIds.map((id, position) => {
				const band = bands[position] ?? 0;
				return (
					<div
						className={cn(barElementVariants({ size }))}
						data-lk-highlighted={highlightedIndices.includes(position)}
						data-lk-index={position}
						key={id}
						style={{ height: `${band * 100}%` }}
					/>
				);
			})}
		</div>
	);
}
