import {
	ArrowTurnDownIcon,
	DashboardCircleIcon,
	EyeIcon,
	FileScriptIcon,
	KeyboardIcon,
	SparklesIcon,
	SubtitleIcon,
	TextSquareIcon,
	Txt01Icon,
	VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useCatalogStore } from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { ContextDenyListSection } from "./ContextDenyListSection";

const TRANSCRIPTION_FORMAT_OPTIONS: readonly SwitcherOption<"txt" | "srt">[] = [
	{ value: "txt", label: "TXT", icon: Txt01Icon },
	{ value: "srt", label: "SRT", icon: SubtitleIcon },
] as const;

type QualityT = ReturnType<typeof useTranslations<"quality">>;
type AudioT = ReturnType<typeof useTranslations<"audio">>;
type QualitySettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["quality"]
>;
type AudioSettings = NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]["audio"]>;
type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;
type UpdateAudioFn = (patch: Partial<AudioSettings>) => void;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;

type GeneralT = ReturnType<typeof useTranslations<"general">>;

interface PasteBehaviorSectionProps {
	autoSubmit: boolean;
	autoSubmitKey: "enter" | "ctrl_enter";
	autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[];
	onChangeAutoSubmit: (next: boolean) => void;
	onChangeAutoSubmitKey: (next: "enter" | "ctrl_enter") => void;
	tg: GeneralT;
}

function PasteBehaviorSection({
	autoSubmit,
	autoSubmitKey,
	autoSubmitKeyOptions,
	onChangeAutoSubmit,
	onChangeAutoSubmitKey,
	tg,
}: PasteBehaviorSectionProps) {
	return (
		<SettingSection icon={DashboardCircleIcon} title={tg("pasteBehaviorTitle")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					label={tg("autoSubmit")}
					labelAddon={<Toggle checked={autoSubmit} onCheckedChange={onChangeAutoSubmit} />}
					tooltip={tg("autoSubmitTooltip")}
				/>
				{autoSubmit ? (
					<FormControl
						label={tg("autoSubmitKey")}
						layout="row"
						tooltip={tg("autoSubmitKeyTooltip")}
					>
						<ElevatedSurface className="w-52">
							<Switcher
								fullWidth
								onChange={onChangeAutoSubmitKey}
								options={autoSubmitKeyOptions}
								value={autoSubmitKey}
							/>
						</ElevatedSurface>
					</FormControl>
				) : null}
			</div>
		</SettingSection>
	);
}

interface ContextAwarenessSectionProps {
	enabled: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	tg: GeneralT;
}

function ContextAwarenessSection({
	enabled,
	onCancel,
	onConfirm,
	tg,
}: ContextAwarenessSectionProps) {
	const [dialogOpen, setDialogOpen] = useState(false);
	// Toggle ON ⇒ show the opt-in dialog and DON'T persist yet; the dialog's
	// confirm path is what actually flips the stored value. Toggle OFF ⇒
	// persist immediately (no consent needed to disable).
	const handleToggle = (next: boolean): void => {
		if (next) {
			setDialogOpen(true);
			return;
		}
		onCancel();
	};
	return (
		<SettingSection icon={EyeIcon} title={tg("contextAwarenessSection")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					label={tg("contextAwareness")}
					labelAddon={<Toggle checked={enabled} onCheckedChange={handleToggle} />}
					tooltip={tg("contextAwarenessTooltip")}
				/>
				{/* The deny-list (apps/sites to skip) configures the same capture
				    pipeline this toggle gates, so it lives directly beneath it —
				    shown only once context awareness is actually on. */}
				{enabled ? <ContextDenyListSection /> : null}
			</div>
			<OptInDialog
				body={tg("contextAwarenessDialogBody")}
				cancelLabel={tg("contextAwarenessDialogCancel")}
				confirmLabel={tg("contextAwarenessDialogConfirm")}
				onCancel={onCancel}
				onConfirm={onConfirm}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				title={tg("contextAwarenessDialogTitle")}
			/>
		</SettingSection>
	);
}

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
					label={t("smartEndpointLabel")}
					labelAddon={<Toggle checked={enabled} onCheckedChange={onToggle} />}
					tooltip={t("smartEndpointTooltip")}
				/>
				{enabled && (
					<FormControl
						label={t("detectionSpeed")}
						labelTrailing={
							<SettingResetButton
								isDefault={
									(q?.smartEndpointSpeed ?? DEFAULT_SETTINGS.quality.smartEndpointSpeed) ===
									DEFAULT_SETTINGS.quality.smartEndpointSpeed
								}
								onReset={() =>
									update({ smartEndpointSpeed: DEFAULT_SETTINGS.quality.smartEndpointSpeed })
								}
							/>
						}
						layout="row"
						tooltip={t("detectionSpeedTooltip")}
					>
						<ElevatedSurface className="w-fit" inline>
							<NumberStepper
								max={3.0}
								min={0.5}
								onChange={(v) => update({ smartEndpointSpeed: v })}
								step={0.1}
								value={q?.smartEndpointSpeed ?? DEFAULT_SETTINGS.quality.smartEndpointSpeed}
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
					label={t("endOfSentencePause")}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(q?.endOfSentenceDetectionPause ??
									DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause) ===
								DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause
							}
							onReset={() =>
								update({
									endOfSentenceDetectionPause: DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause,
								})
							}
						/>
					}
					layout="row"
					tooltip={t("endOfSentencePauseTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={5.0}
							min={0.1}
							onChange={(v) => update({ endOfSentenceDetectionPause: v })}
							step={0.05}
							value={
								q?.endOfSentenceDetectionPause ??
								DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause
							}
						/>
					</ElevatedSurface>
				</FormControl>
				<FormControl
					label={t("unknownSentencePause")}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(q?.unknownSentenceDetectionPause ??
									DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause) ===
								DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause
							}
							onReset={() =>
								update({
									unknownSentenceDetectionPause:
										DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause,
								})
							}
						/>
					}
					layout="row"
					tooltip={t("unknownSentencePauseTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={5.0}
							min={0.1}
							onChange={(v) => update({ unknownSentenceDetectionPause: v })}
							step={0.05}
							value={
								q?.unknownSentenceDetectionPause ??
								DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause
							}
						/>
					</ElevatedSurface>
				</FormControl>
				<FormControl
					label={t("midSentencePause")}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(q?.midSentenceDetectionPause ??
									DEFAULT_SETTINGS.quality.midSentenceDetectionPause) ===
								DEFAULT_SETTINGS.quality.midSentenceDetectionPause
							}
							onReset={() =>
								update({
									midSentenceDetectionPause: DEFAULT_SETTINGS.quality.midSentenceDetectionPause,
								})
							}
						/>
					}
					layout="row"
					tooltip={t("midSentencePauseTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={10.0}
							min={0.1}
							onChange={(v) => update({ midSentenceDetectionPause: v })}
							step={0.1}
							value={
								q?.midSentenceDetectionPause ?? DEFAULT_SETTINGS.quality.midSentenceDetectionPause
							}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
		</SettingSection>
	);
}

interface VadSectionProps {
	audio: AudioSettings | undefined;
	ta: AudioT;
	updateAudio: UpdateAudioFn;
}

// Voice Activity Detection tuning — only surfaced when VAD actually drives
// the endpoint (listen / wakeword). Extracted so the panel root stays under
// the cyclomatic-complexity ceiling.
function VadSection({ audio, ta, updateAudio }: VadSectionProps) {
	return (
		<SettingSection
			icon={VoiceIdIcon}
			onToggle={(v) => updateAudio({ sileroDeactivityDetection: v })}
			title={ta("vad")}
			toggled={audio?.sileroDeactivityDetection ?? true}
		>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					label={ta("sileroSensitivity")}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(audio?.sileroSensitivity ?? DEFAULT_SETTINGS.audio.sileroSensitivity) ===
								DEFAULT_SETTINGS.audio.sileroSensitivity
							}
							onReset={() =>
								updateAudio({ sileroSensitivity: DEFAULT_SETTINGS.audio.sileroSensitivity })
							}
						/>
					}
					tooltip={ta("sileroSensitivityTooltip")}
				>
					<ElevatedSurface inline>
						<Slider
							aria-label={ta("sileroSensitivity")}
							formatValue={(v) => v.toFixed(2)}
							max={1}
							min={0}
							onChange={(v) => updateAudio({ sileroSensitivity: v })}
							step={0.05}
							value={audio?.sileroSensitivity ?? DEFAULT_SETTINGS.audio.sileroSensitivity}
						/>
					</ElevatedSurface>
				</FormControl>
				<FormControl
					label={ta("webrtcSensitivity")}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(audio?.webrtcSensitivity ?? DEFAULT_SETTINGS.audio.webrtcSensitivity) ===
								DEFAULT_SETTINGS.audio.webrtcSensitivity
							}
							onReset={() =>
								updateAudio({ webrtcSensitivity: DEFAULT_SETTINGS.audio.webrtcSensitivity })
							}
						/>
					}
					tooltip={ta("webrtcSensitivityTooltip")}
				>
					<ElevatedSurface inline>
						<Slider
							aria-label={ta("webrtcSensitivity")}
							max={3}
							min={0}
							onChange={(v) => updateAudio({ webrtcSensitivity: v })}
							step={1}
							value={audio?.webrtcSensitivity ?? DEFAULT_SETTINGS.audio.webrtcSensitivity}
						/>
					</ElevatedSurface>
				</FormControl>
				<FormControl
					label={ta("postSpeechSilence")}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(audio?.postSpeechSilenceDuration ??
									DEFAULT_SETTINGS.audio.postSpeechSilenceDuration) ===
								DEFAULT_SETTINGS.audio.postSpeechSilenceDuration
							}
							onReset={() =>
								updateAudio({
									postSpeechSilenceDuration: DEFAULT_SETTINGS.audio.postSpeechSilenceDuration,
								})
							}
						/>
					}
					layout="row"
					tooltip={ta("postSpeechSilenceTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							min={0.1}
							onChange={(v) => updateAudio({ postSpeechSilenceDuration: v })}
							step={0.1}
							value={
								audio?.postSpeechSilenceDuration ?? DEFAULT_SETTINGS.audio.postSpeechSilenceDuration
							}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
		</SettingSection>
	);
}

interface FormattingSectionProps {
	general: GeneralSettings | undefined;
	llmDictationEnabled: boolean;
	q: QualitySettings | undefined;
	t: QualityT;
	update: UpdateQualityFn;
	updateGeneral: UpdateGeneralFn;
}

// Post-decode transcript cleanups. LLM dictation rewrites the transcript
// wholesale (casing, punctuation, fillers) before paste, so these per-utterance
// fixups are redundant — disable them while LLM dictation is on. Extracted so
// the panel root stays under the cyclomatic-complexity ceiling.
function FormattingSection({
	general,
	llmDictationEnabled,
	q,
	t,
	update,
	updateGeneral,
}: FormattingSectionProps) {
	return (
		<SettingSection icon={TextSquareIcon} title={t("formatting")}>
			<div
				className={cn(
					"flex flex-col divide-y divide-surface-1 transition-opacity duration-200 ease-out",
					llmDictationEnabled && "pointer-events-none opacity-40"
				)}
			>
				<FormControl
					label={t("uppercaseFirst")}
					labelAddon={
						<Toggle
							checked={q?.ensureSentenceStartingUppercase ?? true}
							disabled={llmDictationEnabled}
							onCheckedChange={(v) => update({ ensureSentenceStartingUppercase: v })}
						/>
					}
					tooltip={t("uppercaseFirstTooltip")}
				/>
				<FormControl
					label={t("endWithPeriod")}
					labelAddon={
						<Toggle
							checked={q?.ensureSentenceEndsWithPeriod ?? true}
							disabled={llmDictationEnabled}
							onCheckedChange={(v) => update({ ensureSentenceEndsWithPeriod: v })}
						/>
					}
					tooltip={t("endWithPeriodTooltip")}
				/>
				{/* Filler removal is a `general.*` setting (synced server-side via
					custom-words-sync → set_parameter("filter_fillers")). Surfaced here
					next to the other post-decode cleanups. Turn OFF to keep verbatim
					disfluencies — the reason to pick a model like CrisperWhisper. */}
				<FormControl
					label={t("removeFillerWords")}
					labelAddon={
						<Toggle
							checked={general?.filterFillers ?? true}
							disabled={llmDictationEnabled}
							onCheckedChange={(v) => updateGeneral({ filterFillers: v })}
						/>
					}
					tooltip={t("removeFillerWordsTooltip")}
				/>
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
	// Context awareness has two consumers (see relay-context-capture):
	//   1. ASR-side: Whisper-only via `<|startofprev|>`. Canary / Cohere
	//      have a `<|startofcontext|>` slot but the released checkpoints
	//      aren't trained on it — empirical bench shows broken / truncated
	//      / hallucinated outputs (see memory note `canary-cohere-prompt-
	//      slot-untrained`). Moonshine / SenseVoice / CTC families have
	//      no prompt mechanism at all.
	//   2. LLM cleanup: any engine benefits when the dictation LLM runs.
	// So the section is meaningful when EITHER condition is met; if
	// neither is, the toggle does nothing — hide it.
	const activeSttModelId = useSettingsStore((s) => s.settings.model?.model ?? "");
	const activeSttFamily = useCatalogStore((s) => s.getModel(activeSttModelId)?.family);
	const contextAwarenessUseful = activeSttFamily === "whisper" || llmDictationEnabled;
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
	const autoSubmit = general?.autoSubmit ?? false;
	const autoSubmitKey = general?.autoSubmitKey ?? "enter";
	const autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[] = [
		{ value: "enter", label: tg("autoSubmitKeyEnter"), icon: ArrowTurnDownIcon },
		{ value: "ctrl_enter", label: tg("autoSubmitKeyCtrlEnter"), icon: KeyboardIcon },
	];

	return (
		<div className="flex flex-col gap-2">
			{/* ── Context Awareness ────────────────────────────
				 Shown only when at least one consumer can actually act on
				 the captured snapshot:
				   * ASR-side: active model is a Whisper variant (the only
				     family whose released checkpoints accept and respond
				     to prior-text prompts — see memory note
				     `canary-cohere-prompt-slot-untrained` for the bench
				     evidence on Canary / Cohere / Moonshine).
				   * LLM-side: dictation LLM is enabled (the cleanup pass
				     consumes context regardless of which ASR engine ran).
				 With neither condition met the toggle does nothing, so we
				 hide it instead of advertising a dead setting. */}
			{contextAwarenessUseful && (
				<ContextAwarenessSection
					enabled={contextAwarenessEnabled}
					onCancel={() => updateGeneral({ contextAwareness: false })}
					onConfirm={() => updateGeneral({ contextAwareness: true })}
					tg={tg}
				/>
			)}

			{/* ── Voice Activity Detection (only meaningful when VAD drives endpoints) */}
			{(recordingMode === "listen" || recordingMode === "wakeword") && (
				<VadSection audio={audio} ta={ta} updateAudio={updateAudio} />
			)}

			{/* ── Smart Endpoint (Toggle / Wake Word only, realtime required).
				   Realtime is derived from the live-transcription display picker
				   (see `isRealtimeEnabled`); when no display surface is active
				   the engine isn't running, so Smart Endpoint has nothing to gate. */}
			{isRealtimeEnabled({
				showRecordingOverlay: general?.showRecordingOverlay ?? true,
				liveTranscriptionDisplay: general?.liveTranscriptionDisplay ?? "both",
			}) &&
				smartEndpointApplicable && (
					<SmartEndpointSection onToggle={handleSmartEndpointToggle} q={q} t={t} update={update} />
				)}

			{/* ── Sentence pauses (toggle/wakeword only, hidden when smart endpoint
				   handles them automatically or manual-toggle bypasses silence detection) */}
			{sentencePausesApplicable && !(q?.smartEndpoint ?? false) && (
				<SentencePauseSection q={q} t={t} update={update} />
			)}

			{/* ── Formatting ─────────────────────────────────── */}
			<FormattingSection
				general={general}
				llmDictationEnabled={llmDictationEnabled}
				q={q}
				t={t}
				update={update}
				updateGeneral={updateGeneral}
			/>

			{/* ── File Transcription ─────────────────────────── */}
			<SettingSection icon={FileScriptIcon} title={tg("fileTranscription")}>
				<div className="flex flex-col divide-y divide-surface-1">
					<FormControl
						label={tg("fileTranscriptionFormat")}
						layout="row"
						tooltip={tg("fileTranscriptionFormatTooltip")}
					>
						<ElevatedSurface className="w-52">
							<Switcher
								fullWidth
								onChange={(v) => updateGeneral({ fileTranscriptionFormat: v })}
								options={TRANSCRIPTION_FORMAT_OPTIONS}
								value={transcriptionFormat}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>
			</SettingSection>

			{/* ── Paste Behavior ─────────────────────────────── */}
			<PasteBehaviorSection
				autoSubmit={autoSubmit}
				autoSubmitKey={autoSubmitKey}
				autoSubmitKeyOptions={autoSubmitKeyOptions}
				onChangeAutoSubmit={(v) => updateGeneral({ autoSubmit: v })}
				onChangeAutoSubmitKey={(v) => updateGeneral({ autoSubmitKey: v })}
				tg={tg}
			/>
		</div>
	);
}
