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
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
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

	const visualizerTypeOptions = [
		{ id: "bar", label: t("visualizerBar"), icon: BarChartIcon },
		{ id: "grid", label: t("visualizerGrid"), icon: GridIcon },
		{ id: "radial", label: t("visualizerRadial"), icon: RadialIcon },
		{ id: "wave", label: t("visualizerWave"), icon: AudioWave02Icon },
		{ id: "aura", label: t("visualizerAura"), icon: AiBeautifyIcon },
	] satisfies SelectOption[];

	const recordingModeOptions = [
		{ value: "ptt", label: t("pushToTalk"), icon: TouchInteraction01Icon },
		{ value: "toggle", label: t("toggle"), icon: ToggleOnIcon },
		{ value: "listen", label: t("listen"), icon: EarIcon },
	] as const;

	const transcriptionFormatOptions = [
		{ value: "txt", label: "TXT", icon: Txt01Icon },
		{ value: "srt", label: "SRT", icon: SubtitleIcon },
	] as const;

	const recordingSoundEnabled = general?.recordingSound ?? true;
	const recordingSoundPath = general?.recordingSoundPath ?? "";

	return (
		<div className="flex flex-col gap-5">
			{/* ── Language ─────────────────────────────────────── */}
			<SettingSection icon={GlobeIcon} title={t("language")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("languageCaption")}
						label={t("language")}
						tooltip={t("languageTooltip")}
					>
						<Select
							onChange={(v) => {
								if (isLocale(v)) {
									setLocale(v);
								}
							}}
							options={LANGUAGE_OPTIONS}
							value={locale}
						/>
					</FormControl>
				</div>
			</SettingSection>

			{/* ── Recording ────────────────────────────────────── */}
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
					{recordingMode === "listen" && (
						<FormControl
							caption={t("loopbackDeviceCaption")}
							label={t("loopbackDevice")}
							tooltip={t("loopbackDeviceTooltip")}
						>
							<Select
								onChange={handleLoopbackChange}
								options={loopbackOpts}
								value={currentLoopbackId}
							/>
						</FormControl>
					)}
					<FormControl
						caption={
							isListenMode ? t("muteSystemAudioCaptionDisabled") : t("muteSystemAudioCaption")
						}
						disabled={isListenMode}
						label={t("muteSystemAudio")}
						tooltip={t("muteSystemAudioTooltip")}
					>
						<Toggle
							checked={isListenMode ? false : (general?.muteSystemAudioWhileDictating ?? false)}
							disabled={isListenMode}
							onCheckedChange={(v) => update({ muteSystemAudioWhileDictating: v })}
						/>
					</FormControl>
				</div>
			</SettingSection>

			{/* ── Display ──────────────────────────────────────── */}
			<DisplaySection
				isListenMode={isListenMode}
				t={t}
				update={update}
				visualizerTypeOptions={visualizerTypeOptions}
			/>

			{/* ── Sound ─────────────────────────────────────────── */}
			<SettingSection
				icon={MusicNote01Icon}
				onToggle={(v) => update({ recordingSound: v })}
				title={t("sound")}
				toggleDisabled={isListenMode}
				toggled={isListenMode ? false : recordingSoundEnabled}
			>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("soundFileCaption", { max: MAX_DURATION_SECONDS })}
						label={t("soundFile")}
						tooltip={t("soundFileTooltip")}
					>
						{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop zone needs drag events */}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone needs drag events */}
						<div
							className={`rounded border border-dashed transition-colors ${
								dragOver ? "border-accent bg-accent/10" : "border-transparent"
							}`}
							onDragLeave={handlers.onDragLeave}
							onDragOver={handlers.onDragOver}
							onDrop={handlers.onDrop}
						>
							<ButtonGroup aria-label={t("soundFile")} className="w-full">
								<ButtonGroupText className="min-w-0 flex-1">
									<span className="min-w-0 truncate">
										{recordingSoundPath || t("soundFileDefault")}
									</span>
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
								{recordingSoundPath && (
									<Tooltip content={tc("reset")}>
										<Button
											aria-label={tc("reset")}
											className="border-border border-l bg-background px-3 py-1.5 text-foreground-dim transition-colors last:rounded-r hover:bg-surface-tertiary hover:text-foreground"
											onClick={handleReset}
										>
											<HugeiconsIcon icon={RefreshIcon} size={14} />
										</Button>
									</Tooltip>
								)}
							</ButtonGroup>
						</div>
						{dropError && <p className="mt-1 text-error text-xs-tight">{dropError}</p>}
					</FormControl>
				</div>
			</SettingSection>

			{/* ── File Transcription ───────────────────────────── */}
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
							value={general?.fileTranscriptionFormat ?? "txt"}
						/>
					</FormControl>
				</div>
			</SettingSection>

			{/* ── Startup ──────────────────────────────────────── */}
			<SettingSection icon={PowerSocket01Icon} title={t("startup")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("startOnLoginCaption")}
						label={t("startOnLogin")}
						tooltip={t("startOnLoginTooltip")}
					>
						<Toggle
							checked={general?.autoStart ?? false}
							onCheckedChange={(v) => update({ autoStart: v })}
						/>
					</FormControl>
					<FormControl
						caption={t("startMinimizedCaption")}
						label={t("startMinimized")}
						tooltip={t("startMinimizedTooltip")}
					>
						<Toggle
							checked={general?.startMinimized ?? false}
							onCheckedChange={(v) => update({ startMinimized: v })}
						/>
					</FormControl>
					<FormControl
						caption={t("minimizeToTrayCaption")}
						label={t("minimizeToTray")}
						tooltip={t("minimizeToTrayTooltip")}
					>
						<Toggle
							checked={general?.minimizeToTray ?? true}
							onCheckedChange={(v) => update({ minimizeToTray: v })}
						/>
					</FormControl>
				</div>
			</SettingSection>
		</div>
	);
}

interface DisplaySectionProps {
	isListenMode: boolean;
	t: ReturnType<typeof useTranslations<"general">>;
	update: (patch: Partial<NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]["general"]>>) => void;
	visualizerTypeOptions: SelectOption[];
}

function DisplaySection({ isListenMode, t, update, visualizerTypeOptions }: DisplaySectionProps) {
	const general = useSettingsStore((s) => s.settings.general);
	const overlayEnabled = !isListenMode && (general?.showRecordingOverlay ?? true);
	const subDisabled = !overlayEnabled;

	return (
		<SettingSection icon={DashboardCircleIcon} title={t("display")}>
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption={t("showRecordingOverlayCaption")}
					disabled={isListenMode}
					label={t("showRecordingOverlay")}
					tooltip={t("showRecordingOverlayTooltip")}
				>
					<Toggle
						checked={isListenMode ? false : (general?.showRecordingOverlay ?? true)}
						disabled={isListenMode}
						onCheckedChange={(v) => update({ showRecordingOverlay: v })}
					/>
				</FormControl>
				<FormControl
					caption={t("showLiveTranscriptionCaption")}
					disabled={subDisabled}
					label={t("showLiveTranscription")}
					tooltip={t("showLiveTranscriptionTooltip")}
				>
					<Toggle
						checked={subDisabled ? false : (general?.showLiveTranscription ?? true)}
						disabled={subDisabled}
						onCheckedChange={(v) => update({ showLiveTranscription: v })}
					/>
				</FormControl>
				<FormControl
					caption={t("visualizerSizeCaption")}
					disabled={subDisabled}
					label={t("visualizerSize")}
					tooltip={t("visualizerSizeTooltip")}
				>
					<div className="flex items-center gap-2">
						<Slider
							disabled={subDisabled}
							max={200}
							min={10}
							onChange={(v) => update({ visualizerSize: v })}
							step={2}
							value={general?.visualizerSize ?? 20}
						/>
						<span className="w-12 text-right font-mono text-foreground-muted text-xs">
							{general?.visualizerSize ?? 20}px
						</span>
					</div>
				</FormControl>
				<FormControl
					caption={t("visualizerTypeCaption")}
					label={t("visualizerType")}
					tooltip={t("visualizerTypeTooltip")}
				>
					<Select
						onChange={(v) => {
							if (isVisualizerType(v)) {
								update({ visualizerType: v });
							}
						}}
						options={visualizerTypeOptions}
						value={general?.visualizerType ?? "bar"}
					/>
				</FormControl>
				{(general?.visualizerType ?? "bar") === "bar" && (
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
								value={general?.visualizerBarCount ?? 9}
							/>
							<span className="w-12 text-right font-mono text-foreground-muted text-xs">
								{general?.visualizerBarCount ?? 9}
							</span>
						</div>
					</FormControl>
				)}
				<FormControl
					caption={t("visualizerColorCaption")}
					label={t("visualizerColor")}
					tooltip={t("visualizerColorTooltip")}
				>
					<TextField
						className="h-8 w-12 cursor-pointer p-0"
						onChange={(e) => update({ visualizerColor: e.target.value })}
						type="color"
						value={general?.visualizerColor ?? "#58a6ff"}
					/>
				</FormControl>
			</div>
		</SettingSection>
	);
}
