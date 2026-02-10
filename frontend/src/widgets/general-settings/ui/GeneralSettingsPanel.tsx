"use client";

import { useTranslations } from "next-intl";
import { SettingSection } from "@/entities/setting";
import { useLoopbackDevices } from "@/features/listen-mode";
import { useSettingsStore } from "@/features/update-settings";
import { LOCALE_NAMES, LOCALES, type Locale, useLocaleStore } from "@/shared/i18n";
import { FormControl } from "@/shared/ui/form-control";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { useSoundFileDrop } from "../lib/use-sound-file-drop";

const MAX_DURATION_SECONDS = 3;

const LANGUAGE_OPTIONS: SelectOption[] = LOCALES.map((code) => ({
	id: code,
	label: LOCALE_NAMES[code].native,
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

	const recordingModeOptions = [
		{ value: "ptt", label: t("pushToTalk") },
		{ value: "toggle", label: t("toggle") },
		{ value: "listen", label: t("listen") },
	] as const;

	const transcriptionFormatOptions = [
		{ value: "txt", label: "TXT" },
		{ value: "srt", label: "SRT" },
	] as const;

	const recordingSoundEnabled = general?.recordingSound ?? true;
	const recordingSoundPath = general?.recordingSoundPath ?? "";

	return (
		<div className="flex flex-col gap-5">
			{/* ── Language ─────────────────────────────────────── */}
			<SettingSection title={t("language")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl caption={t("languageCaption")} label={t("language")}>
						<Select
							onChange={(v) => setLocale(v as Locale)}
							options={LANGUAGE_OPTIONS}
							value={locale}
						/>
					</FormControl>
				</div>
			</SettingSection>

			{/* ── Recording ────────────────────────────────────── */}
			<SettingSection title={t("recording")}>
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

			{/* ── Sound ─────────────────────────────────────────── */}
			<SettingSection
				onToggle={(v) => update({ recordingSound: v })}
				title={t("sound")}
				toggleDisabled={isListenMode}
				toggled={isListenMode ? false : recordingSoundEnabled}
			>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("soundFileCaption", { max: MAX_DURATION_SECONDS })}
						label={t("soundFile")}
					>
						{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop zone needs drag events */}
						<section
							aria-label={t("soundFile")}
							className={`flex items-center gap-2 rounded border border-dashed p-1.5 transition-colors ${
								dragOver ? "border-accent bg-accent/10" : "border-transparent"
							}`}
							onDragLeave={handlers.onDragLeave}
							onDragOver={handlers.onDragOver}
							onDrop={handlers.onDrop}
						>
							<span className="min-w-0 flex-1 truncate text-[12px] text-foreground-dim">
								{recordingSoundPath || t("soundFileDefault")}
							</span>
							<button
								className="shrink-0 rounded px-2 py-0.5 text-[11px] text-accent hover:bg-surface-tertiary"
								onClick={handleBrowse}
								type="button"
							>
								{tc("browse")}
							</button>
							{recordingSoundPath && (
								<button
									className="shrink-0 rounded px-2 py-0.5 text-[11px] text-foreground-dim hover:bg-surface-tertiary hover:text-foreground"
									onClick={handleReset}
									type="button"
								>
									{tc("reset")}
								</button>
							)}
						</section>
						{dropError && <p className="mt-1 text-[11px] text-error">{dropError}</p>}
					</FormControl>
				</div>
			</SettingSection>

			{/* ── File Transcription ───────────────────────────── */}
			<SettingSection title={t("fileTranscription")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("fileTranscriptionFormatCaption")}
						label={t("fileTranscriptionFormat")}
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
			<SettingSection title={t("startup")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl caption={t("startOnLoginCaption")} label={t("startOnLogin")}>
						<Toggle
							checked={general?.autoStart ?? false}
							onCheckedChange={(v) => update({ autoStart: v })}
						/>
					</FormControl>
					<FormControl caption={t("startMinimizedCaption")} label={t("startMinimized")}>
						<Toggle
							checked={general?.startMinimized ?? false}
							onCheckedChange={(v) => update({ startMinimized: v })}
						/>
					</FormControl>
					<FormControl caption={t("minimizeToTrayCaption")} label={t("minimizeToTray")}>
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
