import { VoiceIdIcon } from "@hugeicons/core-free-icons";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Slider } from "@/shared/ui/slider";
import type {
	AudioSettings,
	AudioT,
	UpdateAudioFn,
} from "./recording-settings-types";

interface VadSectionProps {
	audio: AudioSettings | undefined;
	ta: AudioT;
	updateAudio: UpdateAudioFn;
}

export function VadSection({ audio, ta, updateAudio }: VadSectionProps) {
	return (
		<SettingSection
			icon={VoiceIdIcon}
			onToggle={(v) => updateAudio({ sileroDeactivityDetection: v })}
			title={ta("vad")}
			toggled={audio?.sileroDeactivityDetection ?? true}
		>
			<div className="flex flex-col">
				<SettingField
					isDefault={
						(audio?.sileroSensitivity ??
							DEFAULT_SETTINGS.audio.sileroSensitivity) ===
						DEFAULT_SETTINGS.audio.sileroSensitivity
					}
					label={ta("sileroSensitivity")}
					onReset={() =>
						updateAudio({
							sileroSensitivity: DEFAULT_SETTINGS.audio.sileroSensitivity,
						})
					}
					tooltip={ta("sileroSensitivityTooltip")}
				>
					<Slider
						aria-label={ta("sileroSensitivity")}
						formatValue={(v) => v.toFixed(2)}
						max={1}
						min={0}
						onChange={(v) => updateAudio({ sileroSensitivity: v })}
						step={0.05}
						value={
							audio?.sileroSensitivity ??
							DEFAULT_SETTINGS.audio.sileroSensitivity
						}
					/>
				</SettingField>
				<SettingField
					isDefault={
						(audio?.webrtcSensitivity ??
							DEFAULT_SETTINGS.audio.webrtcSensitivity) ===
						DEFAULT_SETTINGS.audio.webrtcSensitivity
					}
					label={ta("webrtcSensitivity")}
					onReset={() =>
						updateAudio({
							webrtcSensitivity: DEFAULT_SETTINGS.audio.webrtcSensitivity,
						})
					}
					tooltip={ta("webrtcSensitivityTooltip")}
				>
					<Slider
						aria-label={ta("webrtcSensitivity")}
						max={3}
						min={0}
						onChange={(v) => updateAudio({ webrtcSensitivity: v })}
						step={1}
						value={
							audio?.webrtcSensitivity ??
							DEFAULT_SETTINGS.audio.webrtcSensitivity
						}
					/>
				</SettingField>
				<SettingField
					isDefault={
						(audio?.postSpeechSilenceDuration ??
							DEFAULT_SETTINGS.audio.postSpeechSilenceDuration) ===
						DEFAULT_SETTINGS.audio.postSpeechSilenceDuration
					}
					label={ta("postSpeechSilence")}
					layout="row"
					onReset={() =>
						updateAudio({
							postSpeechSilenceDuration:
								DEFAULT_SETTINGS.audio.postSpeechSilenceDuration,
						})
					}
					tooltip={ta("postSpeechSilenceTooltip")}
				>
					<NumberStepper
						min={0.1}
						onChange={(v) => updateAudio({ postSpeechSilenceDuration: v })}
						step={0.1}
						value={
							audio?.postSpeechSilenceDuration ??
							DEFAULT_SETTINGS.audio.postSpeechSilenceDuration
						}
					/>
				</SettingField>
			</div>
		</SettingSection>
	);
}
