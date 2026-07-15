import {
	ArrowTurnDownIcon,
	ClipboardPasteIcon,
	FileScriptIcon,
	HeadphonesIcon,
	KeyboardIcon,
	VolumeMinusIcon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
	isSelectableRealtimeModel,
	modelSupportsSelectedSourceLanguages,
	useCatalogStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	type GeneralSettings,
	type GeneralT,
	SettingField,
	SettingSection,
	type UpdateGeneralFn,
	useSettingsStore,
} from "@/entities/setting";
import { useOutputDevicePicker } from "@/features/listen-mode";
import {
	buildOutputDeviceOptions,
	useSoundPreview,
} from "@/features/recording-sound";
import { outputDeviceRoutingSupported } from "@/shared/lib/web-audio";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { MultiCombobox } from "@/shared/ui/language-multi-combobox";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import {
	resolveSelectedFormats,
	transcriptionFormatsEqual,
	type FileTranscriptionFormat,
} from "../lib/transcription-formats";

const REDUCTION_STEPS = [0, 20, 40, 60, 80, 100] as const;
// Selecting a non-default playback device happens in the renderer via
// `AudioContext.setSinkId`, which only Chromium (WebView2) ships. On WKWebView
// (macOS) / WebKitGTK (Linux) the method is absent, so routing silently stays
// on the system default — surface that instead of offering a dead picker.
const OUTPUT_ROUTING_UNSUPPORTED_TOOLTIP =
	"This platform's web engine can't route audio to a specific device; playback uses the system default output.";
const LISTEN_MODE_OUTPUT_DISABLED_TOOLTIP =
	"Listen mode only transcribes speaker audio inside the main app window; it never pastes, submits, previews, or mutes app audio.";

function reductionToIndex(pct: number): number {
	const idx = REDUCTION_STEPS.indexOf(pct as (typeof REDUCTION_STEPS)[number]);
	return idx === -1 ? 0 : idx;
}

function indexToReduction(index: number): number {
	return REDUCTION_STEPS[index] ?? 0;
}

function reductionStepLabel(pct: number, t: GeneralT): string {
	if (pct <= 0) {
		return t("systemAudioReductionOff");
	}
	return pct >= 100 ? t("systemAudioReductionMute") : `${pct}%`;
}

function muteLevel(settings: GeneralSettings | undefined): number {
	return settings?.systemAudioReductionWhileDictating ?? 0;
}

const TRANSCRIPTION_FORMAT_OPTIONS: readonly {
	id: FileTranscriptionFormat;
	label: string;
}[] = [
	{ id: "txt", label: "TXT" },
	{ id: "srt", label: "SRT" },
	{ id: "vtt", label: "VTT" },
	{ id: "json", label: "JSON" },
	{ id: "csv", label: "CSV" },
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
			boxed
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
				<Switcher
					className="w-72 max-w-full"
					fullWidth
					onChange={(next) => {
						if (!disabled) {
							onChangeAutoSubmitKey(next);
						}
					}}
					options={listenAwareAutoSubmitKeyOptions}
					value={autoSubmitKey}
				/>
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
		</SettingField>
	);
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
	const selectedTranscriptionFormats = resolveSelectedFormats(
		general ?? DEFAULT_SETTINGS.general,
	);
	const defaultTranscriptionFormats = resolveSelectedFormats(
		DEFAULT_SETTINGS.general,
	);

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
			<div className="flex flex-col">
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
					boxed
					divided
					icon={FileScriptIcon}
					title={tg("fileTranscription")}
				>
					<SettingField
						isDefault={transcriptionFormatsEqual(
							selectedTranscriptionFormats,
							defaultTranscriptionFormats,
						)}
						label={tg("fileTranscriptionFormat")}
						layout="row"
						onReset={() =>
							updateGeneral({
								fileTranscriptionFormats: defaultTranscriptionFormats,
							})
						}
						tooltip={tg("fileTranscriptionFormatTooltip")}
						value={selectedTranscriptionFormats}
					>
						<ElevatedSurface className="w-52" inline>
							<MultiCombobox
								ariaLabel={tg("fileTranscriptionFormat")}
								emptyLabel={tc("noResults")}
								onChange={(formats) => {
									// Every transcription needs at least one export. Ignore an
									// attempt to remove the final checked format.
									if (formats.length > 0) {
										updateGeneral({ fileTranscriptionFormats: formats });
									}
								}}
								options={TRANSCRIPTION_FORMAT_OPTIONS}
								placeholder={tg("fileTranscriptionFormatCaption")}
								removeLabel={(format) =>
									tm("languageRemove", { language: format })
								}
								selectedCountLabel={(count) => `${count}+`}
								selectedHeading={tm("languageSelectedHeading")}
								value={selectedTranscriptionFormats}
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
	const recordingSoundPath = useSettingsStore(
		(s) => s.settings.general?.recordingSoundPath ?? "",
	);
	const recordingSoundEnabled = useSettingsStore(
		(s) => s.settings.general?.recordingSound ?? true,
	);
	const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
	// Selecting a device writes BOTH the browser sink id (playback routing) and
	// the resolved loopback index (the listen-mode capture device), so an Output
	// tab change also re-targets listen mode + updates the footer pill.
	const { entries, currentId, select } = useOutputDevicePicker({
		systemDefaultLabel: ta("systemDefault"),
	});
	const soundPreview = useSoundPreview();
	// Web engines without `AudioContext.setSinkId` (WKWebView / WebKitGTK) can't
	// honour a device pick — disable the selector with an explanatory tooltip
	// rather than letting the user pick a device that never takes effect.
	const routingSupported = outputDeviceRoutingSupported();
	const showOutputDevice = isListenMode || recordingSoundEnabled || ttsEnabled;
	const outputDeviceDisabled = !(showOutputDevice && routingSupported);
	const outputDeviceOptions: SelectOption[] = buildOutputDeviceOptions({
		entries,
		currentId,
		playingId: soundPreview.playingId,
		soundPath: recordingSoundPath,
		toggle: soundPreview.toggle,
		playLabel: tg("soundLibraryPlay"),
		stopLabel: tg("soundLibraryStop"),
	});

	return (
		<div className="flex flex-col">
			<SettingSection
				boxed
				divided
				icon={HeadphonesIcon}
				title={ta("playbackRouting")}
			>
				<SettingField
					defaultValue={DEFAULT_SETTINGS.general.outputDeviceId}
					disabled={outputDeviceDisabled}
					disabledReason={`${tg("recordingSound")} / ${tt("title")}`}
					disabledTooltip={
						routingSupported ? undefined : OUTPUT_ROUTING_UNSUPPORTED_TOOLTIP
					}
					label={ta("outputDevice")}
					layout="row"
					onReset={() => select(DEFAULT_SETTINGS.general.outputDeviceId)}
					tooltip={ta("outputDeviceTooltip")}
					value={currentId}
				>
					<Select
						className="w-52"
						onChange={select}
						options={outputDeviceOptions}
						value={currentId}
					/>
				</SettingField>
			</SettingSection>

			<SettingSection
				boxed
				divided
				icon={VolumeMinusIcon}
				title={tg("systemAudioSection")}
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
