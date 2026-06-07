import type { ReactNode } from "react";
import { DEFAULT_SETTINGS, SettingField } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Slider } from "@/shared/ui/slider";
import { Switcher } from "@/shared/ui/switcher";
import {
	buildAuraShapeSwitcherOptions,
	getVisualizerType,
	pickAuraShape,
} from "../lib/appearance-settings-helpers";
import type {
	GeneralMessageKey,
	GeneralSettings,
	GeneralT,
	UpdateFn,
} from "./appearance-settings-types";

const formatPercent = (v: number): string => `${v}%`;

interface VizSliderControlProps {
	defaultValue: number;
	formatValue?: (v: number) => string;
	labelKey: GeneralMessageKey;
	max: number;
	min: number;
	onChange: (v: number) => void;
	step: number;
	t: GeneralT;
	tooltipKey: GeneralMessageKey;
	value: number;
}

/**
 * Shared presentational slider row for the per-shape visualizer knobs. Mirrors
 * `VisualizerBarCountControl` (label + reset + ElevatedSurface slider) so every
 * shape's controls read identically.
 */
function VizSliderControl({
	t,
	labelKey,
	tooltipKey,
	value,
	defaultValue,
	onChange,
	min,
	max,
	step,
	formatValue,
}: VizSliderControlProps): ReactNode {
	const label = t(labelKey);
	return (
		<SettingField
			defaultValue={defaultValue}
			label={label}
			onReset={() => onChange(defaultValue)}
			tooltip={t(tooltipKey)}
			value={value}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={label}
					max={max}
					min={min}
					onChange={onChange}
					step={step}
					value={value}
					{...(formatValue ? { formatValue } : {})}
				/>
			</ElevatedSurface>
		</SettingField>
	);
}

interface VisualizerBarCountControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerBarCountControl({
	t,
	general,
	update,
}: VisualizerBarCountControlProps): ReactNode {
	const value =
		general?.visualizerBarCount ?? DEFAULT_SETTINGS.general.visualizerBarCount;
	return (
		<SettingField
			isDefault={value === DEFAULT_SETTINGS.general.visualizerBarCount}
			label={t("visualizerBarCount")}
			onReset={() =>
				update({
					visualizerBarCount: DEFAULT_SETTINGS.general.visualizerBarCount,
				})
			}
			tooltip={t("visualizerBarCountTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("visualizerBarCount")}
					max={21}
					min={3}
					onChange={(v) => update({ visualizerBarCount: v })}
					step={2}
					value={value}
				/>
			</ElevatedSurface>
		</SettingField>
	);
}

interface VisualizerShapeControlsProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerRadialControls({
	t,
	general,
	update,
}: VisualizerShapeControlsProps): ReactNode {
	const d = DEFAULT_SETTINGS.general;
	return (
		<>
			<VizSliderControl
				defaultValue={d.visualizerRadialDotCount}
				labelKey="visualizerRadialDotCount"
				max={48}
				min={6}
				onChange={(v) => update({ visualizerRadialDotCount: v })}
				step={2}
				t={t}
				tooltipKey="visualizerRadialDotCountTooltip"
				value={general?.visualizerRadialDotCount ?? d.visualizerRadialDotCount}
			/>
			<VizSliderControl
				defaultValue={d.visualizerRadialRadius}
				formatValue={formatPercent}
				labelKey="visualizerRadialRadius"
				max={90}
				min={20}
				onChange={(v) => update({ visualizerRadialRadius: v })}
				step={1}
				t={t}
				tooltipKey="visualizerRadialRadiusTooltip"
				value={general?.visualizerRadialRadius ?? d.visualizerRadialRadius}
			/>
		</>
	);
}

function VisualizerGridControls({
	t,
	general,
	update,
}: VisualizerShapeControlsProps): ReactNode {
	const d = DEFAULT_SETTINGS.general;
	return (
		<>
			<VizSliderControl
				defaultValue={d.visualizerGridRows}
				labelKey="visualizerGridRows"
				max={8}
				min={3}
				onChange={(v) => update({ visualizerGridRows: v })}
				step={1}
				t={t}
				tooltipKey="visualizerGridRowsTooltip"
				value={general?.visualizerGridRows ?? d.visualizerGridRows}
			/>
			<VizSliderControl
				defaultValue={d.visualizerGridColumns}
				labelKey="visualizerGridColumns"
				max={8}
				min={3}
				onChange={(v) => update({ visualizerGridColumns: v })}
				step={1}
				t={t}
				tooltipKey="visualizerGridColumnsTooltip"
				value={general?.visualizerGridColumns ?? d.visualizerGridColumns}
			/>
			<VizSliderControl
				defaultValue={d.visualizerGridSpeed}
				labelKey="visualizerGridSpeed"
				max={10}
				min={1}
				onChange={(v) => update({ visualizerGridSpeed: v })}
				step={1}
				t={t}
				tooltipKey="visualizerGridSpeedTooltip"
				value={general?.visualizerGridSpeed ?? d.visualizerGridSpeed}
			/>
		</>
	);
}

function VisualizerWaveControls({
	t,
	general,
	update,
}: VisualizerShapeControlsProps): ReactNode {
	const d = DEFAULT_SETTINGS.general;
	return (
		<>
			<VizSliderControl
				defaultValue={d.visualizerWaveLineWidth}
				labelKey="visualizerWaveLineWidth"
				max={6}
				min={1}
				onChange={(v) => update({ visualizerWaveLineWidth: v })}
				step={1}
				t={t}
				tooltipKey="visualizerWaveLineWidthTooltip"
				value={general?.visualizerWaveLineWidth ?? d.visualizerWaveLineWidth}
			/>
			<VizSliderControl
				defaultValue={d.visualizerWaveSmoothing}
				formatValue={formatPercent}
				labelKey="visualizerWaveSmoothing"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerWaveSmoothing: v })}
				step={5}
				t={t}
				tooltipKey="visualizerWaveSmoothingTooltip"
				value={general?.visualizerWaveSmoothing ?? d.visualizerWaveSmoothing}
			/>
			<VizSliderControl
				defaultValue={d.visualizerWaveColorShift}
				formatValue={formatPercent}
				labelKey="visualizerWaveColorShift"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerWaveColorShift: v })}
				step={5}
				t={t}
				tooltipKey="visualizerWaveColorShiftTooltip"
				value={general?.visualizerWaveColorShift ?? d.visualizerWaveColorShift}
			/>
		</>
	);
}

function VisualizerAuraShapeControl({
	t,
	general,
	update,
}: VisualizerShapeControlsProps): ReactNode {
	const value =
		general?.visualizerAuraShape ??
		DEFAULT_SETTINGS.general.visualizerAuraShape;
	const options = buildAuraShapeSwitcherOptions(t);
	return (
		<SettingField
			isDefault={value === DEFAULT_SETTINGS.general.visualizerAuraShape}
			label={t("visualizerAuraShape")}
			onReset={() =>
				pickAuraShape(DEFAULT_SETTINGS.general.visualizerAuraShape, update)
			}
			tooltip={t("visualizerAuraShapeTooltip")}
		>
			<ElevatedSurface>
				<Switcher
					fullWidth
					onChange={(v) => pickAuraShape(v, update)}
					options={options}
					value={value}
				/>
			</ElevatedSurface>
		</SettingField>
	);
}

function VisualizerAuraControls({
	t,
	general,
	update,
}: VisualizerShapeControlsProps): ReactNode {
	const d = DEFAULT_SETTINGS.general;
	return (
		<>
			<VisualizerAuraShapeControl general={general} t={t} update={update} />
			<VizSliderControl
				defaultValue={d.visualizerAuraBlur}
				formatValue={formatPercent}
				labelKey="visualizerAuraBlur"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerAuraBlur: v })}
				step={5}
				t={t}
				tooltipKey="visualizerAuraBlurTooltip"
				value={general?.visualizerAuraBlur ?? d.visualizerAuraBlur}
			/>
			<VizSliderControl
				defaultValue={d.visualizerAuraBloom}
				formatValue={formatPercent}
				labelKey="visualizerAuraBloom"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerAuraBloom: v })}
				step={5}
				t={t}
				tooltipKey="visualizerAuraBloomTooltip"
				value={general?.visualizerAuraBloom ?? d.visualizerAuraBloom}
			/>
			<VizSliderControl
				defaultValue={d.visualizerAuraColorShift}
				formatValue={formatPercent}
				labelKey="visualizerAuraColorShift"
				max={100}
				min={0}
				onChange={(v) => update({ visualizerAuraColorShift: v })}
				step={5}
				t={t}
				tooltipKey="visualizerAuraColorShiftTooltip"
				value={general?.visualizerAuraColorShift ?? d.visualizerAuraColorShift}
			/>
		</>
	);
}

/** Renders the customization controls for whichever visualizer shape is active. */
export function VisualizerShapeControls({
	t,
	general,
	update,
}: VisualizerShapeControlsProps): ReactNode {
	switch (getVisualizerType(general)) {
		case "radial":
			return (
				<VisualizerRadialControls general={general} t={t} update={update} />
			);
		case "grid":
			return <VisualizerGridControls general={general} t={t} update={update} />;
		case "wave":
			return <VisualizerWaveControls general={general} t={t} update={update} />;
		case "aura":
			return <VisualizerAuraControls general={general} t={t} update={update} />;
		default:
			return (
				<VisualizerBarCountControl general={general} t={t} update={update} />
			);
	}
}
