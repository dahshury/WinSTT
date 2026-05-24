import type React from "react";
import { memo, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import { RECORDING_MODE_COLOR_HEX, type RecordingMode } from "@/shared/config/recording-mode-color";
import type { VisualizerSize, VisualizerType } from "../lib/audio-visualizer";
import { useFitSize } from "../lib/use-fit-size";
import { AudioVisualizerAura } from "./AudioVisualizerAura";
import { AudioVisualizerBar } from "./AudioVisualizerBar";
import { AudioVisualizerGrid } from "./AudioVisualizerGrid";
import { AudioVisualizerRadial } from "./AudioVisualizerRadial";
import { AudioVisualizerWave } from "./AudioVisualizerWave";

interface AudioVisualizerProps {
	className?: string;
	/**
	 * Fixed size variant or `"auto"` to pick the largest variant that fits the
	 * available space (measured via ResizeObserver on a wrapping div).
	 */
	size?: VisualizerSize | "auto";
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
	const recordingMode = useSettingsStore(
		(s) => (s.settings.general?.recordingMode ?? "ptt") as RecordingMode
	);
	const color = RECORDING_MODE_COLOR_HEX[recordingMode] as `#${string}`;

	if (size === "auto") {
		return (
			<AutoSizedVisualizer
				barCount={barCount}
				className={className}
				color={color}
				type={visualizerType}
			/>
		);
	}

	return (
		<VisualizerVariant
			barCount={barCount}
			className={className}
			color={color}
			size={size}
			type={visualizerType}
		/>
	);
});

interface AutoSizedVisualizerProps {
	barCount?: number | undefined;
	className?: string | undefined;
	color?: `#${string}` | undefined;
	type: VisualizerType;
}

function AutoSizedVisualizer({ type, className, color, barCount }: AutoSizedVisualizerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const fitSize = useFitSize(containerRef);

	return (
		<div className="flex h-full w-full items-center justify-center" ref={containerRef}>
			<VisualizerVariant
				barCount={barCount}
				className={className}
				color={color}
				size={fitSize}
				type={type}
			/>
		</div>
	);
}

interface VisualizerVariantProps {
	barCount?: number | undefined;
	className?: string | undefined;
	color?: `#${string}` | undefined;
	size: VisualizerSize;
	type: VisualizerType;
}

interface CommonVisualizerProps {
	className?: string | undefined;
	color?: `#${string}` | undefined;
	size: VisualizerSize;
}
type VisualizerComponent = React.ComponentType<CommonVisualizerProps>;

const NON_BAR_VARIANTS: Partial<Record<VisualizerType, VisualizerComponent>> = {
	grid: AudioVisualizerGrid as VisualizerComponent,
	radial: AudioVisualizerRadial as VisualizerComponent,
	wave: AudioVisualizerWave as VisualizerComponent,
	aura: AudioVisualizerAura as VisualizerComponent,
};

function VisualizerVariant({ type, barCount, ...common }: VisualizerVariantProps) {
	const NonBarComponent = NON_BAR_VARIANTS[type];
	if (NonBarComponent) {
		return <NonBarComponent {...common} />;
	}
	return <AudioVisualizerBar {...common} barCount={barCount} />;
}
