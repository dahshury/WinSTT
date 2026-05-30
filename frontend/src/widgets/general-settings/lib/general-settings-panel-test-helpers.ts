import {
	AiBeautifyIcon,
	AudioWave02Icon,
	BarChartIcon,
	EarIcon,
	GridIcon,
	LayoutBottomIcon,
	PictureInPictureOnIcon,
	RadialIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { useTranslations } from "use-intl";
import type { useSettingsStore } from "@/entities/setting";
import { isVisualizerType, type VisualizerType } from "@/features/audio-visualizer";
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

function buildVisualizerTypeOptions(t: GeneralT): SelectOption[] {
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
		{ value: "bar", label: t("visualizerBar"), icon: BarChartIcon, preview: "viz-bar" },
		{ value: "grid", label: t("visualizerGrid"), icon: GridIcon, preview: "viz-grid" },
		{ value: "radial", label: t("visualizerRadial"), icon: RadialIcon, preview: "viz-radial" },
		{ value: "wave", label: t("visualizerWave"), icon: AudioWave02Icon, preview: "viz-wave" },
		{ value: "aura", label: t("visualizerAura"), icon: AiBeautifyIcon, preview: "viz-aura" },
	];
}

export function buildRecordingModeOptions(t: GeneralT): readonly {
	value: "ptt" | "toggle" | "listen" | "wakeword";
	label: string;
	icon: IconSvgElement;
	color: string;
	preview: "ptt" | "toggle" | "listen" | "wakeword";
}[] {
	return [
		{
			value: "ptt",
			label: t("pushToTalk"),
			icon: TouchInteraction01Icon,
			color: RECORDING_MODE_COLOR_HEX.ptt,
			preview: "ptt",
		},
		{
			value: "toggle",
			label: t("toggle"),
			icon: ToggleOnIcon,
			color: RECORDING_MODE_COLOR_HEX.toggle,
			preview: "toggle",
		},
		{
			value: "listen",
			label: t("listen"),
			icon: EarIcon,
			color: RECORDING_MODE_COLOR_HEX.listen,
			preview: "listen",
		},
		{
			value: "wakeword",
			label: t("wakeWord"),
			icon: VoiceIcon,
			color: RECORDING_MODE_COLOR_HEX.wakeword,
			preview: "wakeword",
		},
	] as const;
}

const PORCUPINE_FREE_KEYWORDS = [
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

const OPENWAKEWORD_KEYWORDS = [
	"alexa",
	"hey_jarvis",
	"hey_mycroft",
	"hey_rhasspy",
	"timer",
	"weather",
] as const;

type WakeWordEngine = "porcupine" | "openwakeword" | "composite";

const PORCUPINE_KEYWORD_SET: ReadonlySet<string> = new Set<string>(PORCUPINE_FREE_KEYWORDS);
const OPENWAKEWORD_KEYWORD_SET: ReadonlySet<string> = new Set<string>(OPENWAKEWORD_KEYWORDS);

function classifyEngine(inPorc: boolean, inOww: boolean): WakeWordEngine {
	const key = `${inPorc ? "1" : "0"}${inOww ? "1" : "0"}` as "00" | "01" | "10" | "11";
	const table: Record<"00" | "01" | "10" | "11", WakeWordEngine> = {
		"00": "porcupine",
		"01": "openwakeword",
		"10": "porcupine",
		"11": "composite",
	};
	return table[key];
}

function engineForKeyword(word: string): WakeWordEngine {
	return classifyEngine(PORCUPINE_KEYWORD_SET.has(word), OPENWAKEWORD_KEYWORD_SET.has(word));
}

function formatWakeWordLabel(word: string): string {
	return word.replace(/_/g, " ");
}

function buildUnifiedWakeWordList(): readonly string[] {
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

const ALL_WAKE_WORDS = buildUnifiedWakeWordList();
export const DEFAULT_WAKE_WORD = "alexa";

function engineBadge(engine: WakeWordEngine): string {
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

function isKnownWakeWord(word: string | undefined): word is string {
	return word !== undefined && ALL_WAKE_WORDS.includes(word);
}

function reconcileWakeWord(currentWord: string | undefined): string {
	return isKnownWakeWord(currentWord) ? currentWord : DEFAULT_WAKE_WORD;
}

function wakeWordPatch(
	currentWakeWord: string | undefined,
	reconciled: string
): Partial<GeneralSettings> {
	return reconciled === currentWakeWord
		? { recordingMode: "wakeword" }
		: { recordingMode: "wakeword", wakeWord: reconciled };
}

export function recordingModePatch(
	value: "ptt" | "toggle" | "listen" | "wakeword",
	currentWakeWord: string | undefined
): Partial<GeneralSettings> {
	return value === "wakeword"
		? wakeWordPatch(currentWakeWord, reconcileWakeWord(currentWakeWord))
		: { recordingMode: value };
}

export function pickLocale(value: string, setLocale: (locale: Locale) => void): void {
	if (isLocale(value)) {
		setLocale(value);
	}
}

export const REDUCTION_STEPS = [0, 20, 40, 60, 80, 100] as const;
export const DEFAULT_REDUCTION = 100;

export function reductionToIndex(pct: number): number {
	const idx = REDUCTION_STEPS.indexOf(pct as (typeof REDUCTION_STEPS)[number]);
	return idx === -1 ? 0 : idx;
}

export function indexToReduction(index: number): number {
	return REDUCTION_STEPS[index] ?? 0;
}

export function reductionStepLabel(pct: number, t: GeneralT): string {
	if (pct <= 0) {
		return t("systemAudioReductionOff");
	}
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

function readBoolFlag(value: boolean | undefined, fallback: boolean): boolean {
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

const LIVE_TRANSCRIPTION_DISPLAY_VALUES: Record<LiveTranscriptionDisplayValue, true> = {
	none: true,
	"in-app": true,
	"in-pill": true,
	both: true,
};

function isLiveTranscriptionDisplayValue(value: string): value is LiveTranscriptionDisplayValue {
	return Object.hasOwn(LIVE_TRANSCRIPTION_DISPLAY_VALUES, value);
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

export function checkedOrFalseIfDisabled(disabled: boolean, value: boolean): boolean {
	return disabled ? false : value;
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

function buildLiveTranscriptionDisplayOptions(
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

export function isBarVisualizer(general: GeneralSettings | undefined): boolean {
	const type = general?.visualizerType ?? "bar";
	return type === "bar";
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
	overlaySliderToIndex,
	overlaySliderMax,
	overlaySliderPatch,
	overlaySliderLabel,
	buildLiveTranscriptionDisplayOptions,
	isLiveTranscriptionDisplayValue,
	checkedOrFalseIfDisabled,
	pickVisualizerType,
	isBarVisualizer,
	getVisualizerType,
	buildAuraShapeSwitcherOptions,
	pickAuraShape,
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
