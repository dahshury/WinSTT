"use client";

import { SettingSection } from "@/entities/setting";
import { useSettingsStore } from "@/features/update-settings";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Toggle } from "@/shared/ui/toggle";

export function QualitySettingsPanel() {
	const q = useSettingsStore((s) => s.settings.quality);
	const update = useSettingsStore((s) => s.updateQualitySettings);

	return (
		<SettingSection title="Processing">
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption="Show live transcription preview"
					label="Enable Realtime"
					tooltip="Shows a live transcription preview that updates as you speak. The preview uses a smaller, faster model, and the final result uses the main model for better accuracy."
				>
					<Toggle
						checked={q?.enableRealtimeTranscription ?? true}
						onCheckedChange={(v) => update({ enableRealtimeTranscription: v })}
					/>
				</FormControl>
				<FormControl
					caption="Higher quality but slower"
					label="Use Main Model for Realtime"
					tooltip="Use the larger, more accurate main model for live preview instead of the smaller realtime model. Gives better live text but significantly increases CPU/GPU usage and may cause lag on slower hardware."
				>
					<Toggle
						checked={q?.useMainModelForRealtime ?? false}
						onCheckedChange={(v) => update({ useMainModelForRealtime: v })}
					/>
				</FormControl>
				<FormControl
					caption="Seconds between realtime updates"
					label="Processing Pause"
					tooltip="Minimum time between live transcription updates. Lower values give more frequent updates but use more processing power. Increase if you experience stuttering or high CPU usage during dictation."
				>
					<NumberStepper
						min={0.01}
						onChange={(v) => update({ realtimeProcessingPause: v })}
						step={0.01}
						value={q?.realtimeProcessingPause ?? 0.02}
					/>
				</FormControl>
				<FormControl
					caption="Seconds of silence to start early"
					label="Early Transcription"
					tooltip="Begin transcribing before you've fully stopped speaking, triggered after this many seconds of silence. Reduces the delay between speaking and seeing the final text. Set to 0 to disable."
				>
					<NumberStepper
						min={0}
						onChange={(v) => update({ earlyTranscriptionOnSilence: v })}
						step={0.1}
						value={q?.earlyTranscriptionOnSilence ?? 0.2}
					/>
				</FormControl>
				<FormControl caption="Auto-capitalize sentence starts" label="Uppercase First Letter">
					<Toggle
						checked={q?.ensureSentenceStartingUppercase ?? true}
						onCheckedChange={(v) => update({ ensureSentenceStartingUppercase: v })}
					/>
				</FormControl>
				<FormControl caption="Auto-add period to sentences" label="End with Period">
					<Toggle
						checked={q?.ensureSentenceEndsWithPeriod ?? true}
						onCheckedChange={(v) => update({ ensureSentenceEndsWithPeriod: v })}
					/>
				</FormControl>
			</div>
		</SettingSection>
	);
}
