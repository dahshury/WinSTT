"use client";

import {
	EyeIcon,
	FileScriptIcon,
	SparklesIcon,
	SubtitleIcon,
	TextSquareIcon,
	Txt01Icon,
	VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

const TRANSCRIPTION_FORMAT_OPTIONS: readonly SwitcherOption<"txt" | "srt">[] = [
	{ value: "txt", label: "TXT", icon: Txt01Icon },
	{ value: "srt", label: "SRT", icon: SubtitleIcon },
] as const;

type QualityT = ReturnType<typeof useTranslations<"quality">>;
type QualitySettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["quality"]
>;
type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;

interface SmartEndpointSectionProps {
	onToggle: (next: boolean) => void;
	q: QualitySettings | undefined;
	t: QualityT;
	update: UpdateQualityFn;
}

function SmartEndpointSection({ q, t, update, onToggle }: SmartEndpointSectionProps) {
	const enabled = q?.smartEndpoint ?? false;
	return (
		<SettingSection icon={SparklesIcon} title={t("smartEndpoint")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					caption={t("smartEndpointCaption")}
					label={t("smartEndpointLabel")}
					labelAddon={<Toggle checked={enabled} onCheckedChange={onToggle} />}
					tooltip={t("smartEndpointTooltip")}
				/>
				{enabled && (
					<FormControl
						caption={t("detectionSpeedCaption")}
						label={t("detectionSpeed")}
						tooltip={t("detectionSpeedTooltip")}
					>
						<ElevatedSurface inline>
							<NumberStepper
								max={3.0}
								min={0.5}
								onChange={(v) => update({ smartEndpointSpeed: v })}
								step={0.1}
								value={q?.smartEndpointSpeed ?? 2.0}
							/>
						</ElevatedSurface>
					</FormControl>
				)}
			</div>
		</SettingSection>
	);
}

interface SentencePauseSectionProps {
	q: QualitySettings | undefined;
	t: QualityT;
	update: UpdateQualityFn;
}

// Sliders that drive the toggle-mode silence-timing heuristic. Surface them
// here (not in Audio) so users discover them next to Smart Endpoint — they
// are the manual alternative to it.
function SentencePauseSection({ q, t, update }: SentencePauseSectionProps) {
	return (
		<SettingSection icon={SparklesIcon} title={t("sentencePauses")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					caption={t("endOfSentencePauseCaption")}
					label={t("endOfSentencePause")}
					tooltip={t("endOfSentencePauseTooltip")}
				>
					<ElevatedSurface inline>
						<NumberStepper
							max={5.0}
							min={0.1}
							onChange={(v) => update({ endOfSentenceDetectionPause: v })}
							step={0.05}
							value={q?.endOfSentenceDetectionPause ?? 0.45}
						/>
					</ElevatedSurface>
				</FormControl>
				<FormControl
					caption={t("unknownSentencePauseCaption")}
					label={t("unknownSentencePause")}
					tooltip={t("unknownSentencePauseTooltip")}
				>
					<ElevatedSurface inline>
						<NumberStepper
							max={5.0}
							min={0.1}
							onChange={(v) => update({ unknownSentenceDetectionPause: v })}
							step={0.05}
							value={q?.unknownSentenceDetectionPause ?? 0.7}
						/>
					</ElevatedSurface>
				</FormControl>
				<FormControl
					caption={t("midSentencePauseCaption")}
					label={t("midSentencePause")}
					tooltip={t("midSentencePauseTooltip")}
				>
					<ElevatedSurface inline>
						<NumberStepper
							max={10.0}
							min={0.1}
							onChange={(v) => update({ midSentenceDetectionPause: v })}
							step={0.1}
							value={q?.midSentenceDetectionPause ?? 2.0}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
		</SettingSection>
	);
}

export function QualitySettingsPanel() {
	const q = useSettingsStore((s) => s.settings.quality);
	const update = useSettingsStore((s) => s.updateQualitySettings);
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const audio = useSettingsStore((s) => s.settings.audio);
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const llmDictationEnabled = useSettingsStore((s) => s.settings.llm?.dictation?.enabled ?? false);
	const t = useTranslations("quality");
	const tg = useTranslations("general");
	const ta = useTranslations("audio");

	// Smart Endpoint and LLM dictation cleanup make conflicting decisions about
	// when to finalise speech — enabling either auto-disables the other.
	const handleSmartEndpointToggle = (next: boolean): void => {
		update({ smartEndpoint: next });
		if (next && llmDictationEnabled) {
			updateLlmDictation({ enabled: false });
		}
	};

	// Smart Endpoint only makes sense in modes where silence ends the utterance.
	// PTT defines the boundary via key release; Listen runs continuous loopback
	// capture where endpoint tuning is more noise than signal.
	const smartEndpointApplicable = recordingMode === "toggle" || recordingMode === "wakeword";

	// Sentence-pause sliders are only relevant when silence_timing is driving
	// post_speech_silence_duration — that's toggle mode with manual-stop off
	// (or wakeword which never opts out). PTT, Listen, and toggle+manualStop
	// all bypass the heuristic so the sliders would have no effect.
	const manualToggleStop = general?.manualToggleStop ?? false;
	const sentencePausesApplicable =
		(recordingMode === "toggle" && !manualToggleStop) || recordingMode === "wakeword";

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
			{/* ── Voice Activity Detection (only meaningful when VAD drives endpoints) */}
			{(recordingMode === "listen" || recordingMode === "wakeword") && (
				<SettingSection
					icon={VoiceIdIcon}
					onToggle={(v) => updateAudio({ sileroDeactivityDetection: v })}
					title={ta("vad")}
					toggled={audio?.sileroDeactivityDetection ?? true}
				>
					<div className="flex flex-col divide-y divide-surface-1">
						<FormControl
							caption={ta("sileroSensitivityCaption")}
							label={ta("sileroSensitivity")}
							tooltip={ta("sileroSensitivityTooltip")}
						>
							<ElevatedSurface className="p-3">
								<Slider
									aria-label={ta("sileroSensitivity")}
									formatValue={(v) => v.toFixed(2)}
									max={1}
									min={0}
									onChange={(v) => updateAudio({ sileroSensitivity: v })}
									step={0.05}
									value={audio?.sileroSensitivity ?? 0.4}
								/>
							</ElevatedSurface>
						</FormControl>
						<FormControl
							caption={ta("webrtcSensitivityCaption")}
							label={ta("webrtcSensitivity")}
							tooltip={ta("webrtcSensitivityTooltip")}
						>
							<ElevatedSurface className="p-3">
								<Slider
									aria-label={ta("webrtcSensitivity")}
									max={3}
									min={0}
									onChange={(v) => updateAudio({ webrtcSensitivity: v })}
									step={1}
									value={audio?.webrtcSensitivity ?? 3}
								/>
							</ElevatedSurface>
						</FormControl>
						<FormControl
							caption={ta("postSpeechSilenceCaption")}
							label={ta("postSpeechSilence")}
							tooltip={ta("postSpeechSilenceTooltip")}
						>
							<ElevatedSurface inline>
								<NumberStepper
									min={0.1}
									onChange={(v) => updateAudio({ postSpeechSilenceDuration: v })}
									step={0.1}
									value={audio?.postSpeechSilenceDuration ?? 0.7}
								/>
							</ElevatedSurface>
						</FormControl>
						<FormControl
							caption={ta("minRecordingLengthCaption")}
							label={ta("minRecordingLength")}
							tooltip={ta("minRecordingLengthTooltip")}
						>
							<ElevatedSurface inline>
								<NumberStepper
									min={0.1}
									onChange={(v) => updateAudio({ minLengthOfRecording: v })}
									step={0.1}
									value={audio?.minLengthOfRecording ?? 1.1}
								/>
							</ElevatedSurface>
						</FormControl>
					</div>
				</SettingSection>
			)}

			{/* ── Smart Endpoint (Toggle / Wake Word only, realtime required) */}
			{(q?.enableRealtimeTranscription ?? true) && smartEndpointApplicable && (
				<SmartEndpointSection onToggle={handleSmartEndpointToggle} q={q} t={t} update={update} />
			)}

			{/* ── Sentence pauses (toggle/wakeword only, hidden when smart endpoint
				   handles them automatically or manual-toggle bypasses silence detection) */}
			{sentencePausesApplicable && !(q?.smartEndpoint ?? false) && (
				<SentencePauseSection q={q} t={t} update={update} />
			)}

			{/* ── Formatting ─────────────────────────────────── */}
			<SettingSection icon={TextSquareIcon} title={t("formatting")}>
				<div className="flex flex-col divide-y divide-surface-1">
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
				<div className="flex flex-col divide-y divide-surface-1">
					<FormControl
						caption={tg("fileTranscriptionFormatCaption")}
						label={tg("fileTranscriptionFormat")}
						tooltip={tg("fileTranscriptionFormatTooltip")}
					>
						<ElevatedSurface>
							<Switcher
								onChange={(v) => updateGeneral({ fileTranscriptionFormat: v })}
								options={TRANSCRIPTION_FORMAT_OPTIONS}
								value={transcriptionFormat}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>
			</SettingSection>

			{/* ── Context Awareness ──────────────────────────── */}
			<SettingSection icon={EyeIcon} title={tg("contextAwarenessSection")}>
				<div className="flex flex-col divide-y divide-surface-1">
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
