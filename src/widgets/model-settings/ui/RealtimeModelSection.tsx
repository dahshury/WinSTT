import { Activity03Icon } from "@hugeicons/core-free-icons";
import { SttModelSelector } from "@picker";
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
import type { OnnxQuantization } from "@/shared/config/defaults";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
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
	settings: ModelSettings | undefined;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
	updateQuality: UpdateQualityFn;
}

// Always rendered when the parent decides realtime is on — there is no
// on/off toggle here anymore. The realtime engine's lifecycle is derived
// from `general.liveTranscriptionDisplay` (see `isRealtimeEnabled`); without
// a display surface the engine wouldn't have any observable output, so the
// section itself is gated by the parent instead.
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
	return (
		<SettingSection icon={Activity03Icon} title={t("realtimeModelSection")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl label={t("realtimeModel")} tooltip={realtimeTooltip}>
						<SttModelSelector
							currentQuantization={currentQuantization}
							disabled={mainModelCanNativeStream}
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
							placeholder={t("useMainModel")}
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
				{updateIntervalApplies ? (
					<SettingField
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
						<ElevatedSurface className="w-fit" inline>
							<NumberStepper
								min={0.01}
								onChange={(v) => updateQuality({ realtimeProcessingPause: v })}
								step={0.01}
								value={
									quality?.realtimeProcessingPause ??
									DEFAULT_SETTINGS.quality.realtimeProcessingPause
								}
							/>
						</ElevatedSurface>
					</SettingField>
				) : null}
			</div>
		</SettingSection>
	);
}
