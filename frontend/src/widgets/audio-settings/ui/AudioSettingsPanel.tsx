"use client";

import { SettingSection } from "@/entities/setting";
import { useSettingsStore } from "@/features/update-settings";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Slider } from "@/shared/ui/slider";
import { Toggle } from "@/shared/ui/toggle";

export function AudioSettingsPanel() {
	const audio = useSettingsStore((s) => s.settings.audio);
	const update = useSettingsStore((s) => s.updateAudioSettings);

	return (
		<SettingSection title="Voice Activity Detection">
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption="0 = less sensitive, 1 = more sensitive"
					label="Silero Sensitivity"
					tooltip="Silero VAD uses a neural network to detect speech. Lower values require louder/clearer speech to trigger recording. Higher values detect quieter speech but may trigger on background noise."
				>
					<div className="flex items-center gap-2">
						<Slider
							max={1}
							min={0}
							onChange={(v) => update({ sileroSensitivity: v })}
							step={0.05}
							value={audio?.sileroSensitivity ?? 0.05}
						/>
						<span className="w-10 text-right font-mono text-foreground-muted text-xs">
							{(audio?.sileroSensitivity ?? 0.05).toFixed(2)}
						</span>
					</div>
				</FormControl>
				<FormControl
					caption="0-3, higher = less sensitive"
					label="WebRTC Sensitivity"
					tooltip="WebRTC VAD provides a second layer of voice detection. Level 0 is most sensitive (detects quiet speech), level 3 is least sensitive (only loud, clear speech). Works together with Silero for more reliable detection."
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
				<FormControl
					caption="Seconds of silence to end recording"
					label="Post-Speech Silence"
					tooltip="How long to wait after you stop speaking before ending the recording. Shorter values feel more responsive but may cut off pauses between sentences. Increase if your speech gets clipped."
				>
					<NumberStepper
						min={0.1}
						onChange={(v) => update({ postSpeechSilenceDuration: v })}
						step={0.1}
						value={audio?.postSpeechSilenceDuration ?? 0.7}
					/>
				</FormControl>
				<FormControl
					caption="Minimum seconds for valid recording"
					label="Min Recording Length"
					tooltip="Recordings shorter than this are discarded as noise. Prevents accidental triggers like coughs, clicks, or brief sounds from being transcribed."
				>
					<NumberStepper
						min={0.1}
						onChange={(v) => update({ minLengthOfRecording: v })}
						step={0.1}
						value={audio?.minLengthOfRecording ?? 1.1}
					/>
				</FormControl>
				<FormControl
					caption="Use Silero for end-of-speech"
					label="Silero Deactivity"
					tooltip="Uses the Silero neural network to detect when speech ends, instead of relying only on energy-based silence detection. More accurate at finding natural speech endings but uses slightly more processing power."
				>
					<Toggle
						checked={audio?.sileroDeactivityDetection ?? true}
						onCheckedChange={(v) => update({ sileroDeactivityDetection: v })}
					/>
				</FormControl>
			</div>
		</SettingSection>
	);
}
