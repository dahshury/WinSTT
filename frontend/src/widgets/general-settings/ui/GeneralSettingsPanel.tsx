"use client";

import {
	AiBeautifyIcon,
	AudioWave02Icon,
	BarChartIcon,
	DashboardCircleIcon,
	EarIcon,
	FileMusicIcon,
	GridIcon,
	Mic01Icon,
	MusicNote01Icon,
	PowerSocket01Icon,
	RadialIcon,
	RefreshIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { isVisualizerType } from "@/features/audio-visualizer";
import { useLoopbackDevices } from "@/features/listen-mode";
import { RECORDING_MODE_COLOR_HEX } from "@/shared/config/recording-mode-color";
import { isLocale, LOCALE_NAMES, LOCALES, type Locale, useLocaleStore } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/shared/ui/button-group";
import { FormControl } from "@/shared/ui/form-control";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";
import { Toggle } from "@/shared/ui/toggle";
import { Tooltip } from "@/shared/ui/tooltip";
import { useSoundFileDrop } from "../lib/use-sound-file-drop";

const MAX_DURATION_SECONDS = 3;

const LOCALE_BADGE: Record<Locale, string> = {
	en: "EN",
	zh: "中",
	es: "ES",
	hi: "हि",
	fr: "FR",
	ar: "ع",
};

const LANGUAGE_OPTIONS: SelectOption[] = LOCALES.map((code) => ({
	id: code,
	label: LOCALE_NAMES[code].native,
	badge: LOCALE_BADGE[code],
}));

type VisualizerSizePreset = "xs" | "sm" | "md" | "lg" | "xl";
const VISUALIZER_SIZE_OPTIONS = [
	{ value: "xs", label: "XS" },
	{ value: "sm", label: "S" },
	{ value: "md", label: "M" },
	{ value: "lg", label: "L" },
	{ value: "xl", label: "XL" },
] as const satisfies readonly { value: VisualizerSizePreset; label: string }[];

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type CommonT = ReturnType<typeof useTranslations<"common">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateFn = (patch: Partial<GeneralSettings>) => void;

function buildVisualizerTypeOptions(t: GeneralT): SelectOption[] {
	return [
		{ id: "bar", label: t("visualizerBar"), icon: BarChartIcon },
		{ id: "grid", label: t("visualizerGrid"), icon: GridIcon },
		{ id: "radial", label: t("visualizerRadial"), icon: RadialIcon },
		{ id: "wave", label: t("visualizerWave"), icon: AudioWave02Icon },
		{ id: "aura", label: t("visualizerAura"), icon: AiBeautifyIcon },
	] satisfies SelectOption[];
}

function buildRecordingModeOptions(t: GeneralT): readonly {
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

// Porcupine's free built-in keywords — the only words usable without a
// picovoice access key. The wake-word picker is constrained to this list
// because anything else fails at server boot.
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

function buildWakeWordOptions(): SelectOption[] {
	return PORCUPINE_FREE_KEYWORDS.map((word) => ({ id: word, label: word }));
}

function pickLocale(value: string, setLocale: (locale: Locale) => void): void {
	if (isLocale(value)) {
		setLocale(value);
	}
}

interface LoopbackControlProps {
	currentLoopbackId: string;
	handleLoopbackChange: (value: string) => void;
	loopbackOpts: SelectOption[];
	t: GeneralT;
}

function LoopbackControl({
	t,
	currentLoopbackId,
	loopbackOpts,
	handleLoopbackChange,
}: LoopbackControlProps): ReactNode {
	return (
		<FormControl
			caption={t("loopbackDeviceCaption")}
			label={t("loopbackDevice")}
			tooltip={t("loopbackDeviceTooltip")}
		>
			<Select onChange={handleLoopbackChange} options={loopbackOpts} value={currentLoopbackId} />
		</FormControl>
	);
}

function muteCaption(isListenMode: boolean, t: GeneralT): string {
	return isListenMode ? t("muteSystemAudioCaptionDisabled") : t("muteSystemAudioCaption");
}

// Slider stops, left → right, monotonically increasing reduction:
// 20% → 40% → 60% → 80% → Mute (100%). On/off is a separate toggle, so the
// slider only ever holds a "how aggressive" value. Stored value is the
// percent reduction; the slider works in index space.
const REDUCTION_STEPS = [20, 40, 60, 80, 100] as const;

// Value applied when the toggle is switched on. Full mute preserves the
// behaviour of the legacy boolean toggle and sits at the slider's top stop.
const DEFAULT_REDUCTION = 100;

function reductionToIndex(pct: number): number {
	const idx = REDUCTION_STEPS.indexOf(pct as (typeof REDUCTION_STEPS)[number]);
	return idx === -1 ? REDUCTION_STEPS.length - 1 : idx;
}

function indexToReduction(index: number): number {
	return REDUCTION_STEPS[index] ?? DEFAULT_REDUCTION;
}

function reductionStepLabel(pct: number, t: GeneralT): string {
	return pct >= 100 ? t("systemAudioReductionMute") : `${pct}%`;
}

function muteLevel(isListenMode: boolean, settings: GeneralSettings | undefined): number {
	if (isListenMode) {
		return 0;
	}
	return settings?.systemAudioReductionWhileDictating ?? 0;
}

function muteEnabled(isListenMode: boolean, settings: GeneralSettings | undefined): boolean {
	return muteLevel(isListenMode, settings) > 0;
}

interface MuteSystemAudioControlProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function MuteSystemAudioControl({
	general,
	isListenMode,
	t,
	update,
}: MuteSystemAudioControlProps): ReactNode {
	const level = muteLevel(isListenMode, general);
	const enabled = muteEnabled(isListenMode, general);
	return (
		<FormControl
			caption={muteCaption(isListenMode, t)}
			disabled={isListenMode}
			label={t("muteSystemAudio")}
			labelAddon={
				<Toggle
					checked={enabled}
					disabled={isListenMode}
					onCheckedChange={(v) =>
						update({ systemAudioReductionWhileDictating: v ? DEFAULT_REDUCTION : 0 })
					}
				/>
			}
			tooltip={t("muteSystemAudioTooltip")}
		>
			{enabled ? (
				<div className="flex items-center gap-2">
					<Slider
						aria-label={t("muteSystemAudio")}
						max={REDUCTION_STEPS.length - 1}
						min={0}
						onChange={(v) => update({ systemAudioReductionWhileDictating: indexToReduction(v) })}
						step={1}
						value={reductionToIndex(level)}
					/>
					<span className="w-12 text-right font-mono text-foreground-muted text-xs">
						{reductionStepLabel(level, t)}
					</span>
				</div>
			) : undefined}
		</FormControl>
	);
}

interface RecordingSectionProps {
	currentLoopbackId: string;
	general: GeneralSettings | undefined;
	handleLoopbackChange: (value: string) => void;
	isListenMode: boolean;
	loopbackOpts: SelectOption[];
	recordingMode: "ptt" | "toggle" | "listen" | "wakeword";
	t: GeneralT;
	update: UpdateFn;
}

interface WakeWordControlProps {
	t: GeneralT;
	update: UpdateFn;
	value: string;
}

function WakeWordControl({ t, value, update }: WakeWordControlProps): ReactNode {
	const options = buildWakeWordOptions();
	return (
		<FormControl
			caption={t("wakeWordCaption")}
			label={t("wakeWord")}
			tooltip={t("wakeWordTooltip")}
		>
			<Select
				aria-label={t("wakeWord")}
				onChange={(v) => update({ wakeWord: v })}
				options={options}
				value={value}
			/>
		</FormControl>
	);
}

function RecordingSection({
	t,
	general,
	recordingMode,
	isListenMode,
	update,
	loopbackOpts,
	currentLoopbackId,
	handleLoopbackChange,
}: RecordingSectionProps): ReactNode {
	const recordingModeOptions = buildRecordingModeOptions(t);
	return (
		<SettingSection icon={Mic01Icon} title={t("recording")}>
			<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
				<FormControl
					caption={t("recordingModeCaption")}
					className="col-span-2"
					label={t("recordingMode")}
					tooltip={t("recordingModeTooltip")}
				>
					<Switcher
						fullWidth
						onChange={(v) => update({ recordingMode: v })}
						options={recordingModeOptions}
						value={recordingMode}
					/>
				</FormControl>
				{recordingMode === "listen" ? (
					<LoopbackControl
						currentLoopbackId={currentLoopbackId}
						handleLoopbackChange={handleLoopbackChange}
						loopbackOpts={loopbackOpts}
						t={t}
					/>
				) : null}
				{recordingMode === "wakeword" ? (
					<WakeWordControl t={t} update={update} value={general?.wakeWord ?? ""} />
				) : null}
				<MuteSystemAudioControl
					general={general}
					isListenMode={isListenMode}
					t={t}
					update={update}
				/>
			</div>
		</SettingSection>
	);
}

interface SoundFileControlProps {
	dragOver: boolean;
	dropError: string | null;
	handleBrowse: () => void;
	handleReset: () => void;
	handlers: ReturnType<typeof useSoundFileDrop>["handlers"];
	recordingSoundPath: string;
	t: GeneralT;
	tc: CommonT;
}

function SoundFileResetButton({
	tc,
	handleReset,
}: {
	tc: CommonT;
	handleReset: () => void;
}): ReactNode {
	return (
		<Tooltip content={tc("reset")}>
			<Button
				aria-label={tc("reset")}
				className="border-border border-l bg-background px-3 py-1.5 text-foreground-dim transition-colors last:rounded-r hover:bg-surface-tertiary hover:text-foreground"
				onClick={handleReset}
			>
				<HugeiconsIcon icon={RefreshIcon} size={14} />
			</Button>
		</Tooltip>
	);
}

function dropZoneClass(dragOver: boolean): string {
	const accent = dragOver ? "border-accent bg-accent/10" : "border-transparent";
	return `rounded border border-dashed transition-colors ${accent}`;
}

function displaySoundPath(recordingSoundPath: string, t: GeneralT): string {
	return recordingSoundPath || t("soundFileDefault");
}

interface DropErrorMessageProps {
	dropError: string | null;
}

function DropErrorMessage({ dropError }: DropErrorMessageProps): ReactNode {
	if (!dropError) {
		return null;
	}
	return <p className="mt-1 text-error text-xs-tight">{dropError}</p>;
}

interface MaybeResetButtonProps {
	handleReset: () => void;
	recordingSoundPath: string;
	tc: CommonT;
}

function MaybeResetButton({
	tc,
	recordingSoundPath,
	handleReset,
}: MaybeResetButtonProps): ReactNode {
	if (!recordingSoundPath) {
		return null;
	}
	return <SoundFileResetButton handleReset={handleReset} tc={tc} />;
}

function SoundFileControl({
	t,
	tc,
	dragOver,
	dropError,
	recordingSoundPath,
	handlers,
	handleBrowse,
	handleReset,
}: SoundFileControlProps): ReactNode {
	return (
		<FormControl
			caption={t("soundFileCaption", { max: MAX_DURATION_SECONDS })}
			label={t("soundFile")}
			tooltip={t("soundFileTooltip")}
		>
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop zone needs drag events */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone needs drag events */}
			<div
				className={dropZoneClass(dragOver)}
				onDragLeave={handlers.onDragLeave}
				onDragOver={handlers.onDragOver}
				onDrop={handlers.onDrop}
			>
				<ButtonGroup aria-label={t("soundFile")} className="w-full">
					<ButtonGroupText className="min-w-0 flex-1">
						<span className="min-w-0 truncate">{displaySoundPath(recordingSoundPath, t)}</span>
					</ButtonGroupText>
					<Tooltip content={tc("browse")}>
						<Button
							aria-label={tc("browse")}
							className="bg-background px-3 py-1.5 text-accent transition-colors last:rounded-r hover:bg-surface-tertiary"
							onClick={handleBrowse}
						>
							<HugeiconsIcon icon={FileMusicIcon} size={14} />
						</Button>
					</Tooltip>
					<MaybeResetButton
						handleReset={handleReset}
						recordingSoundPath={recordingSoundPath}
						tc={tc}
					/>
				</ButtonGroup>
			</div>
			<DropErrorMessage dropError={dropError} />
		</FormControl>
	);
}

function soundToggleChecked(isListenMode: boolean, recordingSoundEnabled: boolean): boolean {
	return isListenMode ? false : recordingSoundEnabled;
}

interface SoundSectionProps {
	dragOver: boolean;
	dropError: string | null;
	handleBrowse: () => void;
	handleReset: () => void;
	handlers: ReturnType<typeof useSoundFileDrop>["handlers"];
	isListenMode: boolean;
	recordingSoundEnabled: boolean;
	recordingSoundPath: string;
	t: GeneralT;
	tc: CommonT;
	update: UpdateFn;
}

function SoundSection({
	t,
	tc,
	isListenMode,
	recordingSoundEnabled,
	recordingSoundPath,
	update,
	dragOver,
	dropError,
	handlers,
	handleBrowse,
	handleReset,
}: SoundSectionProps): ReactNode {
	return (
		<SettingSection
			icon={MusicNote01Icon}
			onToggle={(v) => update({ recordingSound: v })}
			title={t("recordingSound")}
			toggleDisabled={isListenMode}
			toggled={soundToggleChecked(isListenMode, recordingSoundEnabled)}
		>
			<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
				<SoundFileControl
					dragOver={dragOver}
					dropError={dropError}
					handleBrowse={handleBrowse}
					handleReset={handleReset}
					handlers={handlers}
					recordingSoundPath={recordingSoundPath}
					t={t}
					tc={tc}
				/>
			</div>
		</SettingSection>
	);
}

interface StartupSectionProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

interface StartupFlags {
	autoStart: boolean;
	minimizeToTray: boolean;
	startMinimized: boolean;
}

function readBoolFlag(value: boolean | undefined, fallback: boolean): boolean {
	return value ?? fallback;
}

function readStartupFlags(general: GeneralSettings | undefined): StartupFlags {
	return {
		autoStart: readBoolFlag(general?.autoStart, false),
		startMinimized: readBoolFlag(general?.startMinimized, false),
		minimizeToTray: readBoolFlag(general?.minimizeToTray, true),
	};
}

function StartupSection({ t, general, update }: StartupSectionProps): ReactNode {
	const flags = readStartupFlags(general);
	return (
		<SettingSection icon={PowerSocket01Icon} title={t("startup")}>
			<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
				<FormControl
					caption={t("startOnLoginCaption")}
					label={t("startOnLogin")}
					labelAddon={
						<Toggle checked={flags.autoStart} onCheckedChange={(v) => update({ autoStart: v })} />
					}
					tooltip={t("startOnLoginTooltip")}
				/>
				<FormControl
					caption={t("startMinimizedCaption")}
					label={t("startMinimized")}
					labelAddon={
						<Toggle
							checked={flags.startMinimized}
							onCheckedChange={(v) => update({ startMinimized: v })}
						/>
					}
					tooltip={t("startMinimizedTooltip")}
				/>
				<FormControl
					caption={t("minimizeToTrayCaption")}
					label={t("minimizeToTray")}
					labelAddon={
						<Toggle
							checked={flags.minimizeToTray}
							onCheckedChange={(v) => update({ minimizeToTray: v })}
						/>
					}
					tooltip={t("minimizeToTrayTooltip")}
				/>
			</div>
		</SettingSection>
	);
}

export function GeneralSettingsPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");
	const tc = useTranslations("common");

	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";

	const {
		options: loopbackOpts,
		currentId: currentLoopbackId,
		handleChange: handleLoopbackChange,
	} = useLoopbackDevices();

	const { dragOver, dropError, handlers, handleBrowse, handleReset } = useSoundFileDrop({
		update,
		t,
	});

	const visualizerTypeOptions = buildVisualizerTypeOptions(t);

	const recordingSoundEnabled = general?.recordingSound ?? true;
	const recordingSoundPath = general?.recordingSoundPath ?? "";

	return (
		<div className="flex flex-col gap-2">
			<DisplaySection
				isListenMode={isListenMode}
				locale={locale}
				setLocale={setLocale}
				t={t}
				update={update}
				visualizerTypeOptions={visualizerTypeOptions}
			/>
			<RecordingSection
				currentLoopbackId={currentLoopbackId}
				general={general}
				handleLoopbackChange={handleLoopbackChange}
				isListenMode={isListenMode}
				loopbackOpts={loopbackOpts}
				recordingMode={recordingMode}
				t={t}
				update={update}
			/>
			<SoundSection
				dragOver={dragOver}
				dropError={dropError}
				handleBrowse={handleBrowse}
				handleReset={handleReset}
				handlers={handlers}
				isListenMode={isListenMode}
				recordingSoundEnabled={recordingSoundEnabled}
				recordingSoundPath={recordingSoundPath}
				t={t}
				tc={tc}
				update={update}
			/>
			<StartupSection general={general} t={t} update={update} />
		</div>
	);
}

interface DisplaySectionProps {
	isListenMode: boolean;
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: GeneralT;
	update: UpdateFn;
	visualizerTypeOptions: SelectOption[];
}

interface LanguageControlProps {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: GeneralT;
}

function LanguageControl({ locale, setLocale, t }: LanguageControlProps): ReactNode {
	return (
		<FormControl
			caption={t("languageCaption")}
			label={t("language")}
			tooltip={t("languageTooltip")}
		>
			<Select
				onChange={(v) => pickLocale(v, setLocale)}
				options={LANGUAGE_OPTIONS}
				value={locale}
			/>
		</FormControl>
	);
}

interface DisplayFlags {
	liveDisplayDisabled: boolean;
	overlayEnabled: boolean;
	subDisabled: boolean;
}

function computeDisplayFlags(
	isListenMode: boolean,
	general: GeneralSettings | undefined,
	realtimeEnabled: boolean
): DisplayFlags {
	const showOverlay = general?.showRecordingOverlay ?? true;
	const overlayEnabled = !isListenMode && showOverlay;
	const subDisabled = !overlayEnabled;
	// The combined live-transcription picker as a whole is disabled only when
	// realtime transcription itself is off. Individual overlay-dependent
	// choices (in-overlay/both) are disabled separately when the recording
	// overlay is hidden — see liveOverlayDisabled / buildLiveTranscriptionDisplayOptions.
	const liveDisplayDisabled = !realtimeEnabled;
	return { overlayEnabled, subDisabled, liveDisplayDisabled };
}

type LiveTranscriptionDisplayValue = "none" | "in-app" | "in-pill" | "both";

function isLiveTranscriptionDisplayValue(value: string): value is LiveTranscriptionDisplayValue {
	return value === "none" || value === "in-app" || value === "in-pill" || value === "both";
}

// The "in-overlay" and "both" choices render the live preview under the
// floating recording overlay, so they only make sense when that overlay is
// enabled. When it isn't, those options are disabled and any previously
// selected one collapses to "in-app".
function liveOverlayDisabled(general: GeneralSettings | undefined): boolean {
	return !(general?.showRecordingOverlay ?? true);
}

function needsOverlay(value: LiveTranscriptionDisplayValue): boolean {
	return value === "in-pill" || value === "both";
}

function effectiveLiveDisplay(
	value: LiveTranscriptionDisplayValue,
	overlayDisabled: boolean
): LiveTranscriptionDisplayValue {
	return overlayDisabled && needsOverlay(value) ? "in-app" : value;
}

// Patch applied when the recording-overlay toggle flips. Turning the overlay
// off also collapses an overlay-dependent live-display choice down to
// "in-app" in the same update so the picker can't keep an impossible value.
function overlayTogglePatch(
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

function checkedOrFalseIfDisabled(disabled: boolean, value: boolean): boolean {
	return disabled ? false : value;
}

interface OverlayControlProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	subDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function OverlayControl({
	t,
	isListenMode,
	subDisabled,
	general,
	update,
}: OverlayControlProps): ReactNode {
	const showOverlay = general?.showRecordingOverlay ?? true;
	const size = general?.visualizerSize ?? "sm";
	return (
		<FormControl
			caption={t("showRecordingOverlayCaption")}
			disabled={isListenMode}
			label={t("showRecordingOverlay")}
			labelAddon={
				<Toggle
					checked={checkedOrFalseIfDisabled(isListenMode, showOverlay)}
					disabled={isListenMode}
					onCheckedChange={(v) => update(overlayTogglePatch(v, general))}
				/>
			}
			tooltip={t("showRecordingOverlayTooltip")}
		>
			<div className={subDisabled ? "pointer-events-none opacity-40" : ""}>
				<Switcher
					onChange={(v) => update({ visualizerSize: v })}
					options={VISUALIZER_SIZE_OPTIONS}
					value={size}
				/>
			</div>
		</FormControl>
	);
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

interface LiveTranscriptionDisplayControlProps {
	general: GeneralSettings | undefined;
	liveDisplayDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function LiveTranscriptionDisplayControl({
	t,
	liveDisplayDisabled,
	general,
	update,
}: LiveTranscriptionDisplayControlProps): ReactNode {
	const overlayDisabled = liveOverlayDisabled(general);
	const stored: LiveTranscriptionDisplayValue = general?.liveTranscriptionDisplay ?? "both";
	const value = effectiveLiveDisplay(stored, overlayDisabled);
	const options = buildLiveTranscriptionDisplayOptions(t, overlayDisabled);
	return (
		<FormControl
			caption={t("liveTranscriptionDisplayCaption")}
			disabled={liveDisplayDisabled}
			label={t("liveTranscriptionDisplay")}
			tooltip={t("liveTranscriptionDisplayTooltip")}
		>
			<div className={liveDisplayDisabled ? "pointer-events-none opacity-40" : ""}>
				<Switcher
					onChange={(v) => {
						if (isLiveTranscriptionDisplayValue(v) && !(overlayDisabled && needsOverlay(v))) {
							update({ liveTranscriptionDisplay: v });
						}
					}}
					options={options}
					value={value}
				/>
			</div>
		</FormControl>
	);
}

function pickVisualizerType(value: string, update: UpdateFn): void {
	if (isVisualizerType(value)) {
		update({ visualizerType: value });
	}
}

interface VisualizerTypeControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
	visualizerTypeOptions: SelectOption[];
}

function VisualizerTypeControl({
	t,
	general,
	update,
	visualizerTypeOptions,
}: VisualizerTypeControlProps): ReactNode {
	const value = general?.visualizerType ?? "bar";
	const color = general?.visualizerColor ?? "#58a6ff";
	return (
		<FormControl
			caption={t("visualizerTypeCaption")}
			label={t("visualizerType")}
			tooltip={t("visualizerTypeTooltip")}
		>
			<div className="flex items-center gap-2">
				<div className="flex-1">
					<Select
						onChange={(v) => pickVisualizerType(v, update)}
						options={visualizerTypeOptions}
						value={value}
					/>
				</div>
				<TextField
					aria-label={t("visualizerColor")}
					className="h-8 w-12 shrink-0 cursor-pointer p-0"
					onChange={(e) => update({ visualizerColor: e.target.value })}
					title={t("visualizerColorTooltip")}
					type="color"
					value={color}
				/>
			</div>
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
	const value = general?.visualizerBarCount ?? 9;
	return (
		<FormControl
			caption={t("visualizerBarCountCaption")}
			label={t("visualizerBarCount")}
			tooltip={t("visualizerBarCountTooltip")}
		>
			<div className="flex items-center gap-2">
				<Slider
					max={21}
					min={3}
					onChange={(v) => update({ visualizerBarCount: v })}
					step={2}
					value={value}
				/>
				<span className="w-12 text-right font-mono text-foreground-muted text-xs">{value}</span>
			</div>
		</FormControl>
	);
}

function isBarVisualizer(general: GeneralSettings | undefined): boolean {
	const type = general?.visualizerType ?? "bar";
	return type === "bar";
}

function DisplaySection({
	isListenMode,
	locale,
	setLocale,
	t,
	update,
	visualizerTypeOptions,
}: DisplaySectionProps) {
	const general = useSettingsStore((s) => s.settings.general);
	const realtimeEnabled = useSettingsStore(
		(s) => s.settings.quality?.enableRealtimeTranscription ?? true
	);
	const flags = computeDisplayFlags(isListenMode, general, realtimeEnabled);

	return (
		<SettingSection icon={DashboardCircleIcon} title={t("display")}>
			<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
				<LanguageControl locale={locale} setLocale={setLocale} t={t} />
				<OverlayControl
					general={general}
					isListenMode={isListenMode}
					subDisabled={flags.subDisabled}
					t={t}
					update={update}
				/>
				<LiveTranscriptionDisplayControl
					general={general}
					liveDisplayDisabled={flags.liveDisplayDisabled}
					t={t}
					update={update}
				/>
				<VisualizerTypeControl
					general={general}
					t={t}
					update={update}
					visualizerTypeOptions={visualizerTypeOptions}
				/>
				{isBarVisualizer(general) ? (
					<VisualizerBarCountControl general={general} t={t} update={update} />
				) : null}
			</div>
		</SettingSection>
	);
}

export const __general_settings_panel_test_helpers__ = {
	buildVisualizerTypeOptions,
	buildRecordingModeOptions,
	pickLocale,
	muteCaption,
	muteLevel,
	muteEnabled,
	reductionToIndex,
	indexToReduction,
	reductionStepLabel,
	soundToggleChecked,
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
	dropZoneClass,
	displaySoundPath,
	readBoolFlag,
	readStartupFlags,
};
