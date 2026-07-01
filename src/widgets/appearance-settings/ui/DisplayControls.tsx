import type { ReactNode } from "react";
import { DEFAULT_SETTINGS, SettingField } from "@/entities/setting";
import { DEFAULT_LOCALE, type Locale } from "@/shared/i18n";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Slider } from "@/shared/ui/slider";
import { Switcher } from "@/shared/ui/switcher";
import {
	buildOverlayModeSwitcherOptions,
	buildVisualizerTypeSwitcherOptions,
	effectiveLiveDisplay,
	flagsToLiveDisplay,
	type LiveTranscriptionDisplayValue,
	liveDisplayToFlags,
	liveOverlayDisabled,
	overlaySliderLabel,
	overlaySliderMax,
	overlaySliderPatch,
	overlaySliderToIndex,
	pickLocale,
	pickVisualizerType,
} from "../lib/appearance-settings-helpers";
import {
	type GeneralSettings,
	type GeneralT,
	LANGUAGE_OPTIONS,
	type UpdateFn,
} from "./appearance-settings-types";

export const LISTEN_MODE_DISPLAY_TOOLTIP =
	"Listen mode always transcribes speaker audio inside the main app window; the floating overlay and outer pill are disabled.";

interface LanguageControlProps {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: GeneralT;
}

export function LanguageControl({
	locale,
	setLocale,
	t,
}: LanguageControlProps): ReactNode {
	return (
		<SettingField
			isDefault={locale === DEFAULT_LOCALE}
			label={t("language")}
			layout="row"
			onReset={() => setLocale(DEFAULT_LOCALE)}
			tooltip={t("languageTooltip")}
		>
			<SearchableSelect
				className="w-52"
				onChange={(v) => pickLocale(v, setLocale)}
				options={LANGUAGE_OPTIONS}
				value={locale}
			/>
		</SettingField>
	);
}

interface OverlayControlProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	t: GeneralT;
	update: UpdateFn;
}

export function OverlayControl({
	t,
	isListenMode,
	general,
	update,
}: OverlayControlProps): ReactNode {
	const idx = isListenMode ? 0 : overlaySliderToIndex(general);
	return (
		<SettingField
			disabled={isListenMode}
			disabledTooltip={isListenMode ? LISTEN_MODE_DISPLAY_TOOLTIP : undefined}
			hideReset={isListenMode}
			isDefault={idx === overlaySliderToIndex(DEFAULT_SETTINGS.general)}
			label={t("showRecordingOverlay")}
			onReset={() =>
				update(
					overlaySliderPatch(
						overlaySliderToIndex(DEFAULT_SETTINGS.general),
						general,
					),
				)
			}
			tooltip={t("showRecordingOverlayTooltip")}
		>
			<Slider
				className={isListenMode ? "pointer-events-none opacity-40" : undefined}
				aria-label={t("showRecordingOverlay")}
				formatValue={(v) => overlaySliderLabel(v, t)}
				max={overlaySliderMax()}
				min={0}
				onChange={(v) => update(overlaySliderPatch(v, general))}
				step={1}
				value={idx}
			/>
		</SettingField>
	);
}

interface OverlayModeControlProps {
	disabledTooltip?: string | undefined;
	general: GeneralSettings | undefined;
	subDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

export function OverlayModeControl({
	t,
	subDisabled,
	disabledTooltip,
	general,
	update,
}: OverlayModeControlProps): ReactNode {
	const value = general?.overlayMode ?? DEFAULT_SETTINGS.general.overlayMode;
	const options = buildOverlayModeSwitcherOptions(t);
	const onChange = (next: string): void => {
		if (next === "floating-bottom" || next === "dynamic-island") {
			update({ overlayMode: next });
		}
	};
	return (
		<SettingField
			disabled={subDisabled}
			disabledTooltip={disabledTooltip}
			hideReset={subDisabled}
			isDefault={value === DEFAULT_SETTINGS.general.overlayMode}
			label={t("overlayMode")}
			onReset={() =>
				update({ overlayMode: DEFAULT_SETTINGS.general.overlayMode })
			}
			tooltip={t("overlayModeTooltip")}
		>
			<Switcher
				className={subDisabled ? "pointer-events-none opacity-40" : undefined}
				fullWidth
				onChange={onChange}
				options={options}
				value={value}
			/>
		</SettingField>
	);
}

interface LiveTranscriptionDisplayControlProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	realtimeLanguageUnavailable: boolean;
	suppressWordByWordPillPreview: boolean;
	t: GeneralT;
	update: UpdateFn;
}

export function LiveTranscriptionDisplayControl({
	t,
	general,
	isListenMode,
	realtimeLanguageUnavailable,
	suppressWordByWordPillPreview,
	update,
}: LiveTranscriptionDisplayControlProps): ReactNode {
	const overlayDisabled = liveOverlayDisabled(general);
	const pillDisabled =
		isListenMode ||
		realtimeLanguageUnavailable ||
		overlayDisabled ||
		suppressWordByWordPillPreview;
	const stored: LiveTranscriptionDisplayValue =
		general?.liveTranscriptionDisplay ?? "both";
	const value = isListenMode
		? "in-app"
		: realtimeLanguageUnavailable
			? "none"
			: effectiveLiveDisplay(stored, overlayDisabled);
	const { inApp, inOverlay: storedInOverlay } = liveDisplayToFlags(value);
	const inOverlay = suppressWordByWordPillPreview ? false : storedInOverlay;
	const checkedIndices = new Set<number>();
	if (inApp) {
		checkedIndices.add(0);
	}
	if (inOverlay) {
		checkedIndices.add(1);
	}
	const setInApp = (next: boolean): void => {
		if (isListenMode || realtimeLanguageUnavailable) {
			return;
		}
		update({ liveTranscriptionDisplay: flagsToLiveDisplay(next, inOverlay) });
	};
	const setInOverlay = (next: boolean): void => {
		if (pillDisabled) {
			return;
		}
		update({ liveTranscriptionDisplay: flagsToLiveDisplay(inApp, next) });
	};
	return (
		<SettingField
			disabled={isListenMode || realtimeLanguageUnavailable}
			disabledTooltip={
				isListenMode
					? LISTEN_MODE_DISPLAY_TOOLTIP
					: realtimeLanguageUnavailable
						? "The selected realtime model cannot stream the current source language."
						: undefined
			}
			hideReset={isListenMode || realtimeLanguageUnavailable}
			isDefault={
				isListenMode ||
				stored === DEFAULT_SETTINGS.general.liveTranscriptionDisplay
			}
			label={t("liveTranscriptionDisplay")}
			onReset={() =>
				update({
					liveTranscriptionDisplay:
						DEFAULT_SETTINGS.general.liveTranscriptionDisplay,
				})
			}
			tooltip={t("liveTranscriptionDisplayTooltip")}
		>
			<CheckboxGroup checkedIndices={checkedIndices} className="w-full" framed>
				<CheckboxItem
					checked={inApp}
					disabled={isListenMode || realtimeLanguageUnavailable}
					index={0}
					label={t("liveTranscriptionDisplayInApp")}
					onToggle={() => setInApp(!inApp)}
				/>
				<CheckboxItem
					checked={inOverlay}
					disabled={pillDisabled}
					index={1}
					label={t("liveTranscriptionDisplayInPill")}
					onToggle={() => setInOverlay(!inOverlay)}
				/>
			</CheckboxGroup>
		</SettingField>
	);
}

interface VisualizerTypeControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

export function VisualizerTypeControl({
	t,
	general,
	update,
}: VisualizerTypeControlProps): ReactNode {
	const value = general?.visualizerType ?? "bar";
	const options = buildVisualizerTypeSwitcherOptions(t);
	return (
		<SettingField
			isDefault={value === DEFAULT_SETTINGS.general.visualizerType}
			label={t("visualizerType")}
			onReset={() =>
				pickVisualizerType(DEFAULT_SETTINGS.general.visualizerType, update)
			}
			tooltip={t("visualizerTypeTooltip")}
		>
			<Switcher
				fullWidth
				onChange={(v) => pickVisualizerType(v, update)}
				options={options}
				value={value}
			/>
		</SettingField>
	);
}
