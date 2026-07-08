import { Activity03Icon } from "@hugeicons/core-free-icons";
import { SttModelSelector } from "@/widgets/model-picker";
import type { ReactNode } from "react";
import {
	isSelectableRealtimeModel,
	modelSupportsSelectedSourceLanguages,
	modelsHaveLanguageOverlap,
	type SourceLanguageSelection,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import { openModelPickerAtRect } from "@/shared/api/model-picker-window";
import type { OnnxQuantization } from "@/shared/config/defaults";
import type { SelectOption } from "@/shared/ui/select";
import { FormControl } from "@/shared/ui/form-control";
import { LanguageMultiCombobox } from "@/shared/ui/language-multi-combobox";
import { NumberStepper } from "@/shared/ui/number-stepper";
import type {
	CatalogModels,
	GetFitAssessment,
	ModelSettings,
	QualitySettings,
	StatesById,
	SystemInfo,
	TFn,
	UpdateQualityFn,
} from "../lib/types";

interface RealtimeModelSectionProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentQuantization: OnnxQuantization;
	/** Same shape as MainModelSection — drives the realtime trigger's
	 *  download-aware variant when a realtime swap is in flight. */
	downloadProgress: { modelId: string; percent: number | null } | null;
	/** True when no live-transcription surface is enabled, so realtime preview
	 *  has no observable output. The whole section greys out and becomes
	 *  non-interactive. Derived from `isRealtimeEnabled` in the parent. */
	disabled: boolean;
	/** Reason shown on the greyed controls when `disabled` is true. */
	disabledTooltip: string;
	/** Master switch handler — writes the underlying consumer settings (see
	 *  `realtimeMasterTogglePatch`); the switch itself stores nothing. */
	onToggle: (next: boolean) => void;
	/** True when the switch can't be flipped (listen mode always streams;
	 *  language guard would immediately revert an enable). */
	toggleDisabled: boolean;
	/** Reason shown on hover over the disabled switch. */
	toggleDisabledTooltip: string | undefined;
	getFitAssessment: GetFitAssessment;
	handleRealtimeModelChange: (
		modelId: string,
		quantization?: OnnxQuantization,
	) => void;
	isSwapping: boolean;
	/** True when the main model can provide native streaming preview output. */
	mainModelCanNativeStream: boolean;
	mainModelId: string;
	mainModelInfo: CatalogModels[number] | undefined;
	/** True when the worker still uses interval-gated window re-decode. */
	updateIntervalApplies: boolean;
	canDeleteQuant: (modelId: string, quantization: OnnxQuantization) => boolean;
	/** Forwarded to the picker — same handler the main picker uses. */
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	/** Forwarded to the picker — per-quant download action. */
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization,
	) => void;
	/** Forwarded to the picker — per-quant download snapshot lookup. */
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization,
	) => import("@/features/model-download").QuantDownloadState | undefined;
	quality: QualitySettings | undefined;
	sourceLanguageSelection: SourceLanguageSelection | undefined;
	/** Language options for the realtime language picker (same list the main model uses). */
	langOpts: SelectOption[];
	/** Forced language for a multilingual realtime model (`""` = auto-detect). */
	realtimeLanguage: string;
	onRealtimeLanguageChange: (language: string) => void;
	settings: ModelSettings | undefined;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
	updateQuality: UpdateQualityFn;
}

// The section header carries a VIRTUAL master switch: realtime enablement
// stays derived from its consumers (`general.liveTranscriptionDisplay` +
// word-by-word pasting, see `isRealtimeEnabled`) — no separate stored flag.
// The switch reads that derived state and writes the consumers themselves
// (`realtimeMasterTogglePatch` in the parent), so the Model tab finally has
// one visible on/off for "is the realtime engine loaded" without introducing
// a redundant setting or an invalid "on with no consumer" combination.
export function RealtimeModelSection({
	t,
	settings,
	quality,
	updateQuality,
	catalogModels,
	catalogLoaded,
	statesById,
	systemInfo,
	currentQuantization,
	disabled,
	disabledTooltip,
	onToggle,
	toggleDisabled,
	toggleDisabledTooltip,
	downloadProgress,
	getFitAssessment,
	isSwapping,
	handleRealtimeModelChange,
	mainModelId,
	mainModelInfo,
	onDeleteQuant,
	canDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	mainModelCanNativeStream,
	updateIntervalApplies,
	sourceLanguageSelection,
	langOpts,
	realtimeLanguage,
	onRealtimeLanguageChange,
}: RealtimeModelSectionProps): ReactNode {
	// The realtime slot is normally a separate native-streaming preview engine.
	// When the main model itself can natively stream, it owns this slot too.
	const realtimeModelId = settings?.realtimeModel ?? "";
	const displayedRealtimeModelId = mainModelCanNativeStream
		? mainModelId
		: realtimeModelId;
	const realtimeTooltip = mainModelCanNativeStream
		? `${t("realtimeModelCaption")} ${t("useMainModelTooltip")}`
		: `${t("realtimeModelCaption")} ${t("realtimeModelTooltip")}`;
	// The selector is non-interactive either because the main model already
	// owns the realtime slot (auto-reuse) or because realtime has no enabled
	// output surface (`disabled`). Both collapse onto the same picker state.
	const selectorDisabled = mainModelCanNativeStream || disabled;
	// The realtime language picker only makes sense for a multilingual realtime model (e.g. the
	// Nemotron-3.5 prompt model); English-only streaming models auto-transcribe and hide it.
	const realtimeInfo = catalogModels.find(
		(m) => m.id === displayedRealtimeModelId,
	);
	const realtimeMultilingual = realtimeInfo?.supportsLanguageDetection ?? false;
	const realtimeLanguageValue = realtimeLanguage ? [realtimeLanguage] : [];
	return (
		<SettingSection
			boxed
			icon={Activity03Icon}
			onToggle={onToggle}
			title={t("realtimePreviewSection")}
			toggleDisabled={toggleDisabled}
			toggleDisabledTooltip={toggleDisabledTooltip}
			toggled={!disabled}
		>
			<div className="flex flex-col divide-y divide-divider">
				<div>
					<FormControl
						controlTooltip={disabled ? disabledTooltip : undefined}
						disabled={disabled}
						label={t("realtimeModel")}
						tooltip={realtimeTooltip}
					>
						<SttModelSelector
							currentQuantization={currentQuantization}
							disabled={selectorDisabled}
							downloadProgress={downloadProgress}
							getFitAssessment={getFitAssessment}
							isLoading={!catalogLoaded || isSwapping}
							kind="realtime"
							models={catalogModels}
							onChange={handleRealtimeModelChange}
							canDeleteQuant={canDeleteQuant}
							onDeleteQuant={onDeleteQuant}
							onDownloadAction={onDownloadAction}
							onDownloadSnapshot={onDownloadSnapshot}
							onOpenDetached={(rect) =>
								openModelPickerAtRect(rect, { pickerKind: "stt-realtime" })
							}
							placeholder={t("realtimeModelPlaceholder")}
							prefilter={(m) =>
								isSelectableRealtimeModel(m) &&
								(mainModelInfo === undefined
									? modelSupportsSelectedSourceLanguages(
											m,
											sourceLanguageSelection,
											mainModelInfo,
										)
									: modelsHaveLanguageOverlap(mainModelInfo, m) &&
										modelSupportsSelectedSourceLanguages(
											m,
											sourceLanguageSelection,
											mainModelInfo,
										))
							}
							statesById={statesById}
							systemInfo={systemInfo}
							value={displayedRealtimeModelId}
						/>
					</FormControl>
				</div>
				{realtimeMultilingual ? (
					<div>
						<FormControl
							controlTooltip={disabled ? disabledTooltip : undefined}
							disabled={selectorDisabled}
							label={t("realtimeLanguage")}
							tooltip={t("realtimeLanguageTooltip")}
						>
							<LanguageMultiCombobox
								ariaLabel={t("realtimeLanguage")}
								disabled={selectorDisabled}
								emptyLabel={t("languageNoResults")}
								onChange={(value) => {
									if (selectorDisabled) {
										return;
									}
									// Prompt models take a single language; keep the most recently
									// picked one ("" = auto-detect when cleared).
									onRealtimeLanguageChange(value.at(-1) ?? "");
								}}
								options={langOpts}
								placeholder={t("realtimeLanguageAuto")}
								removeLabel={(language) => t("languageRemove", { language })}
								selectedCountLabel={(count) => `${count}`}
								selectedHeading={t("languageSelectedHeading")}
								value={realtimeLanguageValue}
							/>
						</FormControl>
					</div>
				) : null}
				{updateIntervalApplies ? (
					<SettingField
						disabled={disabled}
						disabledTooltip={disabled ? disabledTooltip : undefined}
						hideReset={disabled}
						isDefault={
							(quality?.realtimeProcessingPause ??
								DEFAULT_SETTINGS.quality.realtimeProcessingPause) ===
							DEFAULT_SETTINGS.quality.realtimeProcessingPause
						}
						label={t("updateInterval")}
						layout="row"
						onReset={() =>
							updateQuality({
								realtimeProcessingPause:
									DEFAULT_SETTINGS.quality.realtimeProcessingPause,
							})
						}
						tooltip={t("updateIntervalTooltip")}
					>
						<NumberStepper
							disabled={disabled}
							min={0.01}
							onChange={(v) => updateQuality({ realtimeProcessingPause: v })}
							step={0.01}
							value={
								quality?.realtimeProcessingPause ??
								DEFAULT_SETTINGS.quality.realtimeProcessingPause
							}
						/>
					</SettingField>
				) : null}
			</div>
		</SettingSection>
	);
}
