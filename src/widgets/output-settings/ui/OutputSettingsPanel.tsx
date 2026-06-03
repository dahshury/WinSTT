import {
	ArrowTurnDownIcon,
	BellRingIcon,
	ClipboardPasteIcon,
	ComputerIcon,
	FileScriptIcon,
	HeadphonesIcon,
	KeyboardIcon,
	Speaker01Icon,
	SubtitleIcon,
	Txt01Icon,
	VolumeMinusIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useOutputDevices } from "@/entities/audio-device";
import { DEFAULT_SETTINGS, SettingField, SettingSection, useSettingsStore } from "@/entities/setting";
import { SoundLibrary } from "@/features/recording-sound";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

// System-audio ducking step math. This is the canonical home (the General/Audio
// settings widgets it once lived alongside were folded away in the IA reorg);
// FSD forbids importing it across the widgets slice, so it lives here with its
// sole consumer — the "Reduce system audio while dictating" slider.
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

// File-transcription output format options (the same two formats + labels — the
// labels are intentionally hardcoded English, not i18n — and icons).
const TRANSCRIPTION_FORMAT_OPTIONS: readonly SwitcherOption<"txt" | "srt">[] = [
	{ value: "txt", label: "TXT", icon: Txt01Icon },
	{ value: "srt", label: "SRT", icon: SubtitleIcon },
] as const;

interface PasteBehaviorSectionProps {
	autoSubmit: boolean;
	autoSubmitKey: "enter" | "ctrl_enter";
	autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[];
	previewBeforePasting: boolean;
	pillOff: boolean;
	onChangeAutoSubmit: (next: boolean) => void;
	onChangeAutoSubmitKey: (next: "enter" | "ctrl_enter") => void;
	onChangePreviewBeforePasting: (next: boolean) => void;
	tg: GeneralT;
}

function PasteBehaviorSection({
	autoSubmit,
	autoSubmitKey,
	autoSubmitKeyOptions,
	previewBeforePasting,
	pillOff,
	onChangeAutoSubmit,
	onChangeAutoSubmitKey,
	onChangePreviewBeforePasting,
	tg,
}: PasteBehaviorSectionProps): ReactNode {
	return (
		<SettingSection divided icon={ClipboardPasteIcon} title={tg("pasteBehaviorTitle")}>
			{/* Preview-before-pasting depends on the recording pill being shown
			    (the preview IS the pill) — shown disabled (not hidden) when the
			    pill is off so it stays discoverable. */}
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.previewBeforePasting}
				disabled={pillOff}
				disabledReason={tg("showRecordingOverlay")}
				label={tg("previewBeforePasting")}
				labelAddon={
					<Toggle
						checked={previewBeforePasting}
						disabled={pillOff}
						onCheckedChange={onChangePreviewBeforePasting}
					/>
				}
				onReset={() => onChangePreviewBeforePasting(DEFAULT_SETTINGS.general.previewBeforePasting)}
				tooltip={tg("previewBeforePastingTooltip")}
				value={previewBeforePasting}
			/>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.autoSubmit}
				label={tg("autoSubmit")}
				labelAddon={<Toggle checked={autoSubmit} onCheckedChange={onChangeAutoSubmit} />}
				onReset={() => onChangeAutoSubmit(DEFAULT_SETTINGS.general.autoSubmit)}
				tooltip={tg("autoSubmitTooltip")}
				value={autoSubmit}
			/>
			{/* Submit-key depends on Auto-submit being on — shown disabled
			    (not hidden) when off so it stays discoverable. */}
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.autoSubmitKey}
				disabled={!autoSubmit}
				disabledReason={tg("autoSubmit")}
				label={tg("autoSubmitKey")}
				layout="row"
				onReset={() => onChangeAutoSubmitKey(DEFAULT_SETTINGS.general.autoSubmitKey)}
				tooltip={tg("autoSubmitKeyTooltip")}
				value={autoSubmitKey}
			>
				<ElevatedSurface className="w-52">
					<Switcher
						fullWidth
						onChange={onChangeAutoSubmitKey}
						options={autoSubmitKeyOptions}
						value={autoSubmitKey}
					/>
				</ElevatedSurface>
			</SettingField>
		</SettingSection>
	);
}

interface MuteSystemAudioControlProps {
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateGeneralFn;
}

function MuteSystemAudioControl({ general, t, update }: MuteSystemAudioControlProps): ReactNode {
	const level = muteLevel(general);
	return (
		<SettingField
			defaultValue={DEFAULT_SETTINGS.general.systemAudioReductionWhileDictating}
			label={t("muteSystemAudio")}
			onReset={() =>
				update({
					systemAudioReductionWhileDictating:
						DEFAULT_SETTINGS.general.systemAudioReductionWhileDictating,
				})
			}
			tooltip={t("muteSystemAudioTooltip")}
			value={level}
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
		</SettingField>
	);
}

export function OutputSettingsPanel(): ReactNode {
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const tg = useTranslations("general");
	const ta = useTranslations("audio");
	const tc = useTranslations("common");
	const ts = useTranslations("settings");
	const tt = useTranslations("tts");

	// Recording mode is owned by the Recording tab now — read it as a plain
	// store value to keep the source panels' `recordingMode !== 'listen'` gates
	// on the recording-sound + ducking controls. (See risksOrTodos.)
	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";

	// ── Paste Behavior (general.autoSubmit / general.autoSubmitKey) ──
	const autoSubmit = general?.autoSubmit ?? false;
	const autoSubmitKey = general?.autoSubmitKey ?? "enter";
	const previewBeforePasting = general?.previewBeforePasting ?? false;
	// Preview-before-pasting needs the recording pill shown (the preview IS the
	// pill). Mirror the backend gate (`overlay_is_active`): off when the overlay
	// is disabled or positioned to "none".
	const pillOff =
		!(general?.showRecordingOverlay ?? true) || (general?.overlayPosition ?? "auto") === "none";
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
			opts.push({ id: d.deviceId, label: d.label, icon: Speaker01Icon });
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
				onChangePreviewBeforePasting={(v) => updateGeneral({ previewBeforePasting: v })}
				pillOff={pillOff}
				previewBeforePasting={previewBeforePasting}
				tg={tg}
			/>

			{/* ── File Transcription ─────────────────────────── */}
			<SettingSection divided icon={FileScriptIcon} title={tg("fileTranscription")}>
				<SettingField
					defaultValue={DEFAULT_SETTINGS.general.fileTranscriptionFormat}
					label={tg("fileTranscriptionFormat")}
					layout="row"
					onReset={() =>
						updateGeneral({
							fileTranscriptionFormat: DEFAULT_SETTINGS.general.fileTranscriptionFormat,
						})
					}
					tooltip={tg("fileTranscriptionFormatTooltip")}
					value={transcriptionFormat}
				>
					<ElevatedSurface className="w-52">
						<Switcher
							fullWidth
							onChange={(v) => updateGeneral({ fileTranscriptionFormat: v })}
							options={TRANSCRIPTION_FORMAT_OPTIONS}
							value={transcriptionFormat}
						/>
					</ElevatedSurface>
				</SettingField>
			</SettingSection>

			{/* ── Output Device (renderer-side; deviceId is consumed by
			    HTMLAudioElement.setSinkId for chimes and AudioContext for TTS).
			    Only the recording chimes / TTS actually emit playback, so the
			    picker is shown disabled (not hidden) until one of those is on.
			    Empty string == "system default". */}
			<SettingSection divided icon={HeadphonesIcon} title={ta("outputDevice")}>
				<SettingField
					defaultValue={DEFAULT_SETTINGS.general.outputDeviceId}
					disabled={!showOutputDevice}
					disabledReason={`${tg("recordingSound")} / ${tt("title")}`}
					label={ta("outputDevice")}
					layout="row"
					onReset={() => updateGeneral({ outputDeviceId: DEFAULT_SETTINGS.general.outputDeviceId })}
					tooltip={ta("outputDeviceTooltip")}
					value={outputDeviceId}
				>
					<ElevatedSurface className="w-52" inline>
						<Select
							onChange={(v) => updateGeneral({ outputDeviceId: v })}
							options={outputDeviceOptions}
							value={outputDeviceId}
						/>
					</ElevatedSurface>
				</SettingField>
			</SettingSection>

			{/* ── Recording Sound + Sound Library (hidden in Listen mode — no
			    chime plays for a server-driven loopback session). */}
			{isListenMode ? null : (
				<SettingSection divided icon={BellRingIcon} title={tg("recordingSound")}>
					<SettingField
						defaultValue={DEFAULT_SETTINGS.general.recordingSoundPath}
						hideReset={!recordingSoundEnabled}
						label={tg("recordingSound")}
						labelAddon={
							<Toggle
								checked={recordingSoundEnabled}
								onCheckedChange={(v) => updateGeneral({ recordingSound: v })}
							/>
						}
						onReset={() =>
							updateGeneral({ recordingSoundPath: DEFAULT_SETTINGS.general.recordingSoundPath })
						}
						tooltip={
							recordingSoundEnabled
								? tg("soundLibraryTooltip")
								: `${tg("soundLibraryTooltip")} ${ts("disabledReason", { name: tg("recordingSound") })}`
						}
						value={general?.recordingSoundPath ?? ""}
					>
						{/* Library depends on the recording-sound toggle (the labelAddon
						    above, which must stay interactive) — so dim only the library,
						    not the whole control, when the chime is off. */}
						<div
							className={cn(
								"transition-opacity duration-200 ease-out",
								!recordingSoundEnabled && "pointer-events-none opacity-40"
							)}
						>
							<SoundLibrary t={tg} tCommon={tc} />
						</div>
					</SettingField>
				</SettingSection>
			)}

			{/* ── Reduce system audio while dictating (ducking; hidden in Listen
			    mode). */}
			{isListenMode ? null : (
				<SettingSection divided icon={VolumeMinusIcon} title={tg("muteSystemAudio")}>
					<MuteSystemAudioControl general={general} t={tg} update={updateGeneral} />
				</SettingSection>
			)}
		</div>
	);
}
