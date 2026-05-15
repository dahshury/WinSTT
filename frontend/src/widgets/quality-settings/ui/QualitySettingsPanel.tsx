"use client";

import {
	Clock01Icon,
	EyeIcon,
	FileScriptIcon,
	SparklesIcon,
	SubtitleIcon,
	TextSquareIcon,
	Txt01Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

const TRANSCRIPTION_FORMAT_OPTIONS: readonly SwitcherOption<"txt" | "srt">[] = [
	{ value: "txt", label: "TXT", icon: Txt01Icon },
	{ value: "srt", label: "SRT", icon: SubtitleIcon },
] as const;

export function QualitySettingsPanel() {
	const q = useSettingsStore((s) => s.settings.quality);
	const update = useSettingsStore((s) => s.updateQualitySettings);
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("quality");
	const tg = useTranslations("general");

	const transcriptionFormat = general?.fileTranscriptionFormat ?? "txt";
	const contextAwarenessEnabled = general?.contextAwareness ?? false;
	const [contextDialogOpen, setContextDialogOpen] = useState(false);

	// Toggle ON ⇒ show the opt-in dialog and DON'T persist yet; the dialog's
	// confirm path is what actually flips the stored value. Toggle OFF ⇒
	// persist immediately (no consent needed to disable).
	const handleContextToggle = (next: boolean): void => {
		if (next) {
			setContextDialogOpen(true);
			return;
		}
		updateGeneral({ contextAwareness: false });
	};

	return (
		<div className="flex flex-col gap-2">
			{/* ── Smart Endpoint (visible only when realtime is enabled in Model tab) */}
			{(q?.enableRealtimeTranscription ?? true) && (
				<SettingSection icon={SparklesIcon} title={t("smartEndpoint")}>
					<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
						<FormControl
							caption={t("smartEndpointCaption")}
							label={t("smartEndpointLabel")}
							labelAddon={
								<Toggle
									checked={q?.smartEndpoint ?? false}
									onCheckedChange={(v) => update({ smartEndpoint: v })}
								/>
							}
							tooltip={t("smartEndpointTooltip")}
						/>
						{(q?.smartEndpoint ?? false) && (
							<FormControl
								caption={t("detectionSpeedCaption")}
								label={t("detectionSpeed")}
								tooltip={t("detectionSpeedTooltip")}
							>
								<NumberStepper
									max={3.0}
									min={0.5}
									onChange={(v) => update({ smartEndpointSpeed: v })}
									step={0.1}
									value={q?.smartEndpointSpeed ?? 1.5}
								/>
							</FormControl>
						)}
					</div>
				</SettingSection>
			)}

			{/* ── Timing ─────────────────────────────────────── */}
			<SettingSection icon={Clock01Icon} title={t("timing")}>
				<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
					<FormControl
						caption={t("earlyTranscriptionCaption")}
						label={t("earlyTranscription")}
						tooltip={t("earlyTranscriptionTooltip")}
					>
						<NumberStepper
							min={0}
							onChange={(v) => update({ earlyTranscriptionOnSilence: v })}
							step={0.1}
							value={q?.earlyTranscriptionOnSilence ?? 0.2}
						/>
					</FormControl>
				</div>
			</SettingSection>

			{/* ── Formatting ─────────────────────────────────── */}
			<SettingSection icon={TextSquareIcon} title={t("formatting")}>
				<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
					<FormControl
						caption={t("uppercaseFirstCaption")}
						label={t("uppercaseFirst")}
						labelAddon={
							<Toggle
								checked={q?.ensureSentenceStartingUppercase ?? true}
								onCheckedChange={(v) => update({ ensureSentenceStartingUppercase: v })}
							/>
						}
						tooltip={t("uppercaseFirstTooltip")}
					/>
					<FormControl
						caption={t("endWithPeriodCaption")}
						label={t("endWithPeriod")}
						labelAddon={
							<Toggle
								checked={q?.ensureSentenceEndsWithPeriod ?? true}
								onCheckedChange={(v) => update({ ensureSentenceEndsWithPeriod: v })}
							/>
						}
						tooltip={t("endWithPeriodTooltip")}
					/>
				</div>
			</SettingSection>

			{/* ── File Transcription ─────────────────────────── */}
			<SettingSection icon={FileScriptIcon} title={tg("fileTranscription")}>
				<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
					<FormControl
						caption={tg("fileTranscriptionFormatCaption")}
						label={tg("fileTranscriptionFormat")}
						tooltip={tg("fileTranscriptionFormatTooltip")}
					>
						<Switcher
							onChange={(v) => updateGeneral({ fileTranscriptionFormat: v })}
							options={TRANSCRIPTION_FORMAT_OPTIONS}
							value={transcriptionFormat}
						/>
					</FormControl>
				</div>
			</SettingSection>

			{/* ── Context Awareness ──────────────────────────── */}
			<SettingSection icon={EyeIcon} title={tg("contextAwarenessSection")}>
				<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
					<FormControl
						caption={tg("contextAwarenessCaption")}
						label={tg("contextAwareness")}
						tooltip={tg("contextAwarenessTooltip")}
					>
						<Toggle checked={contextAwarenessEnabled} onCheckedChange={handleContextToggle} />
					</FormControl>
				</div>
				<OptInDialog
					body={tg("contextAwarenessDialogBody")}
					cancelLabel={tg("contextAwarenessDialogCancel")}
					confirmLabel={tg("contextAwarenessDialogConfirm")}
					onCancel={() => updateGeneral({ contextAwareness: false })}
					onConfirm={() => updateGeneral({ contextAwareness: true })}
					onOpenChange={setContextDialogOpen}
					open={contextDialogOpen}
					title={tg("contextAwarenessDialogTitle")}
				/>
			</SettingSection>
		</div>
	);
}
