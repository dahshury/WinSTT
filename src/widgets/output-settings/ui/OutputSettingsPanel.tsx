import {
	ArrowTurnDownIcon,
	ComputerIcon,
	DashboardCircleIcon,
	FileScriptIcon,
	KeyboardIcon,
	Mic01Icon,
	SubtitleIcon,
	Txt01Icon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useOutputDevices } from "@/entities/audio-device";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { SoundLibrary } from "@/features/recording-sound";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

// ── Copied helpers (the originals live in another widget's lib folder —
//    src/widgets/general-settings/lib/general-settings-panel-test-helpers.ts —
//    which an FSD widget may not import across the widgets slice, so the
//    "Reduce system audio while dictating" slider's math is reproduced here
//    verbatim).
const REDUCTION_STEPS = [0, 20, 40, 60, 80, 100] as const;

function reductionToIndex(pct: number): number {
	const idx = REDUCTION_STEPS.indexOf(pct as (typeof REDUCTION_STEPS)[number]);
	return idx === -1 ? 0 : idx;
}

function indexToReduction(index: number): number {
	return REDUCTION_STEPS[index] ?? 0;
}

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;

function reductionStepLabel(pct: number, t: GeneralT): string {
	if (pct <= 0) {
		return t("systemAudioReductionOff");
	}
	return pct >= 100 ? t("systemAudioReductionMute") : `${pct}%`;
}

function muteLevel(settings: GeneralSettings | undefined): number {
	return settings?.systemAudioReductionWhileDictating ?? 0;
}

// File-transcription output format options. Copied from QualitySettingsPanel
// (module-level const there) — the same two formats, labels (hardcoded
// English in the source, not i18n), and icons.
const TRANSCRIPTION_FORMAT_OPTIONS: readonly SwitcherOption<"txt" | "srt">[] = [
	{ value: "txt", label: "TXT", icon: Txt01Icon },
	{ value: "srt", label: "SRT", icon: SubtitleIcon },
] as const;

interface PasteBehaviorSectionProps {
	autoSubmit: boolean;
	autoSubmitKey: "enter" | "ctrl_enter";
	autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[];
	onChangeAutoSubmit: (next: boolean) => void;
	onChangeAutoSubmitKey: (next: "enter" | "ctrl_enter") => void;
	tg: GeneralT;
}

// Copied verbatim from QualitySettingsPanel (Paste Behavior section).
function PasteBehaviorSection({
	autoSubmit,
	autoSubmitKey,
	autoSubmitKeyOptions,
	onChangeAutoSubmit,
	onChangeAutoSubmitKey,
	tg,
}: PasteBehaviorSectionProps): ReactNode {
	return (
		<SettingSection icon={DashboardCircleIcon} title={tg("pasteBehaviorTitle")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					label={tg("autoSubmit")}
					labelAddon={<Toggle checked={autoSubmit} onCheckedChange={onChangeAutoSubmit} />}
					labelTrailing={
						<SettingResetButton
							isDefault={autoSubmit === DEFAULT_SETTINGS.general.autoSubmit}
							onReset={() => onChangeAutoSubmit(DEFAULT_SETTINGS.general.autoSubmit)}
						/>
					}
					tooltip={tg("autoSubmitTooltip")}
				/>
				{autoSubmit ? (
					<FormControl
						label={tg("autoSubmitKey")}
						labelTrailing={
							<SettingResetButton
								isDefault={autoSubmitKey === DEFAULT_SETTINGS.general.autoSubmitKey}
								onReset={() => onChangeAutoSubmitKey(DEFAULT_SETTINGS.general.autoSubmitKey)}
							/>
						}
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

interface MuteSystemAudioControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateGeneralFn;
}

// Copied verbatim from GeneralSettingsPanel (RecordingSection — MuteSystemAudioControl).
function MuteSystemAudioControl({ general, t, update }: MuteSystemAudioControlProps): ReactNode {
	const level = muteLevel(general);
	return (
		<FormControl
			label={t("muteSystemAudio")}
			labelTrailing={
				<SettingResetButton
					isDefault={level === DEFAULT_SETTINGS.general.systemAudioReductionWhileDictating}
					onReset={() =>
						update({
							systemAudioReductionWhileDictating:
								DEFAULT_SETTINGS.general.systemAudioReductionWhileDictating,
						})
					}
				/>
			}
			tooltip={t("muteSystemAudioTooltip")}
		>
			<ElevatedSurface inline>
				<Slider
					aria-label={t("muteSystemAudio")}
					formatValue={(v) => reductionStepLabel(indexToReduction(v), t)}
					max={REDUCTION_STEPS.length - 1}
					min={0}
					onChange={(v) => update({ systemAudioReductionWhileDictating: indexToReduction(v) })}
					step={1}
					value={reductionToIndex(level)}
				/>
			</ElevatedSurface>
		</FormControl>
	);
}

export function OutputSettingsPanel(): ReactNode {
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const tg = useTranslations("general");
	const ta = useTranslations("audio");
	const tc = useTranslations("common");

	// Recording mode is owned by the Recording tab now — read it as a plain
	// store value to keep the source panels' `recordingMode !== 'listen'` gates
	// on the recording-sound + ducking controls. (See risksOrTodos.)
	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";

	// ── Paste Behavior (general.autoSubmit / general.autoSubmitKey) ──
	const autoSubmit = general?.autoSubmit ?? false;
	const autoSubmitKey = general?.autoSubmitKey ?? "enter";
	const autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[] = [
		{ value: "enter", label: tg("autoSubmitKeyEnter"), icon: ArrowTurnDownIcon },
		{ value: "ctrl_enter", label: tg("autoSubmitKeyCtrlEnter"), icon: KeyboardIcon },
	];

	// ── File Transcription format (general.fileTranscriptionFormat) ──
	const transcriptionFormat = general?.fileTranscriptionFormat ?? "txt";

	// ── Output Device (general.outputDeviceId; visible only when a playback
	//    source is enabled). recordingSound + tts.enabled live on other tabs;
	//    read them as plain store values to preserve the exact visibility gate
	//    (showOutputDevice = recordingSound || tts.enabled). (See risksOrTodos.)
	const outputDeviceId = useSettingsStore((s) => s.settings.general?.outputDeviceId ?? "");
	const recordingSoundEnabled = useSettingsStore((s) => s.settings.general?.recordingSound ?? true);
	const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
	const { devices: outputDevices, defaultDevice: defaultOutputDevice } = useOutputDevices();
	const showOutputDevice = recordingSoundEnabled || ttsEnabled;
	const outputDeviceOptions: SelectOption[] = (() => {
		const defaultLabel = defaultOutputDevice
			? `${ta("systemDefault")} (${defaultOutputDevice.label})`
			: ta("systemDefault");
		const opts: SelectOption[] = [{ id: "", label: defaultLabel, icon: ComputerIcon }];
		for (const d of outputDevices) {
			// Skip the "default" sentinel — Chromium emits a dedicated row
			// for it before the real default device. The empty string above
			// already represents the same concept.
			if (d.deviceId === "default" || d.deviceId === "") {
				continue;
			}
			opts.push({ id: d.deviceId, label: d.label, icon: VolumeHighIcon });
		}
		return opts;
	})();

	return (
		<div className="flex flex-col gap-2">
			{/* ── Paste Behavior ─────────────────────────────── */}
			<PasteBehaviorSection
				autoSubmit={autoSubmit}
				autoSubmitKey={autoSubmitKey}
				autoSubmitKeyOptions={autoSubmitKeyOptions}
				onChangeAutoSubmit={(v) => updateGeneral({ autoSubmit: v })}
				onChangeAutoSubmitKey={(v) => updateGeneral({ autoSubmitKey: v })}
				tg={tg}
			/>

			{/* ── File Transcription ─────────────────────────── */}
			<SettingSection icon={FileScriptIcon} title={tg("fileTranscription")}>
				<div className="flex flex-col divide-y divide-surface-1">
					<FormControl
						label={tg("fileTranscriptionFormat")}
						labelTrailing={
							<SettingResetButton
								isDefault={transcriptionFormat === DEFAULT_SETTINGS.general.fileTranscriptionFormat}
								onReset={() =>
									updateGeneral({
										fileTranscriptionFormat: DEFAULT_SETTINGS.general.fileTranscriptionFormat,
									})
								}
							/>
						}
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

			{/* ── Output Device (renderer-side; deviceId is consumed by
			    HTMLAudioElement.setSinkId for chimes and AudioContext for TTS).
			    Visible only when either the recording chimes are enabled or TTS
			    is enabled — those are the only paths that actually emit playback.
			    Empty string == "system default". */}
			{showOutputDevice && (
				<SettingSection icon={VolumeHighIcon} title={ta("outputDevice")}>
					<div className="flex flex-col divide-y divide-surface-1">
						<FormControl
							label={ta("outputDevice")}
							labelTrailing={
								<SettingResetButton
									isDefault={outputDeviceId === DEFAULT_SETTINGS.general.outputDeviceId}
									onReset={() =>
										updateGeneral({ outputDeviceId: DEFAULT_SETTINGS.general.outputDeviceId })
									}
								/>
							}
							layout="row"
							tooltip={ta("outputDeviceTooltip")}
						>
							<ElevatedSurface className="w-52" inline>
								<Select
									onChange={(v) => updateGeneral({ outputDeviceId: v })}
									options={outputDeviceOptions}
									value={outputDeviceId}
								/>
							</ElevatedSurface>
						</FormControl>
					</div>
				</SettingSection>
			)}

			{/* ── Recording Sound + Sound Library (hidden in Listen mode — no
			    chime plays for a server-driven loopback session). Mirrors the
			    GeneralSettingsPanel RecordingSection sound part verbatim. */}
			{isListenMode ? null : (
				<SettingSection icon={Mic01Icon} title={tg("recordingSound")}>
					<div className="flex flex-col divide-y divide-surface-1">
						<FormControl
							label={tg("recordingSound")}
							labelAddon={
								<Toggle
									checked={recordingSoundEnabled}
									onCheckedChange={(v) => updateGeneral({ recordingSound: v })}
								/>
							}
							labelTrailing={
								recordingSoundEnabled ? (
									<SettingResetButton
										isDefault={
											(general?.recordingSoundPath ?? "") ===
											DEFAULT_SETTINGS.general.recordingSoundPath
										}
										onReset={() =>
											updateGeneral({ recordingSoundPath: DEFAULT_SETTINGS.general.recordingSoundPath })
										}
									/>
								) : undefined
							}
							tooltip={tg("soundLibraryTooltip")}
						>
							{recordingSoundEnabled ? <SoundLibrary t={tg} tCommon={tc} /> : null}
						</FormControl>
					</div>
				</SettingSection>
			)}

			{/* ── Reduce system audio while dictating (ducking; hidden in Listen
			    mode). Mirrors GeneralSettingsPanel's MuteSystemAudioControl. */}
			{isListenMode ? null : (
				<SettingSection icon={DashboardCircleIcon} title={tg("muteSystemAudio")}>
					<div className="flex flex-col divide-y divide-surface-1">
						<MuteSystemAudioControl general={general} t={tg} update={updateGeneral} />
					</div>
				</SettingSection>
			)}
		</div>
	);
}
