import { AiMicIcon } from "@hugeicons/core-free-icons";
import { SttModelSelector } from "@/widgets/model-picker";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
	isVisibleSttModel,
	resolveLocalDefault,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import {
	CloudModelSelect,
	useSttSourceSwitch,
} from "@/features/select-cloud-stt-model";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { LanguageMultiCombobox } from "@/shared/ui/language-multi-combobox";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import {
	fixedLanguageValue,
	normalizeLanguageCandidates,
	normalizeLanguageCandidatesAllowEmpty,
} from "../lib/language-controls";
import type {
	CatalogModels,
	GetFitAssessment,
	LanguageControlMode,
	ModelSettings,
	StatesById,
	SystemInfo,
	TFn,
	UpdateModelFn,
} from "../lib/types";

function openDetachedPicker(rect: DOMRect): void {
	ipcSend(IPC.MODEL_PICKER_OPEN, {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height,
	});
}

interface MainModelSectionProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentQuantization: OnnxQuantization;
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	/** Snapshot of the in-flight download (model id + percent). Drives the
	 *  picker's "Downloading X · 23%" trigger AND distinguishes "we're
	 *  fetching bytes" from "the server is loading weights" so the picker
	 *  doesn't lock down for the entire multi-GB download. */
	downloadProgress: { modelId: string; percent: number | null } | null;
	getFitAssessment: GetFitAssessment;
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	isSwapping: boolean;
	languageAutoDetect: boolean;
	languageAutoDetectSupported: boolean;
	languageCandidates: string[];
	languageControlMode: LanguageControlMode;
	langOpts: SelectOption[];
	/** Per-quant delete handler (after the picker's AlertDialog confirms). */
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	canDeleteQuant: (modelId: string, quantization: OnnxQuantization) => boolean;
	/** Per-quant download action — start / pause / resume / cancel. */
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization,
	) => void;
	/** Per-quant live download snapshot lookup. */
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization,
	) => import("@/features/model-download").QuantDownloadState | undefined;
	/** Which optional sub-sections to render. Each flag is `false` when the
	 *  active model makes that control meaningless (cloud delegates language /
	 *  unload to the provider; single-language models hide the language picker).
	 *  The compute-device control is NOT here — it moved out to its own
	 *  top-level {@link DeviceSection} because it's shared by local STT *and*
	 *  local TTS, so it can't belong to the STT section. */
	sections: {
		/** Language picker. False for single-language models (the only choice
		 *  would be a no-op "auto-detect") or cloud (the provider handles it). */
		language: boolean;
		/** Idle model-unload timeout. False for cloud (no local ONNX session
		 *  to unload). */
	};
	selectedModel: string;
	settings: ModelSettings | undefined;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
	/** True when the active model supports a decoder-level translate
	 *  path (Whisper multilingual variants or NeMo Canary). The toggle
	 *  hides for engines that can't honor it — GigaAM, Moonshine,
	 *  Kaldi/Vosk, Cohere, ``.en`` Whispers — so the UI doesn't lie. */
	translateSupported: boolean;
	update: UpdateModelFn;
}

interface SourceAreaProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentQuantization: OnnxQuantization;
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	downloadProgress: { modelId: string; percent: number | null } | null;
	flags: SourceAreaFlags;
	getFitAssessment: GetFitAssessment;
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	canDeleteQuant: (modelId: string, quantization: OnnxQuantization) => boolean;
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization,
	) => void;
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization,
	) => import("@/features/model-download").QuantDownloadState | undefined;
	selectedModel: string;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
	tIntegrations: TFn;
}

interface SourceAreaFlags {
	hasAnyCloudKey: boolean;
	initialSourceIsCloud: boolean;
	isCloud: boolean;
	isSwapping: boolean;
}

/**
 * Owns the local "which picker is on screen" UI state. The parent re-mounts
 * this component (via `key={effectiveSourceIsCloud}`) whenever the persisted
 * model's source changes or API-key availability flips, so React naturally
 * resets `source` to the correct initial value WITHOUT a derived-state effect.
 *
 * Toggling the source does NOT touch persisted settings — the persisted
 * model only changes when the user picks a row from the visible picker.
 */
function SourceArea({
	catalogLoaded,
	catalogModels,
	currentQuantization,
	disabled = false,
	disabledTooltip,
	downloadProgress,
	flags,
	getFitAssessment,
	handleModelChange,
	onDeleteQuant,
	canDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	selectedModel,
	statesById,
	systemInfo,
	t,
	tIntegrations,
}: SourceAreaProps): ReactNode {
	const { hasAnyCloudKey, initialSourceIsCloud, isCloud, isSwapping } = flags;
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);
	const { source, sourceOpts, onSourceChange } = useSttSourceSwitch({
		hasAnyCloudKey,
		initialSourceIsCloud,
		onConfigureCloud: () => goToIntegrations("integrations"),
		onModelChange: handleModelChange,
		pickLocalDefault: () => resolveLocalDefault(catalogModels, statesById),
		selectedModel,
	});
	const sourceOptions = disabled
		? sourceOpts.map((option) => ({
				...option,
				disabled: true,
				...(disabledTooltip ? { tooltip: disabledTooltip } : {}),
			}))
		: sourceOpts;
	const handleSourceChange = (next: typeof source): void => {
		if (disabled) {
			return;
		}
		onSourceChange(next);
	};
	const handleSelectedModelChange = (
		modelId: string,
		quantization?: OnnxQuantization,
	): void => {
		if (disabled) {
			return;
		}
		handleModelChange(modelId, quantization);
	};
	return (
		<>
			<div className="col-span-2">
				<FormControl
					disabled={disabled}
					controlTooltip={disabledTooltip}
					label={tIntegrations("sourceLabel")}
					layout="row"
					tooltip={tIntegrations("sourceTooltip")}
				>
					<ElevatedSurface className="w-52">
						<Switcher
							fullWidth
							onChange={handleSourceChange}
							options={sourceOptions}
							value={source}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
			<div className="col-span-2">
				<FormControl
					disabled={disabled}
					controlTooltip={disabledTooltip}
					label={t("model")}
					tooltip={t("modelTooltip")}
				>
					{source === "cloud" ? (
						<CloudModelSelect
							disabled={disabled}
							disabledTooltip={disabledTooltip}
							onSelect={(id) => handleSelectedModelChange(id)}
							selectedId={isCloud ? selectedModel : ""}
						/>
					) : (
						<SttModelSelector
							currentQuantization={currentQuantization}
							disabled={disabled}
							downloadProgress={downloadProgress}
							isLoading={!catalogLoaded || isSwapping}
							getFitAssessment={getFitAssessment}
							kind="main"
							models={catalogModels}
							onChange={handleSelectedModelChange}
							canDeleteQuant={canDeleteQuant}
							onDeleteQuant={onDeleteQuant}
							onDownloadAction={onDownloadAction}
							onDownloadSnapshot={onDownloadSnapshot}
							onOpenDetached={openDetachedPicker}
							prefilter={isVisibleSttModel}
							statesById={statesById}
							systemInfo={systemInfo}
							value={isCloud ? "" : selectedModel}
						/>
					)}
				</FormControl>
			</div>
		</>
	);
}

export function MainModelSection({
	t,
	settings,
	update,
	catalogModels,
	catalogLoaded,
	statesById,
	systemInfo,
	currentQuantization,
	disabled = false,
	disabledTooltip,
	downloadProgress,
	getFitAssessment,
	isSwapping,
	languageAutoDetect,
	languageAutoDetectSupported,
	languageCandidates,
	languageControlMode,
	langOpts,
	onDeleteQuant,
	canDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	selectedModel,
	handleModelChange,
	sections,
	translateSupported,
}: MainModelSectionProps): ReactNode {
	const tIntegrations = useTranslations("integrations");
	const integrations = useSettingsStore((s) => s.settings.integrations);
	// OpenRouter STT reuses the single LLM OpenRouter key (not an integrations entry).
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const hasAnyCloudKey =
		integrations.elevenlabs.apiKey.trim().length > 0 ||
		openrouterKey.trim().length > 0;
	const isCloud = providerOf(selectedModel) !== null;
	// The Cloud tab is only reachable when at least one provider key is
	// configured. Persisted cloud selections without a key are flipped back
	// to the local picker — the cloud-key-removal banner already tells the
	// user what's broken.
	const effectiveSourceIsCloud = isCloud && hasAnyCloudKey;
	const effectiveLanguageAutoDetect =
		languageAutoDetectSupported && languageAutoDetect;
	const languageCandidateSelectionSupported =
		languageControlMode === "candidate-auto";
	const explicitLanguageCandidates = normalizeLanguageCandidatesAllowEmpty(
		settings?.languageCandidates,
		langOpts,
	);
	const languageComboboxValue = effectiveLanguageAutoDetect
		? explicitLanguageCandidates
		: languageCandidates;
	const fixedLanguage = fixedLanguageValue(
		settings,
		languageCandidates,
		langOpts,
	);

	return (
		<SettingSection icon={AiMicIcon} title={t("mainModel")}>
			<div className="flex flex-col">
				{/* `key` resets the local `source` state inside SourceArea whenever
				 *  the persisted model's source changes or API-key availability
				 *  flips — no derived-state effect needed. */}
				<SourceArea
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					disabled={disabled}
					disabledTooltip={disabledTooltip}
					downloadProgress={downloadProgress}
					flags={{
						hasAnyCloudKey,
						initialSourceIsCloud: effectiveSourceIsCloud,
						isCloud,
						isSwapping,
					}}
					getFitAssessment={getFitAssessment}
					handleModelChange={handleModelChange}
					key={effectiveSourceIsCloud ? "cloud" : "local"}
					onDeleteQuant={onDeleteQuant}
					canDeleteQuant={canDeleteQuant}
					onDownloadAction={onDownloadAction}
					onDownloadSnapshot={onDownloadSnapshot}
					selectedModel={selectedModel}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					tIntegrations={tIntegrations}
				/>
				{sections.language && (
					<SettingField
						disabled={disabled}
						disabledTooltip={disabledTooltip}
						hideReset={disabled}
						isDefault={
							!effectiveLanguageAutoDetect &&
							(settings?.language ?? "en") ===
								DEFAULT_SETTINGS.model.language &&
							(settings?.languageCandidates?.length ?? 0) === 0 &&
							(settings?.autoDetectLanguage ?? false) ===
								DEFAULT_SETTINGS.model.autoDetectLanguage
						}
						label={t("language")}
						labelAddon={
							languageAutoDetectSupported ? (
								<Toggle
									checked={effectiveLanguageAutoDetect}
									disabled={disabled}
									label={t("autoDetectLanguage")}
									onCheckedChange={(enabled) => {
										if (disabled) {
											return;
										}
										if (enabled) {
											update({
												autoDetectLanguage: true,
												language: "",
												languageCandidates: languageCandidateSelectionSupported
													? explicitLanguageCandidates
													: [],
											});
											return;
										}
										const next = normalizeLanguageCandidates(
											[
												settings?.language ?? "",
												...languageComboboxValue,
												...languageCandidates,
											],
											langOpts,
											DEFAULT_SETTINGS.model.language,
										);
										update({
											autoDetectLanguage: false,
											language: next[0] ?? DEFAULT_SETTINGS.model.language,
											languageCandidates: languageCandidateSelectionSupported
												? next
												: [],
										});
									}}
								/>
							) : undefined
						}
						layout="row"
						onReset={() =>
							update({
								autoDetectLanguage: DEFAULT_SETTINGS.model.autoDetectLanguage,
								language: DEFAULT_SETTINGS.model.language,
								languageCandidates: DEFAULT_SETTINGS.model.languageCandidates,
							})
						}
					>
						{effectiveLanguageAutoDetect ? undefined : (
							<ElevatedSurface className="w-52" inline>
								{languageCandidateSelectionSupported ? (
									<LanguageMultiCombobox
										ariaLabel={t("language")}
										disabled={disabled}
										emptyLabel={t("languageNoResults")}
										onChange={(value) => {
											if (disabled) {
												return;
											}
											const next = normalizeLanguageCandidates(
												value,
												langOpts,
												DEFAULT_SETTINGS.model.language,
											);
											update({
												autoDetectLanguage: false,
												language: next[0] ?? DEFAULT_SETTINGS.model.language,
												languageCandidates: next,
											});
										}}
										options={langOpts}
										placeholder={t("languagePlaceholder")}
										removeLabel={(language) =>
											t("languageRemove", { language })
										}
										selectedCountLabel={(count) => `${count}+`}
										selectedHeading={t("languageSelectedHeading")}
										value={languageComboboxValue}
									/>
								) : (
									<SearchableSelect
										disabled={disabled}
										onChange={(value) => {
											if (disabled) {
												return;
											}
											update({
												autoDetectLanguage: false,
												language: value,
												languageCandidates: [],
											});
										}}
										options={langOpts}
										placeholder={t("languagePlaceholder")}
										value={fixedLanguage}
									/>
								)}
							</ElevatedSurface>
						)}
					</SettingField>
				)}
				{/* Translate-to-English. Two engine families support it
				    natively at decoder time — Whisper (multilingual
				    variants, via the ``<|translate|>`` token in the
				    decoder prompt) and NeMo Canary (via the
				    ``target_language`` kwarg on ``recognize``). The
				    OnnxAsrTranscriber dispatches between the two
				    paths; the server-side family check (``.en``
				    variants of Whisper, GigaAM, Moonshine, …) silently
				    falls through to plain transcription. We expose the
				    toggle whenever the user's selected catalog family
				    is one of the two supported. */}
				{translateSupported && (
					<SettingField
						disabled={disabled}
						disabledTooltip={disabledTooltip}
						hideReset={disabled}
						isDefault={
							(settings?.translateToEnglish ?? false) ===
							DEFAULT_SETTINGS.model.translateToEnglish
						}
						label={t("translateToEnglish")}
						labelAddon={
							<Toggle
								checked={settings?.translateToEnglish ?? false}
								disabled={disabled}
								onCheckedChange={(v) => {
									if (!disabled) {
										update({ translateToEnglish: v });
									}
								}}
							/>
						}
						onReset={() =>
							update({
								translateToEnglish: DEFAULT_SETTINGS.model.translateToEnglish,
							})
						}
						tooltip={t("translateToEnglishTooltip")}
					/>
				)}
			</div>
		</SettingSection>
	);
}
