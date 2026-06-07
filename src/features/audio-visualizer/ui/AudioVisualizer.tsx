import { useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	RECORDING_MODE_COLOR_HEX,
	type RecordingMode,
} from "@/shared/config/recording-mode-color";
import type {
	VisualizerConfig,
	VisualizerSize,
	VisualizerType,
} from "../lib/audio-visualizer";
import { resolveVisualizerConfig } from "../lib/audio-visualizer";
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
 * Renders the visualizer selected in settings, forwarding the per-shape
 * customization knobs (resolved by `resolveVisualizerConfig`) to the matching
 * component. Defaults to "bar" if no setting is configured.
 */
export function AudioVisualizer({
	size = "lg",
	className,
}: AudioVisualizerProps) {
	const general = useSettingsStore((s) => s.settings.general);
	const visualizerType: VisualizerType = general?.visualizerType ?? "bar";
	const recordingMode = (general?.recordingMode ?? "ptt") as RecordingMode;
	const color = RECORDING_MODE_COLOR_HEX[recordingMode] as `#${string}`;
	const config = resolveVisualizerConfig(general);

	if (size === "auto") {
		return (
			<AutoSizedVisualizer
				className={className}
				color={color}
				config={config}
				type={visualizerType}
			/>
		);
	}

	return (
		<VisualizerVariant
			className={className}
			color={color}
			config={config}
			size={size}
			type={visualizerType}
		/>
	);
}

interface AutoSizedVisualizerProps {
	className?: string | undefined;
	color: `#${string}`;
	config: VisualizerConfig;
	type: VisualizerType;
}

function AutoSizedVisualizer({
	type,
	className,
	color,
	config,
}: AutoSizedVisualizerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const fitSize = useFitSize(containerRef);

	return (
		<div
			className="flex h-full w-full items-center justify-center"
			ref={containerRef}
		>
			<VisualizerVariant
				className={className}
				color={color}
				config={config}
				size={fitSize}
				type={type}
			/>
		</div>
	);
}

interface VisualizerVariantProps {
	className?: string | undefined;
	color: `#${string}`;
	config: VisualizerConfig;
	size: VisualizerSize;
	type: VisualizerType;
}

function VisualizerVariant({
	type,
	config,
	className,
	color,
	size,
}: VisualizerVariantProps) {
	// Omit `className` entirely when undefined — the leaf components declare it as
	// a non-`undefined` optional (exactOptionalPropertyTypes), so a literal
	// `className={undefined}` would be a type error.
	const cls = className === undefined ? {} : { className };
	switch (type) {
		case "grid":
			return (
				<AudioVisualizerGrid
					{...cls}
					color={color}
					columnCount={config.gridColumns}
					interval={config.gridInterval}
					rowCount={config.gridRows}
					size={size}
				/>
			);
		case "radial":
			return (
				<AudioVisualizerRadial
					{...cls}
					barCount={config.radialDotCount}
					color={color}
					radiusPct={config.radialRadiusPct}
					size={size}
				/>
			);
		case "wave":
			return (
				<AudioVisualizerWave
					{...cls}
					blur={config.waveBlur}
					color={color}
					colorShift={config.waveColorShift}
					lineWidth={config.waveLineWidth}
					size={size}
				/>
			);
		case "aura":
			return (
				<AudioVisualizerAura
					{...cls}
					bloom={config.auraBloom}
					blur={config.auraBlur}
					color={color}
					colorShift={config.auraColorShift}
					shape={config.auraShape}
					size={size}
				/>
			);
		default:
			return (
				<AudioVisualizerBar
					{...cls}
					barCount={config.barCount}
					color={color}
					size={size}
				/>
			);
	}
}
