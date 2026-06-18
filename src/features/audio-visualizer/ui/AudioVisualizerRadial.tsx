import { cva } from "class-variance-authority";
import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/shared/lib/cn";
import type { VisualizerSize } from "../lib/audio-visualizer";
import { useAgentState } from "../lib/use-agent-state";
import { useMultibandVolume } from "../lib/use-multiband-volume";
import { useRadialAnimator } from "../lib/use-radial-animator";
import {
	RADIAL_CONTAINER_HALF,
	resolveRadialBarCount,
	resolveRadialDistance,
	resolveRadialDistancePct,
	resolveRadialSequencerInterval,
} from "./AudioVisualizerRadial.helpers";

const radialVariants = cva(
	[
		// `aspect-square` reserves layout width equal to the height. Without it the
		// container collapses to 0 width (children are absolute-positioned only),
		// which causes dots to render outside the layout box and get clipped by
		// `overflow-hidden` ancestors like the recording overlay pill.
		"relative flex aspect-square items-center justify-center",
		"**:data-lk-index:bg-current/10",
		"**:data-lk-index:absolute **:data-lk-index:top-1/2 **:data-lk-index:left-1/2 **:data-lk-index:origin-bottom **:data-lk-index:-translate-x-1/2",
		"**:data-lk-index:data-[lk-highlighted=true]:bg-current **:data-lk-index:rounded-full **:data-lk-index:transition-colors **:data-lk-index:duration-150 **:data-lk-index:ease-linear",
		"has-data-[lk-state=connecting]:**:data-lk-index:duration-300",
		"has-data-[lk-state=initializing]:**:data-lk-index:duration-300",
		"has-data-[lk-state=listening]:**:data-lk-index:duration-300",
		"has-data-[lk-state=thinking]:animate-spin has-data-[lk-state=thinking]:**:data-lk-index:bg-current has-data-[lk-state=thinking]:[animation-duration:5s]",
	],
	{
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
	},
);

const emptyBandsCache = new Map<number, number[]>();

function emptyBands(count: number): number[] {
	const cached = emptyBandsCache.get(count);
	if (cached) {
		return cached;
	}
	const bands = new Array(count).fill(0);
	emptyBandsCache.set(count, bands);
	return bands;
}

export interface AudioVisualizerRadialProps {
	barCount?: number;
	className?: string;
	color?: `#${string}`;
	radius?: number;
	/**
	 * Ring radius as a percentage (20–90) of the visualizer's half-height.
	 * Size-relative so a single user setting stays sensible across the xs–xl
	 * overlay presets. Lower priority than the absolute `radius` prop, higher
	 * than the size-derived default.
	 */
	radiusPct?: number;
	size?: VisualizerSize;
}

// `radialVariants` (icon 24, sm 56, md 112, lg 224, xl 448) — keep in sync.
export function AudioVisualizerRadial({
	size = "md",
	color,
	radius,
	radiusPct,
	barCount,
	className,
	style,
	...props
}: AudioVisualizerRadialProps & ComponentProps<"div">) {
	const state = useAgentState();

	const _barCount = resolveRadialBarCount(barCount, size);

	const volumeBands = useMultibandVolume(_barCount);

	const sequencerInterval = resolveRadialSequencerInterval(state);

	// Priority: explicit absolute `radius` → size-relative `radiusPct` → size default.
	const distanceFromCenter = resolveRadialDistance(
		radius ?? resolveRadialDistancePct(radiusPct, size),
		size,
	);

	const highlightedIndices = useRadialAnimator(
		state,
		_barCount,
		sequencerInterval,
	);
	const bands = state === "speaking" ? volumeBands : emptyBands(_barCount);
	const allHighlighted = highlightedIndices.length >= _barCount;

	const dotSize = (distanceFromCenter * Math.PI) / _barCount;

	// Available space from the radial ring out to the container edge.
	const containerHalf = RADIAL_CONTAINER_HALF[size];
	const maxBarHeight = Math.max(0, containerHalf - distanceFromCenter);

	const minBarHeight = Math.min(dotSize, maxBarHeight);

	return (
		<div
			className={cn(radialVariants({ size }), "relative", className)}
			data-lk-state={state}
			style={{ ...style, color } as CSSProperties}
			{...props}
		>
			{bands.map((band, idx) => {
				const angle = (idx / _barCount) * Math.PI * 2;
				return (
					<div
						className="absolute top-1/2 left-1/2 size-1 -translate-x-1/2 -translate-y-1/2"
						data-lk-state={state}
						key={`radial-${_barCount}-angle-${angle.toFixed(4)}`}
						style={{
							transformOrigin: "center",
							transform: `rotate(${angle}rad) translateY(${distanceFromCenter}px)`,
						}}
					>
						<div
							data-lk-highlighted={
								allHighlighted || highlightedIndices.includes(idx)
							}
							data-lk-index={idx}
							style={{
								width: dotSize,
								minHeight: minBarHeight,
								height: state === "speaking" ? `${maxBarHeight * band}px` : 0,
							}}
						/>
					</div>
				);
			})}
		</div>
	);
}
