import { DashboardCircleIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { DEFAULT_LOCALE, LOCALE_NAMES, LOCALES, type Locale, useLocaleStore } from "@/shared/i18n";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher } from "@/shared/ui/switcher";
import {
	buildAuraShapeSwitcherOptions,
	buildOverlayModeSwitcherOptions,
	buildVisualizerTypeSwitcherOptions,
	computeDisplayFlags,
	effectiveLiveDisplay,
	flagsToLiveDisplay,
	getVisualizerType,
	type LiveTranscriptionDisplayValue,
	liveDisplayToFlags,
	liveOverlayDisabled,
	overlaySliderLabel,
	overlaySliderMax,
	overlaySliderPatch,
	overlaySliderToIndex,
	pickAuraShape,
	pickLocale,
	pickVisualizerType,
} from "../lib/appearance-settings-helpers";

// Country-code chip shown in the language picker — the ISO 3166-1 alpha-2
// country most associated with each locale (English → US per the product
// spec; the rest use the language's canonical/origin country). Text only, no
// flag image. Keep entries in sync with LOCALES in shared/i18n/config.ts when
// adding a new locale baseline.
const LOCALE_BADGE: Record<Locale, string> = {
	en: "US",
	ar: "SA",
	bg: "BG",
	cs: "CZ",
	de: "DE",
	es: "ES",
	fr: "FR",
	he: "IL",
	hi: "IN",
	it: "IT",
	ja: "JP",
	ko: "KR",
	pl: "PL",
	pt: "PT",
	ru: "RU",
	sv: "SE",
	tr: "TR",
	uk: "UA",
	vi: "VN",
	zh: "CN",
};

const LANGUAGE_OPTIONS: SelectOption[] = LOCALES.map((code) => ({
	id: code,
	label: LOCALE_NAMES[code].native,
	badge: LOCALE_BADGE[code],
}));

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateFn = (patch: Partial<GeneralSettings>) => void;

interface LanguageControlProps {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: GeneralT;
}

function LanguageControl({ locale, setLocale, t }: LanguageControlProps): ReactNode {
	return (
		<FormControl
			label={t("language")}
			labelTrailing={
				<SettingResetButton
					isDefault={locale === DEFAULT_LOCALE}
					onReset={() => setLocale(DEFAULT_LOCALE)}
				/>
			}
			layout="row"
			tooltip={t("languageTooltip")}
		>
			<ElevatedSurface className="w-52" inline>
				<SearchableSelect
					onChange={(v) => pickLocale(v, setLocale)}
					options={LANGUAGE_OPTIONS}
					value={locale}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface OverlayControlProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function OverlayControl({ t, isListenMode, general, update }: OverlayControlProps): ReactNode {
	const idx = overlaySliderToIndex(general);
	return (
		<FormControl
			disabled={isListenMode}
			label={t("showRecordingOverlay")}
			labelTrailing={
				isListenMode ? undefined : (
					<SettingResetButton
						isDefault={idx === overlaySliderToIndex(DEFAULT_SETTINGS.general)}
						onReset={() =>
							update(overlaySliderPatch(overlaySliderToIndex(DEFAULT_SETTINGS.general), general))
						}
					/>
				)
			}
			tooltip={t("showRecordingOverlayTooltip")}
		>
			<ElevatedSurface
				className={isListenMode ? "pointer-events-none opacity-40" : undefined}
				inline
			>
				<Slider
					aria-label={t("showRecordingOverlay")}
					formatValue={(v) => overlaySliderLabel(v, t)}
					max={overlaySliderMax()}
					min={0}
					onChange={(v) => update(overlaySliderPatch(v, general))}
					step={1}
					value={idx}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface OverlayModeControlProps {
	general: GeneralSettings | undefined;
	subDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function OverlayModeControl({
	t,
	subDisabled,
	general,
	update,
}: OverlayModeControlProps): ReactNode {
	const value = general?.overlayMode ?? "floating-bottom";
	const options = buildOverlayModeSwitcherOptions(t);
	const onChange = (next: string): void => {
		if (next === "floating-bottom" || next === "dynamic-island") {
			update({ overlayMode: next });
		}
	};
	return (
		<FormControl
			label={t("overlayMode")}
			labelTrailing={
				subDisabled ? undefined : (
					<SettingResetButton
						isDefault={value === DEFAULT_SETTINGS.general.overlayMode}
						onReset={() => update({ overlayMode: DEFAULT_SETTINGS.general.overlayMode })}
					/>
				)
			}
			tooltip={t("overlayModeTooltip")}
		>
			<ElevatedSurface className={subDisabled ? "pointer-events-none opacity-40" : undefined}>
				<Switcher fullWidth onChange={onChange} options={options} value={value} />
			</ElevatedSurface>
		</FormControl>
	);
}

interface LiveTranscriptionDisplayControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function LiveTranscriptionDisplayControl({
	t,
	general,
	update,
}: LiveTranscriptionDisplayControlProps): ReactNode {
	const overlayDisabled = liveOverlayDisabled(general);
	const stored: LiveTranscriptionDisplayValue = general?.liveTranscriptionDisplay ?? "both";
	const value = effectiveLiveDisplay(stored, overlayDisabled);
	const { inApp, inOverlay } = liveDisplayToFlags(value);
	const checkedIndices = new Set<number>();
	if (inApp) {
		checkedIndices.add(0);
	}
	if (inOverlay) {
		checkedIndices.add(1);
	}
	const setInApp = (next: boolean): void => {
		update({ liveTranscriptionDisplay: flagsToLiveDisplay(next, inOverlay) });
	};
	const setInOverlay = (next: boolean): void => {
		if (overlayDisabled) {
			return;
		}
		update({ liveTranscriptionDisplay: flagsToLiveDisplay(inApp, next) });
	};
	return (
		<FormControl
			label={t("liveTranscriptionDisplay")}
			labelTrailing={
				<SettingResetButton
					isDefault={stored === DEFAULT_SETTINGS.general.liveTranscriptionDisplay}
					onReset={() =>
						update({
							liveTranscriptionDisplay: DEFAULT_SETTINGS.general.liveTranscriptionDisplay,
						})
					}
				/>
			}
			tooltip={t("liveTranscriptionDisplayTooltip")}
		>
			<ElevatedSurface>
				<CheckboxGroup checkedIndices={checkedIndices} className="w-full">
					<CheckboxItem
						checked={inApp}
						index={0}
						label={t("liveTranscriptionDisplayInApp")}
						onToggle={() => setInApp(!inApp)}
					/>
					<CheckboxItem
						checked={inOverlay}
						disabled={overlayDisabled}
						index={1}
						label={t("liveTranscriptionDisplayInPill")}
						onToggle={() => setInOverlay(!inOverlay)}
					/>
				</CheckboxGroup>
			</ElevatedSurface>
		</FormControl>
	);
}

interface VisualizerTypeControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerTypeControl({ t, general, update }: VisualizerTypeControlProps): ReactNode {
	const value = general?.visualizerType ?? "bar";
	const options = buildVisualizerTypeSwitcherOptions(t);
	return (
		<FormControl
			label={t("visualizerType")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.visualizerType}
					onReset={() => pickVisualizerType(DEFAULT_SETTINGS.general.visualizerType, update)}
				/>
			}
			tooltip={t("visualizerTypeTooltip")}
		>
			<ElevatedSurface>
				<Switcher
					fullWidth
					onChange={(v) => pickVisualizerType(v, update)}
					options={options}
					value={value}
				/>
			</ElevatedSurface>
		</FormControl>
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
	const value = general?.visualizerBarCount ?? DEFAULT_SETTINGS.general.visualizerBarCount;
	return (
		<FormControl
			label={t("visualizerBarCount")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.visualizerBarCount}
					onReset={() =>
						update({ visualizerBarCount: DEFAULT_SETTINGS.general.visualizerBarCount })
					}
				/>
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
		</FormControl>
	);
}

type GeneralMessageKey = Parameters<GeneralT>[0];

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
		<FormControl
			label={label}
			labelTrailing={
				<SettingResetButton
					isDefault={value === defaultValue}
					onReset={() => onChange(defaultValue)}
				/>
			}
			tooltip={t(tooltipKey)}
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
		</FormControl>
	);
}

interface VisualizerShapeControlsProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerRadialControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
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

function VisualizerGridControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
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

function VisualizerWaveControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
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
	const value = general?.visualizerAuraShape ?? DEFAULT_SETTINGS.general.visualizerAuraShape;
	const options = buildAuraShapeSwitcherOptions(t);
	return (
		<FormControl
			label={t("visualizerAuraShape")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.visualizerAuraShape}
					onReset={() => pickAuraShape(DEFAULT_SETTINGS.general.visualizerAuraShape, update)}
				/>
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
		</FormControl>
	);
}

function VisualizerAuraControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
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
function VisualizerShapeControls({ t, general, update }: VisualizerShapeControlsProps): ReactNode {
	switch (getVisualizerType(general)) {
		case "radial":
			return <VisualizerRadialControls general={general} t={t} update={update} />;
		case "grid":
			return <VisualizerGridControls general={general} t={t} update={update} />;
		case "wave":
			return <VisualizerWaveControls general={general} t={t} update={update} />;
		case "aura":
			return <VisualizerAuraControls general={general} t={t} update={update} />;
		default:
			return <VisualizerBarCountControl general={general} t={t} update={update} />;
	}
}

export function AppearanceSettingsPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");

	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";
	const flags = computeDisplayFlags(isListenMode, general);

	return (
		<div className="flex flex-col gap-2">
			<SettingSection icon={DashboardCircleIcon} title={t("display")}>
				<div className="flex flex-col divide-y divide-surface-1">
					<LanguageControl locale={locale} setLocale={setLocale} t={t} />
					<VisualizerTypeControl general={general} t={t} update={update} />
					<VisualizerShapeControls general={general} t={t} update={update} />
					<OverlayControl general={general} isListenMode={isListenMode} t={t} update={update} />
					<OverlayModeControl
						general={general}
						subDisabled={flags.subDisabled}
						t={t}
						update={update}
					/>
					<LiveTranscriptionDisplayControl general={general} t={t} update={update} />
				</div>
			</SettingSection>
		</div>
	);
}
