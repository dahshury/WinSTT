"use client";

import { AiMagicIcon, Clock01Icon, SparklesIcon, TextSquareIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Toggle } from "@/shared/ui/toggle";

export function QualitySettingsPanel() {
	const q = useSettingsStore((s) => s.settings.quality);
	const update = useSettingsStore((s) => s.updateQualitySettings);
	const t = useTranslations("quality");

	return (
		<div className="flex flex-col gap-5">
			{/* ── Realtime Preview (visible only when realtime is enabled in Model tab) */}
			{(q?.enableRealtimeTranscription ?? true) && (
				<SettingSection icon={AiMagicIcon} title={t("realtimePreview")}>
					<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
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
					</div>
				</SettingSection>
			)}

			{/* ── Smart Endpoint ─────────────────────────────── */}
			{(q?.enableRealtimeTranscription ?? true) && (
				<SettingSection icon={SparklesIcon} title={t("smartEndpoint")}>
					<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
						<FormControl
							caption={t("smartEndpointCaption")}
							label={t("smartEndpointLabel")}
							tooltip={t("smartEndpointTooltip")}
						>
							<Toggle
								checked={q?.smartEndpoint ?? false}
								onCheckedChange={(v) => update({ smartEndpoint: v })}
							/>
						</FormControl>
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
			<SettingSection icon={TextSquareIcon} title={t("formatting")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("uppercaseFirstCaption")}
						label={t("uppercaseFirst")}
						tooltip={t("uppercaseFirstTooltip")}
					>
						<Toggle
							checked={q?.ensureSentenceStartingUppercase ?? true}
							onCheckedChange={(v) => update({ ensureSentenceStartingUppercase: v })}
						/>
					</FormControl>
					<FormControl
						caption={t("endWithPeriodCaption")}
						label={t("endWithPeriod")}
						tooltip={t("endWithPeriodTooltip")}
					>
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
