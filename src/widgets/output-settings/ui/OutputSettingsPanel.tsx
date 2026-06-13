import {
	ArrowTurnDownIcon,
	ClipboardPasteIcon,
	ComputerIcon,
	FileScriptIcon,
	HeadphonesIcon,
	KeyboardIcon,
	PauseIcon,
	PlayIcon,
	Speaker01Icon,
	SubtitleIcon,
	Txt01Icon,
	VolumeMinusIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { useOutputDevices } from "@/entities/audio-device";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
	isSelectableRealtimeModel,
	modelSupportsSelectedSourceLanguages,
	useCatalogStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { useSoundPreview } from "@/features/recording-sound";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Tooltip } from "@/shared/ui/tooltip";
import { Toggle } from "@/shared/ui/toggle";

const REDUCTION_STEPS = [0, 20, 40, 60, 80, 100] as const;
const LISTEN_MODE_OUTPUT_DISABLED_TOOLTIP =
	"Listen mode only transcribes speaker audio inside the main app window; it never pastes, submits, previews, or mutes app audio.";

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

const TRANSCRIPTION_FORMAT_OPTIONS: readonly SwitcherOption<"txt" | "srt">[] = [
	{ value: "txt", label: "TXT", icon: Txt01Icon },
	{ value: "srt", label: "SRT", icon: SubtitleIcon },
] as const;

interface PasteBehaviorSectionProps {
	autoSubmit: boolean;
	autoSubmitKey: "enter" | "ctrl_enter";
	autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[];
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	previewBeforePasting: boolean;
	previewBeforePastingDisabled: boolean;
	previewBeforePastingDisabledTooltip: string | undefined;
	wordByWordPasting: boolean;
	wordByWordPastingDisabled: boolean;
	wordByWordPastingDisabledTooltip: string | undefined;
	onChangeAutoSubmit: (next: boolean) => void;
	onChangeAutoSubmitKey: (next: "enter" | "ctrl_enter") => void;
	onChangePreviewBeforePasting: (next: boolean) => void;
	onChangeWordByWordPasting: (next: boolean) => void;
	tg: GeneralT;
}

function PasteBehaviorSection({
	autoSubmit,
	autoSubmitKey,
	autoSubmitKeyOptions,
	disabled = false,
	disabledTooltip,
	previewBeforePasting,
	previewBeforePastingDisabled,
	previewBeforePastingDisabledTooltip,
	wordByWordPasting,
	wordByWordPastingDisabled,
	wordByWordPastingDisabledTooltip,
	onChangeAutoSubmit,
	onChangeAutoSubmitKey,
	onChangePreviewBeforePasting,
	onChangeWordByWordPasting,
	tg,
}: PasteBehaviorSectionProps): ReactNode {
	const effectiveAutoSubmit = disabled ? false : autoSubmit;
	const effectivePreviewBeforePasting = disabled ? false : previewBeforePasting;
	const effectiveWordByWordPasting = disabled ? false : wordByWordPasting;
	const autoSubmitKeyDisabled = disabled || !effectiveAutoSubmit;
	const previewDisabled = disabled || previewBeforePastingDisabled;
	const wordByWordDisabled = disabled || wordByWordPastingDisabled;
	const listenAwareAutoSubmitKeyOptions = disabled
		? autoSubmitKeyOptions.map((option) => ({
				...option,
				disabled: true,
				...(disabledTooltip ? { tooltip: disabledTooltip } : {}),
			}))
		: autoSubmitKeyOptions;
	return (
		<SettingSection
			divided
			icon={ClipboardPasteIcon}
			title={tg("pasteBehaviorTitle")}
		>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.autoSubmit}
				disabled={disabled}
				disabledTooltip={disabledTooltip}
				hideReset={disabled}
				label={tg("autoSubmit")}
				labelAddon={
					<Toggle
						checked={effectiveAutoSubmit}
						disabled={disabled}
						onCheckedChange={(next) => {
							if (!disabled) {
								onChangeAutoSubmit(next);
							}
						}}
					/>
				}
				onReset={() => onChangeAutoSubmit(DEFAULT_SETTINGS.general.autoSubmit)}
				tooltip={tg("autoSubmitTooltip")}
				value={effectiveAutoSubmit}
			/>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.autoSubmitKey}
				disabled={autoSubmitKeyDisabled}
				disabledTooltip={disabled ? disabledTooltip : undefined}
				hideReset={disabled}
				label={tg("autoSubmitKey")}
				layout="row"
				onReset={() =>
					onChangeAutoSubmitKey(DEFAULT_SETTINGS.general.autoSubmitKey)
				}
				tooltip={tg("autoSubmitKeyTooltip")}
				value={autoSubmitKey}
				{...(disabled ? {} : { disabledReason: tg("autoSubmit") })}
			>
				<ElevatedSurface className="w-72 max-w-full">
					<Switcher
						fullWidth
						onChange={(next) => {
							if (!disabled) {
								onChangeAutoSubmitKey(next);
							}
						}}
						options={listenAwareAutoSubmitKeyOptions}
						value={autoSubmitKey}
					/>
				</ElevatedSurface>
			</SettingField>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.previewBeforePasting}
				disabled={previewDisabled}
				disabledTooltip={
					disabled ? disabledTooltip : previewBeforePastingDisabledTooltip
				}
				hideReset={disabled}
				label={tg("previewBeforePasting")}
				labelAddon={
					<Toggle
						checked={effectivePreviewBeforePasting}
						disabled={previewDisabled}
						onCheckedChange={(next) => {
							if (!disabled) {
								onChangePreviewBeforePasting(next);
							}
						}}
					/>
				}
				onReset={() =>
					onChangePreviewBeforePasting(
						DEFAULT_SETTINGS.general.previewBeforePasting,
					)
				}
				tooltip={tg("previewBeforePastingTooltip")}
				value={effectivePreviewBeforePasting}
			/>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.wordByWordPasting}
				disabled={wordByWordDisabled}
				disabledTooltip={
					disabled ? disabledTooltip : wordByWordPastingDisabledTooltip
				}
				hideReset={disabled}
				label={tg("wordByWordPasting")}
				labelAddon={
					<Toggle
						checked={effectiveWordByWordPasting}
						disabled={wordByWordDisabled}
						onCheckedChange={(next) => {
							if (!disabled) {
								onChangeWordByWordPasting(next);
							}
						}}
					/>
				}
				onReset={() =>
					onChangeWordByWordPasting(DEFAULT_SETTINGS.general.wordByWordPasting)
				}
				tooltip={tg("wordByWordPastingTooltip")}
				value={effectiveWordByWordPasting}
			/>
		</SettingSection>
	);
}

interface MuteSystemAudioControlProps {
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	general: GeneralSettings | undefined;
	t: GeneralT;
	update: UpdateGeneralFn;
}

function MuteSystemAudioControl({
	disabled = false,
	disabledTooltip,
	general,
	t,
	update,
}: MuteSystemAudioControlProps): ReactNode {
	const level = disabled ? 0 : muteLevel(general);
	return (
		<SettingField
			defaultValue={DEFAULT_SETTINGS.general.systemAudioReductionWhileDictating}
			disabled={disabled}
			disabledTooltip={disabledTooltip}
			hideReset={disabled}
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
					onChange={(v) => {
						if (!disabled) {
							update({
								systemAudioReductionWhileDictating: indexToReduction(v),
							});
						}
					}}
					step={1}
					disabled={disabled}
					value={reductionToIndex(level)}
				/>
			</ElevatedSurface>
		</SettingField>
	);
}

interface OutputDevicePreviewButtonProps {
	active: boolean;
	deviceLabel: string;
	isPlaying: boolean;
	onToggle: () => void;
	playLabel: string;
	stopLabel: string;
}

function OutputDevicePreviewButton({
	active,
	deviceLabel,
	isPlaying,
	onToggle,
	playLabel,
	stopLabel,
}: OutputDevicePreviewButtonProps): ReactNode {
	const label = `${isPlaying ? stopLabel : playLabel}: ${deviceLabel}`;
	return (
		<Tooltip content={isPlaying ? stopLabel : playLabel}>
			<Button
				aria-label={label}
				className={cn(
					"flex size-6 shrink-0 items-center justify-center rounded-full transition-colors duration-150 active:scale-95",
					isPlaying
						? "bg-foreground/15 text-foreground hover:bg-foreground/25"
						: "bg-transparent text-foreground-muted hover:bg-foreground/10 hover:text-foreground",
					active && !isPlaying && "text-foreground-secondary",
				)}
				onClick={() => onToggle()}
			>
				<HugeiconsIcon icon={isPlaying ? PauseIcon : PlayIcon} size={13} />
			</Button>
		</Tooltip>
	);
}

function outputPreviewId(deviceId: string): string {
	return `output:${deviceId || "default"}`;
}

export function OutputSettingsPanel(): ReactNode {
	const general = useSettingsStore((s) => s.settings.general);
	const model = useSettingsStore((s) => s.settings.model);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
	const tg = useTranslations("general");
	const tm = useTranslations("model");
	const ts = useTranslations("settings");
	const tc = useTranslations("common");
	const getModel = useCatalogStore((s) => s.getModel);
	const [confirmWordByWordOpen, setConfirmWordByWordOpen] = useState(false);

	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";
	const autoSubmit = general?.autoSubmit ?? false;
	const autoSubmitKey = general?.autoSubmitKey ?? "enter";
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	const wordByWordPasting = general?.wordByWordPasting ?? false;
	const previewBeforePasting = wordByWordPasting
		? false
		: (general?.previewBeforePasting ?? false);
	const pillOff =
		!(general?.showRecordingOverlay ?? true) ||
		(general?.overlayPosition ?? "auto") === "none";
	const selectedModel = model?.model ?? DEFAULT_SETTINGS.model.model;
	const selectedInfo =
		providerOf(selectedModel) === null ? getModel(selectedModel) : undefined;
	const mainModelCanNativeStream =
		selectedInfo !== undefined && isSelectableRealtimeModel(selectedInfo);
	const realtimeSourceLanguageIncompatible =
		selectedInfo !== undefined &&
		mainModelCanNativeStream &&
		!modelSupportsSelectedSourceLanguages(selectedInfo, model, selectedInfo);
	const previewBeforePastingDisabled = pillOff || wordByWordPasting;
	const wordByWordPastingDisabled =
		!mainModelCanNativeStream ||
		realtimeSourceLanguageIncompatible ||
		previewBeforePasting;
	const previewBeforePastingDisabledTooltip = previewBeforePastingDisabled
		? wordByWordPasting
			? ts("disabledTurnOffReason", { name: tg("wordByWordPasting") })
			: ts("disabledReason", { name: tg("showRecordingOverlay") })
		: undefined;
	const wordByWordPastingDisabledTooltip = wordByWordPastingDisabled
		? previewBeforePasting
			? ts("disabledTurnOffReason", { name: tg("previewBeforePasting") })
			: realtimeSourceLanguageIncompatible
				? ts("disabledIncompatibleReason", { name: tm("language") })
				: ts("disabledChooseReason", {
						name: tg("wordByWordPastingRequirement"),
					})
		: undefined;
	const autoSubmitKeyOptions: SwitcherOption<"enter" | "ctrl_enter">[] = [
		{
			value: "enter",
			label: tg("autoSubmitKeyEnter"),
			icon: ArrowTurnDownIcon,
		},
		{
			value: "ctrl_enter",
			label: tg("autoSubmitKeyCtrlEnter"),
			icon: KeyboardIcon,
		},
	];
	const transcriptionFormat = general?.fileTranscriptionFormat ?? "txt";

	const enableWordByWordPasting = () => {
		updateLlmDictation({ enabled: false });
		updateGeneral({ wordByWordPasting: true, previewBeforePasting: false });
	};

	const handleWordByWordPastingChange = (next: boolean) => {
		if (!next) {
			updateGeneral({ wordByWordPasting: false });
			return;
		}
		if (llmDictationEnabled) {
			setConfirmWordByWordOpen(true);
			return;
		}
		enableWordByWordPasting();
	};

	const confirmWordByWordPasting = () => {
		enableWordByWordPasting();
		setConfirmWordByWordOpen(false);
	};

	return (
		<>
			<div className="flex flex-col gap-2">
				<PasteBehaviorSection
					autoSubmit={autoSubmit}
					autoSubmitKey={autoSubmitKey}
					autoSubmitKeyOptions={autoSubmitKeyOptions}
					disabled={isListenMode}
					disabledTooltip={
						isListenMode ? LISTEN_MODE_OUTPUT_DISABLED_TOOLTIP : undefined
					}
					onChangeAutoSubmit={(v) => updateGeneral({ autoSubmit: v })}
					onChangeAutoSubmitKey={(v) => updateGeneral({ autoSubmitKey: v })}
					onChangePreviewBeforePasting={(v) =>
						updateGeneral(
							v
								? { previewBeforePasting: true, wordByWordPasting: false }
								: { previewBeforePasting: false },
						)
					}
					onChangeWordByWordPasting={handleWordByWordPastingChange}
					previewBeforePastingDisabled={previewBeforePastingDisabled}
					previewBeforePastingDisabledTooltip={
						previewBeforePastingDisabledTooltip
					}
					previewBeforePasting={previewBeforePasting}
					tg={tg}
					wordByWordPasting={wordByWordPasting}
					wordByWordPastingDisabled={wordByWordPastingDisabled}
					wordByWordPastingDisabledTooltip={wordByWordPastingDisabledTooltip}
				/>

				<SettingSection
					divided
					icon={FileScriptIcon}
					title={tg("fileTranscription")}
				>
					<SettingField
						defaultValue={DEFAULT_SETTINGS.general.fileTranscriptionFormat}
						label={tg("fileTranscriptionFormat")}
						layout="row"
						onReset={() =>
							updateGeneral({
								fileTranscriptionFormat:
									DEFAULT_SETTINGS.general.fileTranscriptionFormat,
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
			</div>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={tg("wordByWordDisablePostProcessingConfirm")}
				description={tg("wordByWordDisablePostProcessingDescription")}
				onConfirm={confirmWordByWordPasting}
				onOpenChange={setConfirmWordByWordOpen}
				open={confirmWordByWordOpen}
				title={tg("wordByWordDisablePostProcessingTitle")}
			/>
		</>
	);
}

export function PlaybackSettingsPanel(): ReactNode {
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const tg = useTranslations("general");
	const ta = useTranslations("audio");
	const tt = useTranslations("tts");

	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";
	const outputDeviceId = useSettingsStore(
		(s) => s.settings.general?.outputDeviceId ?? "",
	);
	const recordingSoundPath = useSettingsStore(
		(s) => s.settings.general?.recordingSoundPath ?? "",
	);
	const recordingSoundEnabled = useSettingsStore(
		(s) => s.settings.general?.recordingSound ?? true,
	);
	const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
	const { devices: outputDevices, defaultDevice: defaultOutputDevice } =
		useOutputDevices();
	const soundPreview = useSoundPreview();
	const showOutputDevice = isListenMode || recordingSoundEnabled || ttsEnabled;
	const outputPreviewPlayLabel = tg("soundLibraryPlay");
	const outputPreviewStopLabel = tg("soundLibraryStop");
	const outputDeviceOptions: SelectOption[] = (() => {
		const defaultLabel = defaultOutputDevice
			? `${ta("systemDefault")} (${defaultOutputDevice.label})`
			: ta("systemDefault");
		const opts: SelectOption[] = [
			{
				id: "",
				label: defaultLabel,
				icon: ComputerIcon,
				trailing: (
					<OutputDevicePreviewButton
						active={outputDeviceId === ""}
						deviceLabel={defaultLabel}
						isPlaying={soundPreview.playingId === outputPreviewId("")}
						onToggle={() =>
							void soundPreview.toggle(
								outputPreviewId(""),
								recordingSoundPath,
								"",
							)
						}
						playLabel={outputPreviewPlayLabel}
						stopLabel={outputPreviewStopLabel}
					/>
				),
			},
		];
		for (const d of outputDevices) {
			if (d.deviceId === "default" || d.deviceId === "") {
				continue;
			}
			opts.push({
				id: d.deviceId,
				label: d.label,
				icon: Speaker01Icon,
				trailing: (
					<OutputDevicePreviewButton
						active={outputDeviceId === d.deviceId}
						deviceLabel={d.label}
						isPlaying={soundPreview.playingId === outputPreviewId(d.deviceId)}
						onToggle={() =>
							void soundPreview.toggle(
								outputPreviewId(d.deviceId),
								recordingSoundPath,
								d.deviceId,
							)
						}
						playLabel={outputPreviewPlayLabel}
						stopLabel={outputPreviewStopLabel}
					/>
				),
			});
		}
		return opts;
	})();

	return (
		<div className="flex flex-col gap-2">
			<SettingSection divided icon={HeadphonesIcon} title={ta("outputDevice")}>
				<SettingField
					defaultValue={DEFAULT_SETTINGS.general.outputDeviceId}
					disabled={!showOutputDevice}
					disabledReason={`${tg("recordingSound")} / ${tt("title")}`}
					label={ta("outputDevice")}
					layout="row"
					onReset={() =>
						updateGeneral({
							outputDeviceId: DEFAULT_SETTINGS.general.outputDeviceId,
						})
					}
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

			<SettingSection
				divided
				icon={VolumeMinusIcon}
				title={tg("muteSystemAudio")}
			>
				<MuteSystemAudioControl
					disabled={isListenMode}
					disabledTooltip={
						isListenMode ? LISTEN_MODE_OUTPUT_DISABLED_TOOLTIP : undefined
					}
					general={general}
					t={tg}
					update={updateGeneral}
				/>
			</SettingSection>
		</div>
	);
}
