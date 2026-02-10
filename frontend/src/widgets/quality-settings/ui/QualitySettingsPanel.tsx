"use client";

import { useTranslations } from "next-intl";
import { SettingSection } from "@/entities/setting";
import { useSettingsStore } from "@/features/update-settings";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Toggle } from "@/shared/ui/toggle";

export function QualitySettingsPanel() {
	const q = useSettingsStore((s) => s.settings.quality);
	const update = useSettingsStore((s) => s.updateQualitySettings);
	const t = useTranslations("quality");

	return (
		<div className="flex flex-col gap-5">
			{/* ── Realtime Preview ────────────────────────────── */}
			<SettingSection title={t("realtimePreview")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("enableRealtimeCaption")}
						label={t("enableRealtime")}
						tooltip={t("enableRealtimeTooltip")}
					>
						<Toggle
							checked={q?.enableRealtimeTranscription ?? true}
							onCheckedChange={(v) => update({ enableRealtimeTranscription: v })}
						/>
					</FormControl>
					{(q?.enableRealtimeTranscription ?? true) && (
						<>
							<FormControl
								caption={t("useMainModelCaption")}
								label={t("useMainModel")}
								tooltip={t("useMainModelTooltip")}
							>
								<Toggle
									checked={q?.useMainModelForRealtime ?? false}
									onCheckedChange={(v) => update({ useMainModelForRealtime: v })}
								/>
							</FormControl>
							<FormControl
								caption={t("updateIntervalCaption")}
								label={t("updateInterval")}
								tooltip={t("updateIntervalTooltip")}
							>
								<NumberStepper
									min={0.01}
									onChange={(v) => update({ realtimeProcessingPause: v })}
									step={0.01}
									value={q?.realtimeProcessingPause ?? 0.02}
								/>
							</FormControl>
						</>
					)}
				</div>
			</SettingSection>

			{/* ── Timing ─────────────────────────────────────── */}
			<SettingSection title={t("timing")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
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
			<SettingSection title={t("formatting")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl caption={t("uppercaseFirstCaption")} label={t("uppercaseFirst")}>
						<Toggle
							checked={q?.ensureSentenceStartingUppercase ?? true}
							onCheckedChange={(v) => update({ ensureSentenceStartingUppercase: v })}
						/>
					</FormControl>
					<FormControl caption={t("endWithPeriodCaption")} label={t("endWithPeriod")}>
						<Toggle
							checked={q?.ensureSentenceEndsWithPeriod ?? true}
							onCheckedChange={(v) => update({ ensureSentenceEndsWithPeriod: v })}
						/>
					</FormControl>
				</div>
			</SettingSection>
		</div>
	);
}
