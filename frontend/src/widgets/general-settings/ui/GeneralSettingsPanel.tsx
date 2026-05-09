"use client";

import {
	AiBeautifyIcon,
	AudioWave02Icon,
	BarChartIcon,
	DashboardCircleIcon,
	EarIcon,
	FileMusicIcon,
	FileScriptIcon,
	GlobeIcon,
	GridIcon,
	Mic01Icon,
	MusicNote01Icon,
	PowerSocket01Icon,
	RadialIcon,
	RefreshIcon,
	SubtitleIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	Txt01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { isVisualizerType } from "@/features/audio-visualizer";
import { useLoopbackDevices } from "@/features/listen-mode";
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

function buildRecordingModeOptions(
	t: GeneralT
): readonly { value: "ptt" | "toggle" | "listen"; label: string; icon: IconSvgElement }[] {
	return [
		{ value: "ptt", label: t("pushToTalk"), icon: TouchInteraction01Icon },
		{ value: "toggle", label: t("toggle"), icon: ToggleOnIcon },
		{ value: "listen", label: t("listen"), icon: EarIcon },
	] as const;
}

function buildTranscriptionFormatOptions(
	_t: GeneralT
): readonly { value: "txt" | "srt"; label: string; icon: IconSvgElement }[] {
	return [
		{ value: "txt", label: "TXT", icon: Txt01Icon },
		{ value: "srt", label: "SRT", icon: SubtitleIcon },
	] as const;
}

function pickLocale(value: string, setLocale: (locale: Locale) => void): void {
	if (isLocale(value)) {
		setLocale(value);
	}
}

interface LanguageSectionProps {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: GeneralT;
}

function LanguageSection({ locale, setLocale, t }: LanguageSectionProps): ReactNode {
	return (
		<SettingSection icon={GlobeIcon} title={t("language")}>
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
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
			</div>
		</SettingSection>
	);
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

function muteChecked(isListenMode: boolean, settings: GeneralSettings | undefined): boolean {
	if (isListenMode) {
		return false;
	}
	return settings?.muteSystemAudioWhileDictating ?? false;
}

interface RecordingSectionProps {
	currentLoopbackId: string;
	general: GeneralSettings | undefined;
	handleLoopbackChange: (value: string) => void;
	isListenMode: boolean;
	loopbackOpts: SelectOption[];
	recordingMode: "ptt" | "toggle" | "listen";
	t: GeneralT;
	update: UpdateFn;
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
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption={t("recordingModeCaption")}
					label={t("recordingMode")}
					tooltip={t("recordingModeTooltip")}
				>
					<Switcher
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
				<FormControl
					caption={muteCaption(isListenMode, t)}
					disabled={isListenMode}
					label={t("muteSystemAudio")}
					tooltip={t("muteSystemAudioTooltip")}
				>
					<Toggle
						checked={muteChecked(isListenMode, general)}
						disabled={isListenMode}
						onCheckedChange={(v) => update({ muteSystemAudioWhileDictating: v })}
					/>
				</FormControl>
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
			title={t("sound")}
			toggleDisabled={isListenMode}
			toggled={soundToggleChecked(isListenMode, recordingSoundEnabled)}
		>
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
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

interface FileTranscriptionSectionProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function FileTranscriptionSection({
	t,
	general,
	update,
}: FileTranscriptionSectionProps): ReactNode {
	const transcriptionFormatOptions = buildTranscriptionFormatOptions(t);
	const value = general?.fileTranscriptionFormat ?? "txt";
	return (
		<SettingSection icon={FileScriptIcon} title={t("fileTranscription")}>
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption={t("fileTranscriptionFormatCaption")}
					label={t("fileTranscriptionFormat")}
					tooltip={t("fileTranscriptionFormatTooltip")}
				>
					<Switcher
						onChange={(v) => update({ fileTranscriptionFormat: v })}
						options={transcriptionFormatOptions}
						value={value}
					/>
				</FormControl>
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
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption={t("startOnLoginCaption")}
					label={t("startOnLogin")}
					tooltip={t("startOnLoginTooltip")}
				>
					<Toggle checked={flags.autoStart} onCheckedChange={(v) => update({ autoStart: v })} />
				</FormControl>
				<FormControl
					caption={t("startMinimizedCaption")}
					label={t("startMinimized")}
					tooltip={t("startMinimizedTooltip")}
				>
					<Toggle
						checked={flags.startMinimized}
						onCheckedChange={(v) => update({ startMinimized: v })}
					/>
				</FormControl>
				<FormControl
					caption={t("minimizeToTrayCaption")}
					label={t("minimizeToTray")}
					tooltip={t("minimizeToTrayTooltip")}
				>
					<Toggle
						checked={flags.minimizeToTray}
						onCheckedChange={(v) => update({ minimizeToTray: v })}
					/>
				</FormControl>
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
		<div className="flex flex-col gap-5">
			<LanguageSection locale={locale} setLocale={setLocale} t={t} />
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
			<DisplaySection
				isListenMode={isListenMode}
				t={t}
				update={update}
				visualizerTypeOptions={visualizerTypeOptions}
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
			<FileTranscriptionSection general={general} t={t} update={update} />
			<StartupSection general={general} t={t} update={update} />
		</div>
	);
}

interface DisplaySectionProps {
	isListenMode: boolean;
	t: GeneralT;
	update: UpdateFn;
	visualizerTypeOptions: SelectOption[];
}

interface DisplayFlags {
	inAppLiveDisabled: boolean;
	overlayEnabled: boolean;
	pillLiveDisabled: boolean;
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
	const pillLiveDisabled = subDisabled || !realtimeEnabled;
	const inAppLiveDisabled = !realtimeEnabled;
	return { overlayEnabled, subDisabled, pillLiveDisabled, inAppLiveDisabled };
}

function checkedOrFalseIfDisabled(disabled: boolean, value: boolean): boolean {
	return disabled ? false : value;
}

interface OverlayToggleProps {
	general: GeneralSettings | undefined;
	isListenMode: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function OverlayToggle({ t, isListenMode, general, update }: OverlayToggleProps): ReactNode {
	const showOverlay = general?.showRecordingOverlay ?? true;
	return (
		<FormControl
			caption={t("showRecordingOverlayCaption")}
			disabled={isListenMode}
			label={t("showRecordingOverlay")}
			tooltip={t("showRecordingOverlayTooltip")}
		>
			<Toggle
				checked={checkedOrFalseIfDisabled(isListenMode, showOverlay)}
				disabled={isListenMode}
				onCheckedChange={(v) => update({ showRecordingOverlay: v })}
			/>
		</FormControl>
	);
}

interface PillLiveToggleProps {
	general: GeneralSettings | undefined;
	pillLiveDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function PillLiveToggle({ t, pillLiveDisabled, general, update }: PillLiveToggleProps): ReactNode {
	const value = general?.showLiveTranscription ?? true;
	return (
		<FormControl
			caption={t("showLiveTranscriptionCaption")}
			disabled={pillLiveDisabled}
			label={t("showLiveTranscription")}
			tooltip={t("showLiveTranscriptionTooltip")}
		>
			<Toggle
				checked={checkedOrFalseIfDisabled(pillLiveDisabled, value)}
				disabled={pillLiveDisabled}
				onCheckedChange={(v) => update({ showLiveTranscription: v })}
			/>
		</FormControl>
	);
}

interface InAppLiveToggleProps {
	general: GeneralSettings | undefined;
	inAppLiveDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function InAppLiveToggle({
	t,
	inAppLiveDisabled,
	general,
	update,
}: InAppLiveToggleProps): ReactNode {
	const value = general?.showInAppLiveTranscription ?? true;
	return (
		<FormControl
			caption={t("showInAppLiveTranscriptionCaption")}
			disabled={inAppLiveDisabled}
			label={t("showInAppLiveTranscription")}
			tooltip={t("showInAppLiveTranscriptionTooltip")}
		>
			<Toggle
				checked={checkedOrFalseIfDisabled(inAppLiveDisabled, value)}
				disabled={inAppLiveDisabled}
				onCheckedChange={(v) => update({ showInAppLiveTranscription: v })}
			/>
		</FormControl>
	);
}

interface VisualizerSizeControlProps {
	general: GeneralSettings | undefined;
	subDisabled: boolean;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerSizeControl({
	t,
	subDisabled,
	general,
	update,
}: VisualizerSizeControlProps): ReactNode {
	const value = general?.visualizerSize ?? "sm";
	return (
		<FormControl
			caption={t("visualizerSizeCaption")}
			disabled={subDisabled}
			label={t("visualizerSize")}
			tooltip={t("visualizerSizeTooltip")}
		>
			<Switcher
				onChange={(v) => update({ visualizerSize: v })}
				options={VISUALIZER_SIZE_OPTIONS}
				value={value}
			/>
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
	return (
		<FormControl
			caption={t("visualizerTypeCaption")}
			label={t("visualizerType")}
			tooltip={t("visualizerTypeTooltip")}
		>
			<Select
				onChange={(v) => pickVisualizerType(v, update)}
				options={visualizerTypeOptions}
				value={value}
			/>
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

interface VisualizerColorControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateFn;
}

function VisualizerColorControl({ t, general, update }: VisualizerColorControlProps): ReactNode {
	const value = general?.visualizerColor ?? "#58a6ff";
	return (
		<FormControl
			caption={t("visualizerColorCaption")}
			label={t("visualizerColor")}
			tooltip={t("visualizerColorTooltip")}
		>
			<TextField
				className="h-8 w-12 cursor-pointer p-0"
				onChange={(e) => update({ visualizerColor: e.target.value })}
				type="color"
				value={value}
			/>
		</FormControl>
	);
}

function isBarVisualizer(general: GeneralSettings | undefined): boolean {
	const type = general?.visualizerType ?? "bar";
	return type === "bar";
}

function DisplaySection({ isListenMode, t, update, visualizerTypeOptions }: DisplaySectionProps) {
	const general = useSettingsStore((s) => s.settings.general);
	const realtimeEnabled = useSettingsStore(
		(s) => s.settings.quality?.enableRealtimeTranscription ?? true
	);
	const flags = computeDisplayFlags(isListenMode, general, realtimeEnabled);

	return (
		<SettingSection icon={DashboardCircleIcon} title={t("display")}>
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<OverlayToggle general={general} isListenMode={isListenMode} t={t} update={update} />
				<PillLiveToggle
					general={general}
					pillLiveDisabled={flags.pillLiveDisabled}
					t={t}
					update={update}
				/>
				<InAppLiveToggle
					general={general}
					inAppLiveDisabled={flags.inAppLiveDisabled}
					t={t}
					update={update}
				/>
				<VisualizerSizeControl
					general={general}
					subDisabled={flags.subDisabled}
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
				<VisualizerColorControl general={general} t={t} update={update} />
			</div>
		</SettingSection>
	);
}

export const __general_settings_panel_test_helpers__ = {
	buildVisualizerTypeOptions,
	buildRecordingModeOptions,
	buildTranscriptionFormatOptions,
	pickLocale,
	muteCaption,
	muteChecked,
	soundToggleChecked,
	computeDisplayFlags,
	checkedOrFalseIfDisabled,
	pickVisualizerType,
	isBarVisualizer,
	dropZoneClass,
	displaySoundPath,
	readBoolFlag,
	readStartupFlags,
};
