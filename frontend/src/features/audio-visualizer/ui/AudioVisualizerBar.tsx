"use client";

import { cva } from "class-variance-authority";
import { type ComponentProps, type CSSProperties, useMemo } from "react";
import { cn } from "@/shared/lib/cn";
import type { VisualizerSize } from "../lib/audio-visualizer";
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
	}
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
	size?: VisualizerSize;
	color?: `#${string}`;
	barCount?: number;
	className?: string;
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

	const _barCount = useMemo(() => {
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
	}, [barCount, size]);

	const volumeBands = useMultibandVolume(_barCount);

	const sequencerInterval = useMemo(() => {
		switch (state) {
			case "connecting":
				return 2000 / _barCount;
			case "initializing":
				return 2000;
			case "listening":
				return 500;
			case "thinking":
				return 150;
			default:
				return 1000;
		}
	}, [state, _barCount]);

	const highlightedIndices = useBarAnimator(state, _barCount, sequencerInterval);
	const bands = useMemo(
		() => (state === "speaking" ? volumeBands : new Array(_barCount).fill(0)),
		[state, volumeBands, _barCount]
	);

	return (
		<div
			className={cn(barContainerVariants({ size }), className)}
			data-lk-state={state}
			style={{ ...style, color } as CSSProperties}
			{...props}
		>
			{bands.map((band: number, idx: number) => (
				<div
					className={cn(barElementVariants({ size }))}
					data-lk-highlighted={highlightedIndices.includes(idx)}
					data-lk-index={idx}
					key={idx}
					style={{ height: `${band * 100}%` }}
				/>
			))}
		</div>
	);
}
