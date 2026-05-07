"use client";

import { memo, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import type { VisualizerSize, VisualizerType } from "../lib/audio-visualizer";
import { useFitSize } from "../lib/use-fit-size";
import { AudioVisualizerAura } from "./AudioVisualizerAura";
import { AudioVisualizerBar } from "./AudioVisualizerBar";
import { AudioVisualizerGrid } from "./AudioVisualizerGrid";
import { AudioVisualizerRadial } from "./AudioVisualizerRadial";
import { AudioVisualizerWave } from "./AudioVisualizerWave";

interface AudioVisualizerProps {
	/**
	 * Fixed size variant or `"auto"` to pick the largest variant that fits the
	 * available space (measured via ResizeObserver on a wrapping div).
	 */
	size?: VisualizerSize | "auto";
	className?: string;
}

/**
 * Renders the visualizer selected in settings.
 * Defaults to "bar" if no setting is configured.
 */
export const AudioVisualizer = memo(function AudioVisualizer({
	size = "lg",
	className,
}: AudioVisualizerProps) {
	const visualizerType: VisualizerType = useSettingsStore(
		(s) => s.settings.general?.visualizerType ?? "bar"
	);
	const barCount = useSettingsStore((s) => s.settings.general?.visualizerBarCount);
	const rawColor = useSettingsStore((s) => s.settings.general?.visualizerColor);
	const visualizerColor: `#${string}` | undefined = rawColor?.startsWith("#")
		? (rawColor as `#${string}`)
		: undefined;

	if (size === "auto") {
		return (
			<AutoSizedVisualizer
				barCount={barCount}
				className={className}
				color={visualizerColor}
				type={visualizerType}
			/>
		);
	}

	return renderVariant(visualizerType, { size, className, color: visualizerColor, barCount });
});

interface AutoSizedVisualizerProps {
	type: VisualizerType;
	className?: string;
	color?: `#${string}`;
	barCount?: number;
}

function AutoSizedVisualizer({ type, className, color, barCount }: AutoSizedVisualizerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const fitSize = useFitSize(containerRef);

	return (
		<div className="flex h-full w-full items-center justify-center" ref={containerRef}>
			{renderVariant(type, { size: fitSize, className, color, barCount })}
		</div>
	);
}

interface VariantProps {
	size: VisualizerSize;
	className?: string;
	color?: `#${string}`;
	barCount?: number;
}

function renderVariant(type: VisualizerType, props: VariantProps) {
	const { barCount, ...common } = props;
	switch (type) {
		case "grid":
			return <AudioVisualizerGrid {...common} />;
		case "radial":
			return <AudioVisualizerRadial {...common} />;
		case "wave":
			return <AudioVisualizerWave {...common} />;
		case "aura":
			return <AudioVisualizerAura {...common} />;
		default:
			return <AudioVisualizerBar {...common} barCount={barCount} />;
	}
}
