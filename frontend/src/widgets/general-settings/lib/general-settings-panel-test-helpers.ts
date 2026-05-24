import {
	AiBeautifyIcon,
	AudioWave02Icon,
	BarChartIcon,
	EarIcon,
	GridIcon,
	RadialIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { useTranslations } from "next-intl";
import type { useSettingsStore } from "@/entities/setting";
import { isVisualizerType } from "@/features/audio-visualizer";
import { RECORDING_MODE_COLOR_HEX } from "@/shared/config/recording-mode-color";
import { isLocale, type Locale } from "@/shared/i18n";
import type { SelectOption } from "@/shared/ui/select";
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

export function buildVisualizerTypeOptions(t: GeneralT): SelectOption[] {
	return [
		{ id: "bar", label: t("visualizerBar"), icon: BarChartIcon },
		{ id: "grid", label: t("visualizerGrid"), icon: GridIcon },
		{ id: "radial", label: t("visualizerRadial"), icon: RadialIcon },
		{ id: "wave", label: t("visualizerWave"), icon: AudioWave02Icon },
		{ id: "aura", label: t("visualizerAura"), icon: AiBeautifyIcon },
	] satisfies SelectOption[];
}

export function buildVisualizerTypeSwitcherOptions(t: GeneralT): SwitcherOption[] {
	return [
		{ value: "bar", label: t("visualizerBar"), icon: BarChartIcon },
		{ value: "grid", label: t("visualizerGrid"), icon: GridIcon },
		{ value: "radial", label: t("visualizerRadial"), icon: RadialIcon },
		{ value: "wave", label: t("visualizerWave"), icon: AudioWave02Icon },
		{ value: "aura", label: t("visualizerAura"), icon: AiBeautifyIcon },
	];
}

export function buildRecordingModeOptions(t: GeneralT): readonly {
	value: "ptt" | "toggle" | "listen" | "wakeword";
	label: string;
	icon: IconSvgElement;
	color: string;
}[] {
	return [
		{
			value: "ptt",
			label: t("pushToTalk"),
			icon: TouchInteraction01Icon,
			color: RECORDING_MODE_COLOR_HEX.ptt,
		},
		{
			value: "toggle",
			label: t("toggle"),
			icon: ToggleOnIcon,
			color: RECORDING_MODE_COLOR_HEX.toggle,
		},
		{
			value: "listen",
			label: t("listen"),
			icon: EarIcon,
			color: RECORDING_MODE_COLOR_HEX.listen,
		},
		{
			value: "wakeword",
			label: t("wakeWord"),
			icon: VoiceIcon,
			color: RECORDING_MODE_COLOR_HEX.wakeword,
		},
	] as const;
}

export const PORCUPINE_FREE_KEYWORDS = [
	"alexa",
	"americano",
	"blueberry",
	"bumblebee",
	"computer",
	"grapefruit",
	"grasshopper",
	"hey google",
	"hey siri",
	"jarvis",
	"ok google",
	"picovoice",
	"porcupine",
	"terminator",
] as const;

export const OPENWAKEWORD_KEYWORDS = [
	"alexa",
	"hey_jarvis",
	"hey_mycroft",
	"hey_rhasspy",
	"timer",
	"weather",
] as const;

type WakeWordEngine = "porcupine" | "openwakeword" | "composite";

export function engineForKeyword(word: string): WakeWordEngine {
	const inPorc = (PORCUPINE_FREE_KEYWORDS as readonly string[]).includes(word);
	const inOww = (OPENWAKEWORD_KEYWORDS as readonly string[]).includes(word);
	if (inPorc && inOww) {
		return "composite";
	}
	if (inOww) {
		return "openwakeword";
	}
	return "porcupine";
}

export function formatWakeWordLabel(word: string): string {
	return word.replace(/_/g, " ");
}

export function buildUnifiedWakeWordList(): readonly string[] {
	const all = new Set<string>([...PORCUPINE_FREE_KEYWORDS, ...OPENWAKEWORD_KEYWORDS]);
	const sortKey = (w: string): number => {
		const engine = engineForKeyword(w);
		if (engine === "composite") {
			return 0;
		}
		if (engine === "porcupine") {
			return 1;
		}
		return 2;
	};
	return [...all].toSorted((a, b) => sortKey(a) - sortKey(b) || a.localeCompare(b));
}

export const ALL_WAKE_WORDS = buildUnifiedWakeWordList();
export const DEFAULT_WAKE_WORD = "alexa";

export function engineBadge(engine: WakeWordEngine): string {
	if (engine === "composite") {
		return "2x";
	}
	if (engine === "openwakeword") {
		return "OWW";
	}
	return "PVP";
}

export function buildWakeWordOptions(): SelectOption[] {
	return ALL_WAKE_WORDS.map((word) => ({
		id: word,
		label: formatWakeWordLabel(word),
		badge: engineBadge(engineForKeyword(word)),
	}));
}

export function reconcileWakeWord(currentWord: string | undefined): string {
	if (currentWord && ALL_WAKE_WORDS.includes(currentWord)) {
		return currentWord;
	}
	return DEFAULT_WAKE_WORD;
}

export function recordingModePatch(
	value: "ptt" | "toggle" | "listen" | "wakeword",
	currentWakeWord: string | undefined
): Partial<GeneralSettings> {
	if (value !== "wakeword") {
		return { recordingMode: value };
	}
	const reconciled = reconcileWakeWord(currentWakeWord);
	if (reconciled === currentWakeWord) {
		return { recordingMode: value };
	}
	return { recordingMode: value, wakeWord: reconciled };
}

export function pickLocale(value: string, setLocale: (locale: Locale) => void): void {
	if (isLocale(value)) {
		setLocale(value);
	}
}

export const REDUCTION_STEPS = [20, 40, 60, 80, 100] as const;
export const DEFAULT_REDUCTION = 100;

export function reductionToIndex(pct: number): number {
	const idx = REDUCTION_STEPS.indexOf(pct as (typeof REDUCTION_STEPS)[number]);
	return idx === -1 ? REDUCTION_STEPS.length - 1 : idx;
}

export function indexToReduction(index: number): number {
	return REDUCTION_STEPS[index] ?? DEFAULT_REDUCTION;
}

export function reductionStepLabel(pct: number, t: GeneralT): string {
	return pct >= 100 ? t("systemAudioReductionMute") : `${pct}%`;
}

export function muteLevel(settings: GeneralSettings | undefined): number {
	return settings?.systemAudioReductionWhileDictating ?? 0;
}

export function muteEnabled(settings: GeneralSettings | undefined): boolean {
	return muteLevel(settings) > 0;
}

export const SENSITIVITY_STEPS = 20;

export function sensitivityFromIndex(idx: number): number {
	return Math.round((idx / SENSITIVITY_STEPS) * 100) / 100;
}

export function sensitivityToIndex(value: number): number {
	return Math.round(value * SENSITIVITY_STEPS);
}

export interface StartupFlags {
	autoStart: boolean;
	minimizeToTray: boolean;
	sendCrashReports: boolean;
	startMinimized: boolean;
}

export function readBoolFlag(value: boolean | undefined, fallback: boolean): boolean {
	return value ?? fallback;
}

export function readStartupFlags(general: GeneralSettings | undefined): StartupFlags {
	return {
		autoStart: readBoolFlag(general?.autoStart, false),
		startMinimized: readBoolFlag(general?.startMinimized, false),
		minimizeToTray: readBoolFlag(general?.minimizeToTray, true),
		sendCrashReports: readBoolFlag(general?.sendCrashReports, true),
	};
}

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

export type LiveTranscriptionDisplayValue = "none" | "in-app" | "in-pill" | "both";

export function isLiveTranscriptionDisplayValue(
	value: string
): value is LiveTranscriptionDisplayValue {
	return value === "none" || value === "in-app" || value === "in-pill" || value === "both";
}

export function liveOverlayDisabled(general: GeneralSettings | undefined): boolean {
	return !(general?.showRecordingOverlay ?? true);
}

export function needsOverlay(value: LiveTranscriptionDisplayValue): boolean {
	return value === "in-pill" || value === "both";
}

export function effectiveLiveDisplay(
	value: LiveTranscriptionDisplayValue,
	overlayDisabled: boolean
): LiveTranscriptionDisplayValue {
	return overlayDisabled && needsOverlay(value) ? "in-app" : value;
}

export function overlayTogglePatch(
	enabled: boolean,
	general: GeneralSettings | undefined
): Partial<GeneralSettings> {
	if (enabled) {
		return { showRecordingOverlay: true };
	}
	const current: LiveTranscriptionDisplayValue = general?.liveTranscriptionDisplay ?? "both";
	if (needsOverlay(current)) {
		return { showRecordingOverlay: false, liveTranscriptionDisplay: "in-app" };
	}
	return { showRecordingOverlay: false };
}

export function checkedOrFalseIfDisabled(disabled: boolean, value: boolean): boolean {
	return disabled ? false : value;
}

export function buildOverlayModeSwitcherOptions(t: GeneralT): SwitcherOption[] {
	return [
		{ value: "floating-bottom", label: t("overlayModeFloatingBottom") },
		{ value: "dynamic-island", label: t("overlayModeDynamicIsland") },
	];
}

export function buildLiveTranscriptionDisplayOptions(
	t: GeneralT,
	overlayDisabled: boolean
): readonly {
	value: LiveTranscriptionDisplayValue;
	label: string;
	disabled?: boolean;
}[] {
	return [
		{ value: "none", label: t("liveTranscriptionDisplayNone") },
		{ value: "in-app", label: t("liveTranscriptionDisplayInApp") },
		{ value: "in-pill", label: t("liveTranscriptionDisplayInPill"), disabled: overlayDisabled },
		{ value: "both", label: t("liveTranscriptionDisplayBoth"), disabled: overlayDisabled },
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

export function flagsToLiveDisplay(
	inApp: boolean,
	inOverlay: boolean
): LiveTranscriptionDisplayValue {
	if (inApp && inOverlay) {
		return "both";
	}
	if (inApp) {
		return "in-app";
	}
	if (inOverlay) {
		return "in-pill";
	}
	return "none";
}

export function pickVisualizerType(value: string, update: UpdateFn): void {
	if (isVisualizerType(value)) {
		update({ visualizerType: value });
	}
}

export function isBarVisualizer(general: GeneralSettings | undefined): boolean {
	const type = general?.visualizerType ?? "bar";
	return type === "bar";
}

export const __general_settings_panel_test_helpers__ = {
	buildVisualizerTypeOptions,
	buildRecordingModeOptions,
	pickLocale,
	muteLevel,
	muteEnabled,
	reductionToIndex,
	indexToReduction,
	reductionStepLabel,
	computeDisplayFlags,
	liveOverlayDisabled,
	needsOverlay,
	effectiveLiveDisplay,
	overlayTogglePatch,
	buildLiveTranscriptionDisplayOptions,
	isLiveTranscriptionDisplayValue,
	checkedOrFalseIfDisabled,
	pickVisualizerType,
	isBarVisualizer,
	readBoolFlag,
	readStartupFlags,
	recordingModePatch,
	reconcileWakeWord,
	engineForKeyword,
	engineBadge,
	formatWakeWordLabel,
	buildWakeWordOptions,
	buildUnifiedWakeWordList,
	sensitivityFromIndex,
	sensitivityToIndex,
	visualizerSizeFromIndex,
	visualizerSizeToIndex,
	VISUALIZER_SIZE_PRESETS,
	VISUALIZER_SIZE_LABELS,
	DEFAULT_WAKE_WORD,
	PORCUPINE_FREE_KEYWORDS,
	OPENWAKEWORD_KEYWORDS,
	ALL_WAKE_WORDS,
};
