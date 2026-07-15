import { AiMicIcon } from "@hugeicons/core-free-icons";
import { SttModelSelector } from "@/features/select-local-stt-model";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import {
	providerOf,
	useOpenRouterSttCatalogStore,
} from "@/entities/cloud-stt-provider";
import {
	isRuntimeModelPreparing,
	useConnectionStore,
} from "@/entities/connection";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
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
import type { GetModelSuggestion } from "@/features/suggested-models";
import { openModelPickerAtRect } from "@/shared/api/model-picker-window";
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
	/** Suggested (spec-based recommender) verdict lookup — threaded to the
	 *  STT picker the same way as `getFitAssessment`. */
	getSuggestion?: GetModelSuggestion | undefined;
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
	 *  path (Whisper multilingual variants or NeMo Canary) AND at least one
	 *  target language other than the source is available. The picker hides
	 *  for engines that can't honor it — GigaAM, Moonshine, Kaldi/Vosk,
	 *  Cohere, ``.en`` Whispers — so the UI doesn't lie. */
	translateSupported: boolean;
	/** Output languages the model can translate INTO, minus the selected
	 *  source. Whisper resolves to English only; NeMo Canary lists its full
	 *  language set. Drives the target-language picker below the language row. */
	translateTargetOpts: SelectOption[];
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
	/** Suggested (spec-based recommender) verdict lookup — threaded to the
	 *  STT picker the same way as `getFitAssessment`. */
	getSuggestion?: GetModelSuggestion | undefined;
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
	isModelPreparing: boolean;
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
	getSuggestion,
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
	const {
		hasAnyCloudKey,
		initialSourceIsCloud,
		isCloud,
		isModelPreparing,
		isSwapping,
	} = flags;
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);
	const { cloudSelectedId, source, sourceOpts, onSourceChange } =
		useSttSourceSwitch({
			hasAnyCloudKey,
			initialSourceIsCloud,
			onConfigureCloud: () => goToIntegrations("integrations"),
			onModelChange: handleModelChange,
			pickLocalDefault: () => resolveLocalDefault(catalogModels, statesById),
			selectedModel,
		});
	// While the server is loading a model's weights (a swap in flight), lock BOTH
	// the source switch and the model picker until it settles — flipping source or
	// picking another model mid-load would race the in-progress swap. Listen-mode
	// (`disabled`) is the hard lock and carries an explanatory tooltip; the swap
	// lock is transient and needs none (the local picker trigger already renders
	// its own "Switching to …" state).
	const controlsLocked = disabled || isSwapping;
	const sourceOptions = disabled
		? sourceOpts.map((option) => ({
				...option,
				disabled: true,
				...(disabledTooltip ? { tooltip: disabledTooltip } : {}),
			}))
		: isSwapping
			? sourceOpts.map((option) => ({ ...option, disabled: true }))
			: sourceOpts;
	const handleSourceChange = (next: typeof source): void => {
		if (controlsLocked) {
			return;
		}
		onSourceChange(next);
	};
	const handleSelectedModelChange = (
		modelId: string,
		quantization?: OnnxQuantization,
	): void => {
		if (controlsLocked) {
			return;
		}
		handleModelChange(modelId, quantization);
	};
	return (
		<>
			<div>
				<FormControl
					disabled={controlsLocked}
					controlTooltip={disabledTooltip}
					label={tIntegrations("sourceLabel")}
					layout="row"
					tooltip={tIntegrations("sourceTooltip")}
				>
					<Switcher
						className="w-52"
						fullWidth
						onChange={handleSourceChange}
						options={sourceOptions}
						value={source}
					/>
				</FormControl>
			</div>
			<div>
				<FormControl
					disabled={disabled}
					controlTooltip={disabledTooltip}
					label={t("model")}
					tooltip={t("modelTooltip")}
				>
					{source === "cloud" ? (
						<CloudModelSelect
							disabled={controlsLocked}
							disabledTooltip={disabledTooltip}
							onOpenDetached={(rect) =>
								openModelPickerAtRect(rect, { pickerKind: "stt-cloud" })
							}
							onSelect={(id) => handleSelectedModelChange(id)}
							selectedId={cloudSelectedId}
						/>
					) : (
						<SttModelSelector
							currentQuantization={currentQuantization}
							disabled={disabled}
							downloadProgress={downloadProgress}
							isLoading={!catalogLoaded || isSwapping}
							isModelPreparing={isModelPreparing}
							getFitAssessment={getFitAssessment}
							getSuggestion={getSuggestion}
							kind="main"
							models={catalogModels}
							onChange={handleSelectedModelChange}
							canDeleteQuant={canDeleteQuant}
							onDeleteQuant={onDeleteQuant}
							onDownloadAction={onDownloadAction}
							onDownloadSnapshot={onDownloadSnapshot}
							onOpenDetached={(rect) =>
								openModelPickerAtRect(rect, { pickerKind: "stt" })
							}
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

interface LanguageAreaProps {
	disabled: boolean;
	disabledTooltip?: string | undefined;
	langOpts: SelectOption[];
	languageAutoDetect: boolean;
	languageAutoDetectSupported: boolean;
	languageCandidates: string[];
	languageControlMode: LanguageControlMode;
	settings: ModelSettings | undefined;
	t: TFn;
	update: UpdateModelFn;
}

/**
 * The Spoken Language row — a single/candidate/auto language picker plus the
 * optional "Auto-detect" toggle. Split out of {@link MainModelSection} so that
 * component stays under the giant-component cap; all language-derived state is
 * local here and used nowhere else.
 */
function LanguageArea({
	disabled,
	disabledTooltip,
	langOpts,
	languageAutoDetect,
	languageAutoDetectSupported,
	languageCandidates,
	languageControlMode,
	settings,
	t,
	update,
}: LanguageAreaProps): ReactNode {
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
	// Per-mode tooltip for the Spoken Language row. The "single" (declared
	// source) copy is the important one: Canary can't auto-detect, trusts the
	// setting completely, and emits in this language unless Translate To
	// overrides — so mismatched speech comes out TRANSLATED, not transcribed.
	const languageTooltip =
		languageControlMode === "single"
			? t("languageTooltipSingle")
			: languageControlMode === "candidate-auto"
				? t("languageTooltipCandidateAuto")
				: t("languageTooltipAuto");
	return (
		<SettingField
			disabled={disabled}
			disabledTooltip={disabledTooltip}
			hideReset={disabled}
			isDefault={
				!effectiveLanguageAutoDetect &&
				(settings?.language ?? "en") === DEFAULT_SETTINGS.model.language &&
				(settings?.languageCandidates?.length ?? 0) === 0 &&
				(settings?.autoDetectLanguage ?? false) ===
					DEFAULT_SETTINGS.model.autoDetectLanguage
			}
			label={t("language")}
			tooltip={languageTooltip}
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
			{/* Auto-detect DISABLES the picker instead of unmounting it (no
			    layout jump; the shortlist/pick stays visible while detection
			    owns the decision). Edit it by turning Auto-detect off. */}
			{languageCandidateSelectionSupported ? (
				<ElevatedSurface className="w-52" inline>
					<LanguageMultiCombobox
						ariaLabel={t("language")}
						disabled={disabled || effectiveLanguageAutoDetect}
						emptyLabel={t("languageNoResults")}
						onChange={(value) => {
							if (disabled || effectiveLanguageAutoDetect) {
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
						removeLabel={(language) => t("languageRemove", { language })}
						selectedCountLabel={(count) => `${count}+`}
						selectedHeading={t("languageSelectedHeading")}
						value={languageComboboxValue}
					/>
				</ElevatedSurface>
			) : (
				<SearchableSelect
					className="w-52"
					disabled={disabled || effectiveLanguageAutoDetect}
					onChange={(value) => {
						if (disabled || effectiveLanguageAutoDetect) {
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
		</SettingField>
	);
}

interface TranslateAreaProps {
	disabled: boolean;
	disabledTooltip?: string | undefined;
	settings: ModelSettings | undefined;
	t: TFn;
	translateTargetOpts: SelectOption[];
	update: UpdateModelFn;
}

/**
 * Translate To — a toggle + target-language picker over the single persisted
 * `translateTargetLanguage` field ("" = off). Split out of
 * {@link MainModelSection} so that component stays under the giant-component
 * cap; the last-target ref and toggle handler live only here.
 */
function TranslateArea({
	disabled,
	disabledTooltip,
	settings,
	t,
	translateTargetOpts,
	update,
}: TranslateAreaProps): ReactNode {
	// Translate To is a toggle + target picker over ONE persisted field:
	// `translateTargetLanguage` ("" = off). The toggle owns on/off, so the
	// dropdown never lists a "Same as spoken" sentinel — it just disables while
	// translation is off. The last concrete target is remembered (session-local)
	// so re-enabling restores it instead of resetting to English.
	const translateTarget = settings?.translateTargetLanguage ?? "";
	const translateActive = translateTargetOpts.some(
		(option) => option.id === translateTarget,
	);
	const lastTranslateTarget = useRef("");
	const setTranslateTarget = (value: string): void => {
		if (value.length > 0) {
			lastTranslateTarget.current = value;
		}
		update({ translateTargetLanguage: value });
	};
	const handleTranslateToggle = (enabled: boolean): void => {
		if (disabled) {
			return;
		}
		if (!enabled) {
			if (translateActive) {
				lastTranslateTarget.current = translateTarget;
			}
			update({ translateTargetLanguage: "" });
			return;
		}
		const remembered = lastTranslateTarget.current;
		const valid = (id: string): boolean =>
			translateTargetOpts.some((option) => option.id === id);
		setTranslateTarget(
			valid(remembered)
				? remembered
				: valid("en")
					? "en"
					: (translateTargetOpts[0]?.id ?? ""),
		);
	};
	return (
		<SettingField
			disabled={disabled}
			disabledTooltip={disabledTooltip}
			hideReset={disabled}
			isDefault={
				(settings?.translateTargetLanguage ?? "") ===
				DEFAULT_SETTINGS.model.translateTargetLanguage
			}
			label={t("translateTo")}
			labelAddon={
				<Toggle
					aria-label={t("translateToggleAria")}
					checked={translateActive}
					disabled={disabled}
					onCheckedChange={handleTranslateToggle}
				/>
			}
			layout="row"
			onReset={() =>
				update({
					translateTargetLanguage:
						DEFAULT_SETTINGS.model.translateTargetLanguage,
				})
			}
			tooltip={t("translateToTooltip")}
		>
			<SearchableSelect
				className="w-52"
				disabled={disabled || !translateActive}
				onChange={(value) => {
					if (!(disabled || !translateActive)) {
						setTranslateTarget(value);
					}
				}}
				options={translateTargetOpts}
				placeholder={t("translateToPlaceholder")}
				value={translateActive ? translateTarget : ""}
			/>
		</SettingField>
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
	getSuggestion,
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
	translateTargetOpts,
}: MainModelSectionProps): ReactNode {
	const tIntegrations = useTranslations("integrations");
	const runtimeInfo = useConnectionStore((s) => s.runtimeInfo);
	const integrations = useSettingsStore((s) => s.settings.integrations);
	// OpenRouter STT reuses the single LLM OpenRouter key (not an integrations entry).
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const hasAnyCloudKey =
		integrations.elevenlabs.apiKey.trim().length > 0 ||
		openrouterKey.trim().length > 0;
	// Pre-warm the live OpenRouter STT catalog while the user is still on the
	// Local tab, so flipping to Cloud resolves the default/last cloud model's
	// name instantly instead of showing the empty "Select cloud model"
	// placeholder for the ~1s the scan takes. The store guards re-entrancy; the
	// `isLoaded` gate stops this from re-scanning on every render.
	const openrouterConfigured = openrouterKey.trim().length > 0;
	const openrouterCatalogLoaded = useOpenRouterSttCatalogStore(
		(s) => s.isLoaded,
	);
	const scanOpenrouterModels = useOpenRouterSttCatalogStore(
		(s) => s.scanModels,
	);
	useEffect(() => {
		if (openrouterConfigured && !openrouterCatalogLoaded) {
			fireAndForget(scanOpenrouterModels(), "main-model.prewarmOpenrouterStt");
		}
	}, [openrouterConfigured, openrouterCatalogLoaded, scanOpenrouterModels]);
	const isCloud = providerOf(selectedModel) !== null;
	const isModelPreparing = !isCloud && isRuntimeModelPreparing(runtimeInfo);
	// The Cloud tab is only reachable when at least one provider key is
	// configured. Persisted cloud selections without a key are flipped back
	// to the local picker — the cloud-key-removal banner already tells the
	// user what's broken.
	const effectiveSourceIsCloud = isCloud && hasAnyCloudKey;

	return (
		<SettingSection boxed icon={AiMicIcon} title={t("mainModel")}>
			<div className="flex flex-col divide-y divide-divider">
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
						isModelPreparing,
						isSwapping,
					}}
					getFitAssessment={getFitAssessment}
					getSuggestion={getSuggestion}
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
					<LanguageArea
						disabled={disabled}
						disabledTooltip={disabledTooltip}
						langOpts={langOpts}
						languageAutoDetect={languageAutoDetect}
						languageAutoDetectSupported={languageAutoDetectSupported}
						languageCandidates={languageCandidates}
						languageControlMode={languageControlMode}
						settings={settings}
						t={t}
						update={update}
					/>
				)}
				{/* Translate To — toggle + target picker for native decoder-time
				    translation. Whisper multilingual = the ``<|translate|>`` task
				    (English-only target; with several possible spoken languages
				    the engine's constrained lang-id resolves the source per
				    utterance, so English speech passes through unchanged). NeMo
				    Canary = a true target-language prompt slot, any→any among
				    its languages. Toggle off = ``translateTargetLanguage: ""``
				    (output in the spoken language); the dropdown disables
				    instead of unmounting. Hidden entirely for engines that
				    can't translate or when the only target equals the single
				    definitive source, so the UI never lies. */}
				{translateSupported && (
					<TranslateArea
						disabled={disabled}
						disabledTooltip={disabledTooltip}
						settings={settings}
						t={t}
						translateTargetOpts={translateTargetOpts}
						update={update}
					/>
				)}
			</div>
		</SettingSection>
	);
}
