"use client";

import { useTranslations } from "next-intl";
import type { DragEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { SettingSection } from "@/entities/setting";
import { useSettingsStore } from "@/features/update-settings";
import { dialogOpenFile, getFilePath, loopbackListDevices } from "@/shared/api/ipc-client";
import { LOCALE_NAMES, LOCALES, type Locale, useLocaleStore } from "@/shared/i18n";
import { FormControl } from "@/shared/ui/form-control";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

interface LoopbackDevice {
	index: number;
	name: string;
	defaultSampleRate: number;
	maxOutputChannels: number;
	isDefault?: boolean;
}

const ACCEPTED_EXTENSIONS = ["wav", "mp3"];
const MAX_DURATION_SECONDS = 3;

async function getAudioDuration(file: File): Promise<number> {
	const buffer = await file.arrayBuffer();
	const ctx = new AudioContext();
	try {
		const audioBuffer = await ctx.decodeAudioData(buffer);
		return audioBuffer.duration;
	} finally {
		await ctx.close();
	}
}

function hasValidExtension(name: string): boolean {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return ACCEPTED_EXTENSIONS.includes(ext);
}

const LANGUAGE_OPTIONS: SelectOption[] = LOCALES.map((code) => ({
	id: code,
	label: LOCALE_NAMES[code].native,
}));

export function GeneralSettingsPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const [loopbackOpts, setLoopbackOpts] = useState<SelectOption[]>([]);
	const [defaultLoopbackIndex, setDefaultLoopbackIndex] = useState<number | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const [dropError, setDropError] = useState("");
	const t = useTranslations("general");
	const tc = useTranslations("common");

	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";

	const recordingModeOptions = [
		{ value: "ptt", label: t("pushToTalk") },
		{ value: "toggle", label: t("toggle") },
		{ value: "listen", label: t("listen") },
	] as const;

	const transcriptionFormatOptions = [
		{ value: "txt", label: "TXT" },
		{ value: "srt", label: "SRT" },
	] as const;

	// Fetch loopback devices directly via IPC when in listen mode
	useEffect(() => {
		if (recordingMode !== "listen") {
			return;
		}
		loopbackListDevices()
			.then((devices) => {
				if (!Array.isArray(devices)) {
					return;
				}
				const typed = devices as LoopbackDevice[];
				const defaultDev = typed.find((d) => d.isDefault);
				const defaultLabel = defaultDev ? `System Default (${defaultDev.name})` : "System Default";
				const defIdx = defaultDev?.index ?? null;
				setDefaultLoopbackIndex(defIdx);

				const opts: SelectOption[] = [
					{ id: "default", label: defaultLabel },
					...typed.map((d) => ({ id: String(d.index), label: d.name })),
				];
				setLoopbackOpts(opts);

				// Auto-select default device if none chosen yet
				if (general?.loopbackDeviceIndex == null && defIdx != null) {
					update({ loopbackDeviceIndex: defIdx });
				}
			})
			.catch((err: unknown) => {
				console.warn("[GeneralSettings] Failed to fetch loopback devices:", err);
			});
	}, [recordingMode, general?.loopbackDeviceIndex, update]);

	const recordingSoundEnabled = general?.recordingSound ?? true;
	const recordingSoundPath = general?.recordingSoundPath ?? "";

	const handleBrowseSound = async () => {
		const filePath = await dialogOpenFile(
			[{ name: "Audio", extensions: ["wav", "mp3"] }],
			"Select Recording Sound"
		);
		if (filePath) {
			update({ recordingSoundPath: filePath });
			setDropError("");
		}
	};

	const handleResetSound = () => {
		update({ recordingSoundPath: "" });
		setDropError("");
	};

	const handleDrop = useCallback(
		async (e: DragEvent<HTMLDivElement>) => {
			e.preventDefault();
			setDragOver(false);
			setDropError("");

			const file = e.dataTransfer.files[0];
			if (!file) {
				return;
			}

			if (!hasValidExtension(file.name)) {
				setDropError(t("soundFileDropError"));
				return;
			}

			try {
				const duration = await getAudioDuration(file);
				if (duration > MAX_DURATION_SECONDS) {
					setDropError(
						t("soundFileTooLong", { max: MAX_DURATION_SECONDS, duration: duration.toFixed(1) })
					);
					return;
				}
			} catch {
				setDropError(t("soundFileUnreadable"));
				return;
			}

			const filePath = getFilePath(file);
			if (filePath) {
				update({ recordingSoundPath: filePath });
			}
		},
		[update, t]
	);

	const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setDragOver(true);
	}, []);

	const handleDragLeave = useCallback(() => {
		setDragOver(false);
	}, []);

	// Show "System Default" when the selected device matches the default, or when none selected
	const currentLoopbackId =
		general?.loopbackDeviceIndex == null || general.loopbackDeviceIndex === defaultLoopbackIndex
			? "default"
			: String(general.loopbackDeviceIndex);

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
								onChange={(v) =>
									update({
										loopbackDeviceIndex: v === "default" ? defaultLoopbackIndex : Number(v),
									})
								}
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
			<SettingSection title={t("sound")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={isListenMode ? t("recordingSoundCaptionDisabled") : t("recordingSoundCaption")}
						disabled={isListenMode}
						label={t("recordingSound")}
					>
						<Toggle
							checked={isListenMode ? false : recordingSoundEnabled}
							disabled={isListenMode}
							onCheckedChange={(v) => update({ recordingSound: v })}
						/>
					</FormControl>
					{recordingSoundEnabled && !isListenMode && (
						<FormControl
							caption={t("soundFileCaption", { max: MAX_DURATION_SECONDS })}
							label={t("soundFile")}
						>
							{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop zone needs drag events */}
							{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone needs drag events */}
							<div
								className={`flex items-center gap-2 rounded border border-dashed p-1.5 transition-colors ${
									dragOver ? "border-accent bg-accent/10" : "border-transparent"
								}`}
								onDragLeave={handleDragLeave}
								onDragOver={handleDragOver}
								onDrop={handleDrop}
							>
								<span className="min-w-0 flex-1 truncate text-[12px] text-foreground-dim">
									{recordingSoundPath || t("soundFileDefault")}
								</span>
								<button
									className="shrink-0 rounded px-2 py-0.5 text-[11px] text-accent hover:bg-surface-tertiary"
									onClick={handleBrowseSound}
									type="button"
								>
									{tc("browse")}
								</button>
								{recordingSoundPath && (
									<button
										className="shrink-0 rounded px-2 py-0.5 text-[11px] text-foreground-dim hover:bg-surface-tertiary hover:text-foreground"
										onClick={handleResetSound}
										type="button"
									>
										{tc("reset")}
									</button>
								)}
							</div>
							{dropError && <p className="mt-1 text-[11px] text-red-400">{dropError}</p>}
						</FormControl>
					)}
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
