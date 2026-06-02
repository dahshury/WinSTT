import {
	Clock01Icon,
	ComputerIcon,
	DashboardCircleIcon,
	FlashIcon,
	InfinityIcon,
	Mic01Icon,
	MicOff01Icon,
	SparklesIcon,
	VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useInputDevices } from "@/entities/audio-device";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { useLoopbackDevices } from "@/features/listen-mode";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import {
	buildRecordingModeOptions,
	buildWakeWordGroups,
	recordingModePatch,
	SENSITIVITY_STEPS,
	sensitivityFromIndex,
	sensitivityToIndex,
} from "../lib/recording-settings-helpers";

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type AudioT = ReturnType<typeof useTranslations<"audio">>;
type QualityT = ReturnType<typeof useTranslations<"quality">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type AudioSettings = NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]["audio"]>;
type QualitySettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["quality"]
>;
type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;
type UpdateAudioFn = (patch: Partial<AudioSettings>) => void;
type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;

// ─────────────────────────── Recording mode sub-controls ───────────────────────────

interface LoopbackControlProps {
	currentLoopbackId: string;
	handleLoopbackChange: (value: string) => void;
	loopbackOpts: SelectOption[];
	t: GeneralT;
}

function LoopbackControl({
	t,
	currentLoopbackId,
	loopbackOpts,
	handleLoopbackChange,
}: LoopbackControlProps): ReactNode {
	return (
		<FormControl
			label={t("loopbackDevice")}
			labelTrailing={
				<SettingResetButton
					isDefault={currentLoopbackId === "default"}
					onReset={() => handleLoopbackChange("default")}
				/>
			}
			layout="row"
			tooltip={t("loopbackDeviceTooltip")}
		>
			<ElevatedSurface className="w-52" inline>
				<Select onChange={handleLoopbackChange} options={loopbackOpts} value={currentLoopbackId} />
			</ElevatedSurface>
		</FormControl>
	);
}

interface ManualToggleStopControlProps {
	enabled: boolean;
	t: GeneralT;
	update: UpdateGeneralFn;
}

// "Stop only on hotkey press" — surfaces under the toggle-mode option only.
// Flips silence_endpoint_enabled and silence_timing off on the server so a
// toggle-mode session runs continuously from first press to second press,
// fixing the mid-speech cutoff users hit when their voice goes soft.
function ManualToggleStopControl({ enabled, t, update }: ManualToggleStopControlProps): ReactNode {
	return (
		<FormControl
			label={t("manualToggleStop")}
			labelAddon={
				<Toggle
					aria-label={t("manualToggleStop")}
					checked={enabled}
					onCheckedChange={(v) => update({ manualToggleStop: v })}
				/>
			}
			labelTrailing={
				<SettingResetButton
					isDefault={enabled === DEFAULT_SETTINGS.general.manualToggleStop}
					onReset={() => update({ manualToggleStop: DEFAULT_SETTINGS.general.manualToggleStop })}
				/>
			}
			tooltip={t("manualToggleStopTooltip")}
		/>
	);
}

interface WakeWordControlProps {
	t: GeneralT;
	update: UpdateGeneralFn;
	value: string;
}

function WakeWordControl({ t, value, update }: WakeWordControlProps): ReactNode {
	const groups = buildWakeWordGroups();
	return (
		<FormControl
			label={t("wakeWord")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.wakeWord}
					onReset={() => update({ wakeWord: DEFAULT_SETTINGS.general.wakeWord })}
				/>
			}
			layout="row"
			tooltip={t("wakeWordTooltip")}
		>
			<ElevatedSurface className="w-52" inline>
				<Select
					aria-label={t("wakeWord")}
					groups={groups}
					onChange={(v) => update({ wakeWord: v })}
					value={value}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface WakeWordSensitivityControlProps {
	t: GeneralT;
	update: UpdateGeneralFn;
	value: number;
}

function WakeWordSensitivityControl({
	t,
	value,
	update,
}: WakeWordSensitivityControlProps): ReactNode {
	return (
		<FormControl
			label={t("wakeWordSensitivity")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.wakeWordSensitivity}
					onReset={() =>
						update({ wakeWordSensitivity: DEFAULT_SETTINGS.general.wakeWordSensitivity })
					}
				/>
			}
			tooltip={t("wakeWordSensitivityTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("wakeWordSensitivity")}
					formatValue={(idx) => sensitivityFromIndex(idx).toFixed(2)}
					max={SENSITIVITY_STEPS}
					min={0}
					onChange={(idx) => update({ wakeWordSensitivity: sensitivityFromIndex(idx) })}
					step={1}
					value={sensitivityToIndex(value)}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface WakeWordTimeoutControlProps {
	t: GeneralT;
	update: UpdateGeneralFn;
	value: number;
}

function WakeWordTimeoutControl({ t, value, update }: WakeWordTimeoutControlProps): ReactNode {
	return (
		<FormControl
			label={t("wakeWordTimeout")}
			labelTrailing={
				<SettingResetButton
					isDefault={value === DEFAULT_SETTINGS.general.wakeWordTimeout}
					onReset={() => update({ wakeWordTimeout: DEFAULT_SETTINGS.general.wakeWordTimeout })}
				/>
			}
			tooltip={t("wakeWordTimeoutTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("wakeWordTimeout")}
					formatValue={(v) => `${v}s`}
					max={30}
					min={1}
					onChange={(v) => update({ wakeWordTimeout: v })}
					step={1}
					value={value}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

interface RecordingModeSectionProps {
	currentLoopbackId: string;
	general: GeneralSettings | undefined;
	handleLoopbackChange: (value: string) => void;
	loopbackOpts: SelectOption[];
	recordingMode: "ptt" | "toggle" | "listen" | "wakeword";
	t: GeneralT;
	update: UpdateGeneralFn;
}

// Recording mode is the hero control: the four-way switcher that decides how a
// hotkey starts/stops a session, plus the mode-conditional sub-controls
// (Stop-only-on-hotkey for Toggle, Loopback device for Listen, Wake word +
// Sensitivity + Follow-up timeout for Wake Word). Diarization, mute-system-audio
// and the recording-sound chime moved to Model/Output tabs respectively.
function RecordingModeSection({
	t,
	general,
	recordingMode,
	update,
	loopbackOpts,
	currentLoopbackId,
	handleLoopbackChange,
}: RecordingModeSectionProps): ReactNode {
	const recordingModeOptions = buildRecordingModeOptions(t);
	return (
		<SettingSection icon={Mic01Icon} title={t("recording")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					label={t("recordingMode")}
					labelTrailing={
						<SettingResetButton
							isDefault={recordingMode === DEFAULT_SETTINGS.general.recordingMode}
							onReset={() =>
								update(
									recordingModePatch(DEFAULT_SETTINGS.general.recordingMode, general?.wakeWord)
								)
							}
						/>
					}
					tooltip={t("recordingModeTooltip")}
				>
					{/* Hero control — sets the design template for every other
					    interactive group on the tab. Same ElevatedSurface wraps
					    them all so the tab reads as one consistent language. */}
					<ElevatedSurface>
						<Switcher
							fullWidth
							onChange={(v) => update(recordingModePatch(v, general?.wakeWord))}
							options={recordingModeOptions}
							value={recordingMode}
						/>
					</ElevatedSurface>
				</FormControl>
				{recordingMode === "toggle" ? (
					<ManualToggleStopControl
						enabled={general?.manualToggleStop ?? false}
						t={t}
						update={update}
					/>
				) : null}
				{recordingMode === "listen" ? (
					<LoopbackControl
						currentLoopbackId={currentLoopbackId}
						handleLoopbackChange={handleLoopbackChange}
						loopbackOpts={loopbackOpts}
						t={t}
					/>
				) : null}
				{recordingMode === "wakeword" ? (
					<>
						<WakeWordControl t={t} update={update} value={general?.wakeWord ?? ""} />
						<WakeWordSensitivityControl
							t={t}
							update={update}
							value={general?.wakeWordSensitivity ?? 0.6}
						/>
						<WakeWordTimeoutControl t={t} update={update} value={general?.wakeWordTimeout ?? 5} />
					</>
				) : null}
			</div>
		</SettingSection>
	);
}

// ─────────────────────────── Input device ───────────────────────────

interface InputDeviceSectionProps {
	audio: AudioSettings | undefined;
	t: AudioT;
	update: UpdateAudioFn;
}

// Input + clamshell mic. Hidden entirely in Listen mode — there the loopback
// device (above) is captured instead of a microphone.
function InputDeviceSection({ audio, t, update }: InputDeviceSectionProps): ReactNode {
	const { devices, defaultDevice } = useInputDevices();
	const deviceOptions: SelectOption[] = (() => {
		const defaultLabel = defaultDevice
			? `${t("systemDefault")} (${defaultDevice.name})`
			: t("systemDefault");
		const opts: SelectOption[] = [{ id: "default", label: defaultLabel, icon: ComputerIcon }];
		for (const d of devices) {
			opts.push({ id: String(d.index), label: d.name, icon: Mic01Icon });
		}
		return opts;
	})();

	// Clamshell picker shares the device list but uses a "disabled" sentinel
	// instead of "default" — null = feature off (don't poll), whereas a
	// configured index = mic to swap to when the lid closes.
	const clamshellOptions: SelectOption[] = (() => {
		const opts: SelectOption[] = [
			{ id: "disabled", label: t("clamshellDisabled"), icon: MicOff01Icon },
		];
		for (const d of devices) {
			opts.push({ id: String(d.index), label: d.name, icon: Mic01Icon });
		}
		return opts;
	})();

	const currentDeviceId =
		audio?.inputDeviceIndex == null ? "default" : String(audio.inputDeviceIndex);
	const currentClamshellId =
		audio?.clamshellMicrophone == null ? "disabled" : String(audio.clamshellMicrophone);

	return (
		<SettingSection icon={Mic01Icon} title={t("inputDevice")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					label={t("device")}
					labelTrailing={
						<SettingResetButton
							isDefault={currentDeviceId === "default"}
							onReset={() => update({ inputDeviceIndex: null })}
						/>
					}
					layout="row"
					tooltip={t("deviceTooltip")}
				>
					<ElevatedSurface className="w-52" inline>
						<Select
							onChange={(v) =>
								update({
									inputDeviceIndex: v === "default" ? null : Number.parseInt(v, 10),
								})
							}
							options={deviceOptions}
							value={currentDeviceId}
						/>
					</ElevatedSurface>
				</FormControl>
				{/* Clamshell mic — auto-swap when the laptop lid closes. The
				    polling detector lives in the Electron main process; the
				    setting persists across launches. macOS + Linux supported;
				    Windows is a documented v1.1 deferral. */}
				<FormControl
					label={t("clamshellLabel")}
					labelTrailing={
						<SettingResetButton
							isDefault={currentClamshellId === "disabled"}
							onReset={() => update({ clamshellMicrophone: null })}
						/>
					}
					layout="row"
					tooltip={t("clamshellTooltip")}
				>
					<ElevatedSurface className="w-52" inline>
						<Select
							onChange={(v) =>
								update({
									clamshellMicrophone: v === "disabled" ? null : Number.parseInt(v, 10),
								})
							}
							options={clamshellOptions}
							value={currentClamshellId}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
		</SettingSection>
	);
}

// ─────────────────────────── Endpointing ───────────────────────────

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
					labelTrailing={
						<SettingResetButton
							isDefault={enabled === DEFAULT_SETTINGS.quality.smartEndpoint}
							onReset={() => onToggle(DEFAULT_SETTINGS.quality.smartEndpoint)}
						/>
					}
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
// here (in Endpointing) so users discover them next to Smart Endpoint — they
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

// ─────────────────────────── Advanced ───────────────────────────

interface AdvancedSectionProps {
	audio: AudioSettings | undefined;
	t: AudioT;
	update: UpdateAudioFn;
}

// Consolidated mic-release picker — a single Select covering the five discrete
// behaviors (always / immediate / 30s / 1m / 5m). STARTUP_ONLY: the recorder
// reads the resulting flags once at construction (requires server restart).
function AdvancedSection({ audio, t, update }: AdvancedSectionProps): ReactNode {
	const microphoneRelease = audio?.microphoneRelease ?? DEFAULT_SETTINGS.audio.microphoneRelease;
	const microphoneReleaseOptions: SelectOption[] = [
		{ id: "always", label: t("microphoneReleaseAlways"), icon: InfinityIcon },
		{ id: "immediate", label: t("microphoneReleaseImmediate"), icon: FlashIcon },
		{ id: "sec30", label: t("microphoneReleaseSec30"), icon: Clock01Icon },
		{ id: "min1", label: t("microphoneReleaseMin1"), icon: Clock01Icon },
		{ id: "min5", label: t("microphoneReleaseMin5"), icon: Clock01Icon },
	];
	return (
		<SettingSection icon={DashboardCircleIcon} title={t("advancedTitle")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					label={t("microphoneRelease")}
					labelTrailing={
						<SettingResetButton
							isDefault={microphoneRelease === DEFAULT_SETTINGS.audio.microphoneRelease}
							onReset={() =>
								update({ microphoneRelease: DEFAULT_SETTINGS.audio.microphoneRelease })
							}
						/>
					}
					layout="row"
					tooltip={t("microphoneReleaseTooltip")}
				>
					<ElevatedSurface className="w-52" inline>
						<Select
							onChange={(v) =>
								update({
									microphoneRelease: v as "always" | "immediate" | "sec30" | "min1" | "min5",
								})
							}
							options={microphoneReleaseOptions}
							value={microphoneRelease}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
		</SettingSection>
	);
}

// ─────────────────────────── Panel ───────────────────────────

export function RecordingSettingsPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const audio = useSettingsStore((s) => s.settings.audio);
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const q = useSettingsStore((s) => s.settings.quality);
	const update = useSettingsStore((s) => s.updateQualitySettings);
	const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
	const recordingMode = general?.recordingMode ?? "ptt";
	const llmDictationEnabled = useSettingsStore((s) => s.settings.llm?.dictation?.enabled ?? false);

	const t = useTranslations("general");
	const ta = useTranslations("audio");
	const tq = useTranslations("quality");

	const {
		options: loopbackOpts,
		currentId: currentLoopbackId,
		handleChange: handleLoopbackChange,
	} = useLoopbackDevices();

	// Smart Endpoint and LLM dictation cleanup make conflicting decisions about
	// when to finalise speech — enabling either auto-disables the other. The LLM
	// dictation feature lives on the Processing tab; this stays a plain store
	// read/write of llm.dictation.enabled.
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

	return (
		<div className="flex flex-col gap-2">
			<RecordingModeSection
				currentLoopbackId={currentLoopbackId}
				general={general}
				handleLoopbackChange={handleLoopbackChange}
				loopbackOpts={loopbackOpts}
				recordingMode={recordingMode}
				t={t}
				update={updateGeneral}
			/>

			{/* ── Input Device (hidden in Listen mode — loopback device is used instead) */}
			{recordingMode !== "listen" && (
				<InputDeviceSection audio={audio} t={ta} update={updateAudio} />
			)}

			{/* ── Voice Activity Detection (only meaningful when VAD drives endpoints) */}
			{(recordingMode === "listen" || recordingMode === "wakeword") && (
				<VadSection audio={audio} ta={ta} updateAudio={updateAudio} />
			)}

			{/* ── Smart Endpoint (Toggle / Wake Word only, realtime required).
				   Realtime is derived from the live-transcription display picker
				   (see `isRealtimeEnabled`); when no display surface is active
				   the engine isn't running, so Smart Endpoint has nothing to gate.
				   showRecordingOverlay + liveTranscriptionDisplay live on the
				   Appearance tab — read as plain store values here. */}
			{isRealtimeEnabled({
				showRecordingOverlay: general?.showRecordingOverlay ?? true,
				liveTranscriptionDisplay: general?.liveTranscriptionDisplay ?? "both",
			}) &&
				smartEndpointApplicable && (
					<SmartEndpointSection
						onToggle={handleSmartEndpointToggle}
						q={q}
						t={tq}
						update={update}
					/>
				)}

			{/* ── Sentence pauses (toggle/wakeword only, hidden when smart endpoint
				   handles them automatically or manual-toggle bypasses silence detection) */}
			{sentencePausesApplicable && !(q?.smartEndpoint ?? false) && (
				<SentencePauseSection q={q} t={tq} update={update} />
			)}

			{/* ── Advanced — mic-release behavior */}
			<AdvancedSection audio={audio} t={ta} update={updateAudio} />
		</div>
	);
}
