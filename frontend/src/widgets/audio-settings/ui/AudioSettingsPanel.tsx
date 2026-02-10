"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { SettingSection } from "@/entities/setting";
import { useSettingsStore } from "@/features/update-settings";
import { audioGetDevices } from "@/shared/api/ipc-client";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Toggle } from "@/shared/ui/toggle";

export function AudioSettingsPanel() {
	const audio = useSettingsStore((s) => s.settings.audio);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const update = useSettingsStore((s) => s.updateAudioSettings);
	const t = useTranslations("audio");
	const [deviceOptions, setDeviceOptions] = useState<SelectOption[]>([
		{ id: "default", label: t("systemDefault") },
	]);

	useEffect(() => {
		audioGetDevices().then((devices) => {
			const defaultDevice = devices.find((d) => d.isDefault);
			const defaultLabel = defaultDevice
				? `${t("systemDefault")} (${defaultDevice.name})`
				: t("systemDefault");
			const opts: SelectOption[] = [{ id: "default", label: defaultLabel }];
			for (const d of devices) {
				opts.push({ id: String(d.index), label: d.name });
			}
			setDeviceOptions(opts);
		});
	}, [t]);

	const currentDeviceId =
		audio?.inputDeviceIndex == null ? "default" : String(audio.inputDeviceIndex);

	return (
		<div className="flex flex-col gap-5">
			{/* ── Input Device (hidden in Listen mode — loopback device is used instead) */}
			{recordingMode !== "listen" && (
				<SettingSection title={t("inputDevice")}>
					<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
						<FormControl
							caption={t("deviceCaption")}
							label={t("device")}
							tooltip={t("deviceTooltip")}
						>
							<Select
								onChange={(v) =>
									update({
										inputDeviceIndex: v === "default" ? null : Number.parseInt(v, 10),
									})
								}
								options={deviceOptions}
								value={currentDeviceId}
							/>
						</FormControl>
					</div>
				</SettingSection>
			)}

			{/* ── Voice Activity Detection ─────────────────────── */}
			<SettingSection title={t("vad")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("sileroDeactivityCaption")}
						label={t("sileroDeactivity")}
						tooltip={t("sileroDeactivityTooltip")}
					>
						<Toggle
							checked={audio?.sileroDeactivityDetection ?? true}
							onCheckedChange={(v) => update({ sileroDeactivityDetection: v })}
						/>
					</FormControl>
					<FormControl
						caption={t("sileroSensitivityCaption")}
						label={t("sileroSensitivity")}
						tooltip={t("sileroSensitivityTooltip")}
					>
						<div className="flex items-center gap-2">
							<Slider
								max={1}
								min={0}
								onChange={(v) => update({ sileroSensitivity: v })}
								step={0.05}
								value={audio?.sileroSensitivity ?? 0.4}
							/>
							<span className="w-10 text-right font-mono text-foreground-muted text-xs">
								{(audio?.sileroSensitivity ?? 0.4).toFixed(2)}
							</span>
						</div>
					</FormControl>
					<FormControl
						caption={t("webrtcSensitivityCaption")}
						label={t("webrtcSensitivity")}
						tooltip={t("webrtcSensitivityTooltip")}
					>
						<div className="flex items-center gap-2">
							<Slider
								max={3}
								min={0}
								onChange={(v) => update({ webrtcSensitivity: v })}
								step={1}
								value={audio?.webrtcSensitivity ?? 3}
							/>
							<span className="w-10 text-right font-mono text-foreground-muted text-xs">
								{audio?.webrtcSensitivity ?? 3}
							</span>
						</div>
					</FormControl>
					{(recordingMode === "toggle" || recordingMode === "listen") && (
						<FormControl
							caption={t("postSpeechSilenceCaption")}
							label={t("postSpeechSilence")}
							tooltip={t("postSpeechSilenceTooltip")}
						>
							<NumberStepper
								min={0.1}
								onChange={(v) => update({ postSpeechSilenceDuration: v })}
								step={0.1}
								value={audio?.postSpeechSilenceDuration ?? 0.7}
							/>
						</FormControl>
					)}
					<FormControl
						caption={t("minRecordingLengthCaption")}
						label={t("minRecordingLength")}
						tooltip={t("minRecordingLengthTooltip")}
					>
						<NumberStepper
							min={0.1}
							onChange={(v) => update({ minLengthOfRecording: v })}
							step={0.1}
							value={audio?.minLengthOfRecording ?? 1.1}
						/>
					</FormControl>
				</div>
			</SettingSection>
		</div>
	);
}
