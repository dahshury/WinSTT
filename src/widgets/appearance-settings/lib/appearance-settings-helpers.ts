import {
	AiBeautifyIcon,
	AudioWave02Icon,
	BarChartIcon,
	GridIcon,
	LayoutBottomIcon,
	PictureInPictureOnIcon,
	RadialIcon,
} from "@hugeicons/core-free-icons";
import type { useTranslations } from "use-intl";
import type { useSettingsStore } from "@/entities/setting";
import { isVisualizerType, type VisualizerType } from "@/features/audio-visualizer";
import { isLocale, type Locale } from "@/shared/i18n";
import type { SwitcherOption } from "@/shared/ui/switcher";

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateFn = (patch: Partial<GeneralSettings>) => void;

type VisualizerSizePreset = "xs" | "sm" | "md" | "lg" | "xl";

export const VISUALIZER_SIZE_PRESETS = [
	"xs",
	"sm",
	"md",
	"lg",
	"xl",
] as const satisfies readonly VisualizerSizePreset[];

export const VISUALIZER_SIZE_LABELS: Record<VisualizerSizePreset, string> = {
	xs: "XS",
	sm: "S",
	md: "M",
	lg: "L",
	xl: "XL",
};

export function visualizerSizeToIndex(preset: VisualizerSizePreset): number {
	const idx = VISUALIZER_SIZE_PRESETS.indexOf(preset);
	return idx === -1 ? 0 : idx;
}

export function visualizerSizeFromIndex(index: number): VisualizerSizePreset {
	return VISUALIZER_SIZE_PRESETS[index] ?? "xs";
}

export function buildVisualizerTypeSwitcherOptions(t: GeneralT): SwitcherOption[] {
	return [
		{ value: "bar", label: t("visualizerBar"), icon: BarChartIcon, preview: "viz-bar" },
		{ value: "grid", label: t("visualizerGrid"), icon: GridIcon, preview: "viz-grid" },
		{ value: "radial", label: t("visualizerRadial"), icon: RadialIcon, preview: "viz-radial" },
		{ value: "wave", label: t("visualizerWave"), icon: AudioWave02Icon, preview: "viz-wave" },
		{ value: "aura", label: t("visualizerAura"), icon: AiBeautifyIcon, preview: "viz-aura" },
	];
}

export function pickLocale(value: string, setLocale: (locale: Locale) => void): void {
	if (isLocale(value)) {
		setLocale(value);
	}
}

export type LiveTranscriptionDisplayValue = "none" | "in-app" | "in-pill" | "both";

export interface DisplayFlags {
	overlayEnabled: boolean;
	subDisabled: boolean;
}

export function computeDisplayFlags(
	isListenMode: boolean,
	general: GeneralSettings | undefined
): DisplayFlags {
	const showOverlay = general?.showRecordingOverlay ?? true;
	const overlayEnabled = !isListenMode && showOverlay;
	const subDisabled = !overlayEnabled;
	return { overlayEnabled, subDisabled };
}

export function liveOverlayDisabled(general: GeneralSettings | undefined): boolean {
	return !(general?.showRecordingOverlay ?? true);
}

function needsOverlay(value: LiveTranscriptionDisplayValue): boolean {
	return value === "in-pill" || value === "both";
}

export function effectiveLiveDisplay(
	value: LiveTranscriptionDisplayValue,
	overlayDisabled: boolean
): LiveTranscriptionDisplayValue {
	return overlayDisabled && needsOverlay(value) ? "in-app" : value;
}

function overlayEnablePatch(): Partial<GeneralSettings> {
	return { showRecordingOverlay: true };
}

function overlayDisablePatchForLive(
	current: LiveTranscriptionDisplayValue
): Partial<GeneralSettings> {
	return needsOverlay(current)
		? { showRecordingOverlay: false, liveTranscriptionDisplay: "in-app" }
		: { showRecordingOverlay: false };
}

function currentLiveDisplay(general: GeneralSettings | undefined): LiveTranscriptionDisplayValue {
	return general?.liveTranscriptionDisplay ?? "both";
}

export function overlayTogglePatch(
	enabled: boolean,
	general: GeneralSettings | undefined
): Partial<GeneralSettings> {
	return enabled ? overlayEnablePatch() : overlayDisablePatchForLive(currentLiveDisplay(general));
}

// Combined "Off + sizes" overlay slider. Index 0 is Off (turns the overlay
// off and reverts overlay-only live transcription choices to in-app via the
// shared overlayTogglePatch). Indices 1..N map to VISUALIZER_SIZE_PRESETS.
export function overlaySliderToIndex(general: GeneralSettings | undefined): number {
	const showOverlay = general?.showRecordingOverlay ?? true;
	if (!showOverlay) {
		return 0;
	}
	const size = general?.visualizerSize ?? "xs";
	return visualizerSizeToIndex(size) + 1;
}

export function overlaySliderMax(): number {
	return VISUALIZER_SIZE_PRESETS.length;
}

export function overlaySliderPatch(
	index: number,
	general: GeneralSettings | undefined
): Partial<GeneralSettings> {
	if (index <= 0) {
		return overlayTogglePatch(false, general);
	}
	const preset = visualizerSizeFromIndex(index - 1);
	return { showRecordingOverlay: true, visualizerSize: preset };
}

export function overlaySliderLabel(index: number, t: GeneralT): string {
	if (index <= 0) {
		return t("overlaySizeOff");
	}
	return VISUALIZER_SIZE_LABELS[visualizerSizeFromIndex(index - 1)];
}

export function buildOverlayModeSwitcherOptions(t: GeneralT): SwitcherOption[] {
	return [
		{
			value: "floating-bottom",
			label: t("overlayModeFloatingBottom"),
			icon: LayoutBottomIcon,
			preview: "overlay-floating",
		},
		{
			value: "dynamic-island",
			label: t("overlayModeDynamicIsland"),
			icon: PictureInPictureOnIcon,
			preview: "overlay-island",
		},
	];
}

export function liveDisplayToFlags(value: LiveTranscriptionDisplayValue): {
	inApp: boolean;
	inOverlay: boolean;
} {
	return {
		inApp: value === "in-app" || value === "both",
		inOverlay: value === "in-pill" || value === "both",
	};
}

type FlagsKey = "00" | "01" | "10" | "11";

const FLAGS_TO_LIVE_DISPLAY: Record<FlagsKey, LiveTranscriptionDisplayValue> = {
	"00": "none",
	"01": "in-pill",
	"10": "in-app",
	"11": "both",
};

function flagsKey(inApp: boolean, inOverlay: boolean): FlagsKey {
	return `${inApp ? "1" : "0"}${inOverlay ? "1" : "0"}` as FlagsKey;
}

export function flagsToLiveDisplay(
	inApp: boolean,
	inOverlay: boolean
): LiveTranscriptionDisplayValue {
	return FLAGS_TO_LIVE_DISPLAY[flagsKey(inApp, inOverlay)];
}

export function pickVisualizerType(value: string, update: UpdateFn): void {
	if (isVisualizerType(value)) {
		update({ visualizerType: value });
	}
}

/** Resolves the active visualizer type, defaulting to "bar" when unset. */
export function getVisualizerType(general: GeneralSettings | undefined): VisualizerType {
	return general?.visualizerType ?? "bar";
}

/** Segmented-control options for the Aura base-shape switcher (label-only). */
export function buildAuraShapeSwitcherOptions(t: GeneralT): SwitcherOption[] {
	return [
		{ value: "circle", label: t("visualizerAuraShapeCircle") },
		{ value: "line", label: t("visualizerAuraShapeLine") },
	];
}

/** Applies a guarded Aura-shape selection (ignores anything off the enum). */
export function pickAuraShape(value: string, update: UpdateFn): void {
	if (value === "circle" || value === "line") {
		update({ visualizerAuraShape: value });
	}
}
