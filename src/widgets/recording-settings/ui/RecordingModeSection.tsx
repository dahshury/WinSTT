import { RecordIcon } from "@hugeicons/core-free-icons";
import { type ReactNode } from "react";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import type { WakewordModelStatusPayload } from "@/shared/api/ipc-client";
import { CreatableCombobox } from "@/shared/ui/creatable-combobox";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Slider } from "@/shared/ui/slider";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import {
	buildWakeWordItems,
	buildRecordingModeOptions,
	isLowerAccuracyWakeWord,
	normalizeWakeWordPhrase,
	presetIdForWakePhrase,
	reconcileCustomWakeWords,
	recordingModePatch,
	SENSITIVITY_STEPS,
	sensitivityFromIndex,
	sensitivityToIndex,
	wakeWordFromItemId,
	wakeWordValueToItemId,
} from "../lib/recording-settings-helpers";
import {
	type AudioSettings,
	type AudioT,
	type GeneralSettings,
	type GeneralT,
	type UpdateAudioFn,
	type UpdateGeneralFn,
	WAKEWORD_MODEL_DISABLED_REASON,
	SILENCE_STOP_MAX_SECONDS,
	SILENCE_STOP_MIN_SECONDS,
	SILENCE_STOP_STEP_SECONDS,
	roundSilenceStopSeconds,
} from "./recording-settings-types";
import { WakewordDownloadProgress } from "./WakewordDownload";

interface ManualToggleStopControlProps {
	enabled: boolean;
	t: GeneralT;
	update: UpdateGeneralFn;
}

// "Stop only on hotkey press" — surfaces under the toggle-mode option only.
// Flips silence_endpoint_enabled and silence_timing off on the server so a
// toggle-mode session runs continuously from first press to second press,
// fixing the mid-speech cutoff users hit when their voice goes soft.
function ManualToggleStopControl({
	enabled,
	t,
	update,
}: ManualToggleStopControlProps): ReactNode {
	return (
		<SettingField
			isDefault={enabled === DEFAULT_SETTINGS.general.manualToggleStop}
			label={t("manualToggleStop")}
			labelAddon={
				<Toggle
					aria-label={t("manualToggleStop")}
					checked={enabled}
					onCheckedChange={(v) => update({ manualToggleStop: v })}
				/>
			}
			onReset={() =>
				update({ manualToggleStop: DEFAULT_SETTINGS.general.manualToggleStop })
			}
			tooltip={t("manualToggleStopTooltip")}
		/>
	);
}

interface ToggleSilenceStopControlProps {
	audio: AudioSettings | undefined;
	t: AudioT;
	update: UpdateAudioFn;
}

function ToggleSilenceStopControl({
	audio,
	t,
	update,
}: ToggleSilenceStopControlProps): ReactNode {
	const value =
		audio?.postSpeechSilenceDuration ??
		DEFAULT_SETTINGS.audio.postSpeechSilenceDuration;
	return (
		<SettingField
			isDefault={value === DEFAULT_SETTINGS.audio.postSpeechSilenceDuration}
			label={t("postSpeechSilence")}
			onReset={() =>
				update({
					postSpeechSilenceDuration:
						DEFAULT_SETTINGS.audio.postSpeechSilenceDuration,
				})
			}
			tooltip={t("postSpeechSilenceTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("postSpeechSilence")}
					formatValue={(v) => `${v.toFixed(1)}s`}
					max={SILENCE_STOP_MAX_SECONDS}
					min={SILENCE_STOP_MIN_SECONDS}
					onChange={(v) =>
						update({ postSpeechSilenceDuration: roundSilenceStopSeconds(v) })
					}
					step={SILENCE_STOP_STEP_SECONDS}
					value={value}
				/>
			</ElevatedSurface>
		</SettingField>
	);
}

interface WakeWordControlProps {
	customWakeWords: readonly string[];
	disabled?: boolean;
	t: GeneralT;
	update: UpdateGeneralFn;
	value: string;
}

function WakeWordControl({
	customWakeWords,
	disabled = false,
	t,
	value,
	update,
}: WakeWordControlProps): ReactNode {
	const savedCustomWakeWords = reconcileCustomWakeWords(value, customWakeWords);
	const selectedItemId = wakeWordValueToItemId(value);
	const lowerAccuracy = isLowerAccuracyWakeWord(value);
	const handleSelect = (id: string) => {
		const nextWakeWord = wakeWordFromItemId(id);
		update({
			wakeWord: nextWakeWord,
			customWakeWords: reconcileCustomWakeWords(
				nextWakeWord,
				savedCustomWakeWords,
			),
		});
	};
	const handleCreate = (raw: string) => {
		const phrase = normalizeWakeWordPhrase(raw);
		if (!phrase) {
			return;
		}
		const preset = presetIdForWakePhrase(phrase);
		if (preset) {
			update({ wakeWord: preset, customWakeWords: savedCustomWakeWords });
			return;
		}
		update({
			wakeWord: phrase,
			customWakeWords: reconcileCustomWakeWords(phrase, [
				...savedCustomWakeWords,
				phrase,
			]),
		});
	};
	const handleDelete = (id: string) => {
		const phrase = wakeWordFromItemId(id);
		const nextCustomWakeWords = savedCustomWakeWords.filter(
			(word) => word !== phrase,
		);
		update({
			customWakeWords: nextCustomWakeWords,
			...(normalizeWakeWordPhrase(value) === phrase
				? { wakeWord: DEFAULT_SETTINGS.general.wakeWord }
				: {}),
		});
	};
	const isDefault =
		value === DEFAULT_SETTINGS.general.wakeWord &&
		savedCustomWakeWords.length === 0;
	return (
		<SettingField
			isDefault={isDefault}
			label={t("wakeWord")}
			layout="row"
			onReset={() =>
				update({
					wakeWord: DEFAULT_SETTINGS.general.wakeWord,
					customWakeWords: DEFAULT_SETTINGS.general.customWakeWords,
				})
			}
			disabled={disabled}
			disabledReason={WAKEWORD_MODEL_DISABLED_REASON}
			tooltip={t("wakeWordTooltip")}
		>
			<CreatableCombobox
				className="w-full sm:w-64"
				createLabel={(phrase) => `Save "${phrase}"`}
				deleteAriaLabel="Delete custom wake word"
				disabled={disabled}
				emptyLabel="Type to save a custom wake word"
				items={buildWakeWordItems(savedCustomWakeWords, value)}
				onCreate={handleCreate}
				onDelete={handleDelete}
				onSelect={handleSelect}
				placeholder="Select or type wake word"
				value={selectedItemId}
			/>
			{lowerAccuracy ? (
				<p className="mt-1 text-body-sm text-warning">
					{t("wakeWordCustomLowerAccuracy")}
				</p>
			) : null}
		</SettingField>
	);
}

interface WakeWordSensitivityControlProps {
	disabled?: boolean;
	t: GeneralT;
	update: UpdateGeneralFn;
	value: number;
}

function WakeWordSensitivityControl({
	disabled = false,
	t,
	value,
	update,
}: WakeWordSensitivityControlProps): ReactNode {
	return (
		<SettingField
			isDefault={value === DEFAULT_SETTINGS.general.wakeWordSensitivity}
			label={t("wakeWordSensitivity")}
			onReset={() =>
				update({
					wakeWordSensitivity: DEFAULT_SETTINGS.general.wakeWordSensitivity,
				})
			}
			disabled={disabled}
			disabledReason={WAKEWORD_MODEL_DISABLED_REASON}
			tooltip={t("wakeWordSensitivityTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("wakeWordSensitivity")}
					disabled={disabled}
					formatValue={(idx) => sensitivityFromIndex(idx).toFixed(2)}
					max={SENSITIVITY_STEPS}
					min={0}
					onChange={(idx) =>
						update({ wakeWordSensitivity: sensitivityFromIndex(idx) })
					}
					step={1}
					value={sensitivityToIndex(value)}
				/>
			</ElevatedSurface>
		</SettingField>
	);
}

interface WakeWordTimeoutControlProps {
	disabled?: boolean;
	t: GeneralT;
	update: UpdateGeneralFn;
	value: number;
}

function WakeWordTimeoutControl({
	disabled = false,
	t,
	value,
	update,
}: WakeWordTimeoutControlProps): ReactNode {
	return (
		<SettingField
			isDefault={value === DEFAULT_SETTINGS.general.wakeWordTimeout}
			label={t("wakeWordTimeout")}
			onReset={() =>
				update({ wakeWordTimeout: DEFAULT_SETTINGS.general.wakeWordTimeout })
			}
			disabled={disabled}
			disabledReason={WAKEWORD_MODEL_DISABLED_REASON}
			tooltip={t("wakeWordTimeoutTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("wakeWordTimeout")}
					disabled={disabled}
					formatValue={(v) => `${v}s`}
					max={30}
					min={1}
					onChange={(v) => update({ wakeWordTimeout: v })}
					step={1}
					value={value}
				/>
			</ElevatedSurface>
		</SettingField>
	);
}

interface RecordingModeSectionProps {
	audio: AudioSettings | undefined;
	general: GeneralSettings | undefined;
	prepareListenMode: () => boolean;
	recordingMode: "ptt" | "toggle" | "listen" | "wakeword";
	requestWakewordDownload: () => void;
	ta: AudioT;
	t: GeneralT;
	update: UpdateGeneralFn;
	updateAudio: UpdateAudioFn;
	wakewordEnablePending: boolean;
	wakewordStatus: WakewordModelStatusPayload;
}

// Recording mode is the hero control: the four-way switcher that decides how a
// hotkey starts/stops a session, plus the mode-conditional sub-controls
// (Stop-only-on-hotkey for Toggle, Loopback device for Listen, Wake word +
// Sensitivity + Follow-up timeout for Wake Word). Diarization, mute-system-audio
// and the recording-sound chime moved to Model/Output tabs respectively.
export function RecordingModeSection({
	audio,
	t,
	ta,
	general,
	recordingMode,
	update,
	updateAudio,
	prepareListenMode,
	requestWakewordDownload,
	wakewordEnablePending,
	wakewordStatus,
}: RecordingModeSectionProps): ReactNode {
	const recordingModeOptions = buildRecordingModeOptions(t);
	const manualToggleStop = general?.manualToggleStop ?? false;
	const wakewordControlsLocked =
		!wakewordStatus.available &&
		(wakewordStatus.downloading || recordingMode === "wakeword");
	const showWakewordDownloadProgress =
		!wakewordStatus.available &&
		(wakewordEnablePending ||
			wakewordStatus.downloading ||
			wakewordStatus.phase === "paused" ||
			!!wakewordStatus.error);
	const handleRecordingModeChange = (
		value: "ptt" | "toggle" | "listen" | "wakeword",
	) => {
		if (
			value === "wakeword" &&
			!wakewordStatus.available &&
			!wakewordStatus.downloading
		) {
			requestWakewordDownload();
			return;
		}
		if (value === "listen" && !prepareListenMode()) {
			return;
		}
		update(recordingModePatch(value, general?.wakeWord));
	};
	return (
		<SettingSection icon={RecordIcon} title={t("recording")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<SettingField
					isDefault={recordingMode === DEFAULT_SETTINGS.general.recordingMode}
					label={t("recordingMode")}
					onReset={() =>
						update(
							recordingModePatch(
								DEFAULT_SETTINGS.general.recordingMode,
								general?.wakeWord,
							),
						)
					}
					tooltip={t("recordingModeTooltip")}
				>
					{/* Hero control — sets the design template for every other
					    interactive group on the tab. Same ElevatedSurface wraps
					    them all so the tab reads as one consistent language. */}
					<ElevatedSurface>
						<Switcher
							fullWidth
							onChange={handleRecordingModeChange}
							options={recordingModeOptions}
							value={recordingMode}
						/>
					</ElevatedSurface>
				</SettingField>
				{recordingMode !== "wakeword" && showWakewordDownloadProgress ? (
					<WakewordDownloadProgress status={wakewordStatus} />
				) : null}
				{recordingMode === "toggle" ? (
					<>
						<ManualToggleStopControl
							enabled={manualToggleStop}
							t={t}
							update={update}
						/>
						{!manualToggleStop ? (
							<ToggleSilenceStopControl
								audio={audio}
								t={ta}
								update={updateAudio}
							/>
						) : null}
					</>
				) : null}
				{recordingMode === "wakeword" ? (
					<>
						<WakeWordControl
							customWakeWords={general?.customWakeWords ?? []}
							disabled={wakewordControlsLocked}
							t={t}
							update={update}
							value={general?.wakeWord ?? ""}
						/>
						<WakewordDownloadProgress status={wakewordStatus} />
						<WakeWordSensitivityControl
							disabled={wakewordControlsLocked}
							t={t}
							update={update}
							value={general?.wakeWordSensitivity ?? 0.6}
						/>
						<WakeWordTimeoutControl
							disabled={wakewordControlsLocked}
							t={t}
							update={update}
							value={general?.wakeWordTimeout ?? 5}
						/>
					</>
				) : null}
			</div>
		</SettingSection>
	);
}
