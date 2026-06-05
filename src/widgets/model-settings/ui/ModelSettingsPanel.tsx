import {
	Activity03Icon,
	AiMicIcon,
	AiSettingIcon,
	CpuIcon,
	CpuSettingsIcon,
	FlashIcon,
	InfinityIcon,
	Timer01Icon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { resolveEffectiveQuant, SttModelSelector } from "@picker";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import {
	isVisibleSttModel,
	isSelectableRealtimeModel,
	modelsHaveLanguageOverlap,
	readLastLocalSttModelHistory,
	recordLastLocalSttModel,
	resolveLocalDefault,
	supportsInitialPrompt,
	supportsTranslateToEnglish,
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useDiarizationToggleStore,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { assessDictationFitClient } from "@/entities/system-resources/lib/fit-assessor";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import {
	canDeleteSttQuant,
	DownloadConfirmationDialog,
	isQuantDownloading,
	resolveSttDeleteRecovery,
	useQuantActions,
} from "@/features/model-download";
import {
	CloudModelSelect,
	useSttSourceSwitch,
} from "@/features/select-cloud-stt-model";
import {
	type SwapController,
	useModelSwapController,
} from "@/features/swap-model";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend, type FitAssessmentEntry } from "@/shared/api/ipc-client";
import { LANGUAGES, type OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Spinner } from "@/shared/ui/spinner";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { useLockLlmTranslate } from "../model/use-lock-llm-translate";
import { useStaleModelFallback } from "../model/use-stale-model-fallback";
import { useSwapProgress } from "../model/use-swap-progress";

type TFn = ReturnType<typeof useTranslations>;

type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
type GlobalSettings = SettingsStoreState["settings"]["global"];
type ModelSettings = SettingsStoreState["settings"]["model"];
type QualitySettings = SettingsStoreState["settings"]["quality"];
type UpdateGlobalFn = SettingsStoreState["updateGlobalSettings"];
type UpdateModelFn = SettingsStoreState["updateModelSettings"];
type UpdateQualityFn = SettingsStoreState["updateQualitySettings"];
type ModelUnloadTimeoutValue = GlobalSettings["modelUnloadTimeout"];

type DeviceValue = "auto" | "cpu";
type CatalogModels = ReturnType<typeof useCatalogStore.getState>["models"];
type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type SystemInfo = ReturnType<typeof useModelStateStore.getState>["systemInfo"];
type GetFitAssessment = (modelId: string) => FitAssessmentEntry | null;

interface MainModelSectionProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentQuantization: OnnxQuantization;
	/** Snapshot of the in-flight download (model id + percent). Drives the
	 *  picker's "Downloading X · 23%" trigger AND distinguishes "we're
	 *  fetching bytes" from "the server is loading weights" so the picker
	 *  doesn't lock down for the entire multi-GB download. */
	downloadProgress: { modelId: string; percent: number | null } | null;
	getFitAssessment: GetFitAssessment;
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	/** True when the active model reads Whisper's free-text `initial_prompt`
	 *  slot (Whisper + Lite-Whisper). The prompt field hides for every other
	 *  engine — their slot is absent or untrained — so the UI doesn't lie. */
	initialPromptSupported: boolean;
	isSwapping: boolean;
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
	downloadProgress: { modelId: string; percent: number | null } | null;
	getFitAssessment: GetFitAssessment;
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	hasAnyCloudKey: boolean;
	initialSourceIsCloud: boolean;
	isCloud: boolean;
	isSwapping: boolean;
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
	downloadProgress,
	getFitAssessment,
	handleModelChange,
	hasAnyCloudKey,
	initialSourceIsCloud,
	isCloud,
	isSwapping,
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
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);
	const { source, sourceOpts, onSourceChange } = useSttSourceSwitch({
		hasAnyCloudKey,
		initialSourceIsCloud,
		onConfigureCloud: () => goToIntegrations("integrations"),
		onModelChange: handleModelChange,
		pickLocalDefault: () => resolveLocalDefault(catalogModels, statesById),
		selectedModel,
	});
	// Open the detached picker window (full work area, can extend beyond the
	// 700×560 settings window) instead of an in-window popup — mirrors the
	// main-window footer chip. It anchors above this trigger's rect.
	const openDetachedPicker = (rect: DOMRect) =>
		ipcSend(IPC.MODEL_PICKER_OPEN, {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		});
	return (
		<>
			<div className="col-span-2">
				<FormControl
					label={tIntegrations("sourceLabel")}
					layout="row"
					tooltip={tIntegrations("sourceTooltip")}
				>
					<ElevatedSurface className="w-52">
						<Switcher
							fullWidth
							onChange={onSourceChange}
							options={sourceOpts}
							value={source}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
			<div className="col-span-2">
				<FormControl label={t("model")} tooltip={t("modelTooltip")}>
					{source === "cloud" ? (
						<CloudModelSelect
							onSelect={(id) => handleModelChange(id)}
							selectedId={isCloud ? selectedModel : ""}
						/>
					) : (
						<SttModelSelector
							currentQuantization={currentQuantization}
							downloadProgress={downloadProgress}
							isLoading={!catalogLoaded || isSwapping}
							getFitAssessment={getFitAssessment}
							kind="main"
							models={catalogModels}
							onChange={handleModelChange}
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

/**
 * Whisper's free-text `initial_prompt` slot, surfaced as a small textarea.
 *
 * The persisted value (`model.initialPrompt`) is the user's static prefix; the
 * the reference main process folds it together with the personal-dictionary glossary
 * and the per-utterance context tail before it reaches the decoder (see
 * `electron/lib/initial-prompt.ts`). Editing it re-syncs live via
 * `installInitialPromptSync` — no model reload, no restart.
 *
 * Local draft state commits on blur (not per keystroke) so we fire a single
 * settings write — and the single `set_parameter` round-trip it triggers — once
 * the user is done typing, instead of one per character. Seeded once on mount
 * from the persisted value; the user is the sole editor, so there's no
 * external-change race to reconcile.
 */
function InitialPromptField({
	onCommit,
	t,
	value,
}: {
	onCommit: (next: string) => void;
	t: TFn;
	value: string;
}): ReactNode {
	const [draft, setDraft] = useState(value);
	// Lift the field one level above its substrate, exactly like the TextField
	// primitive — keeps it consistent with the section's other inputs instead of
	// a flat hardcoded surface. (See `project_surface_elevation_convention`.)
	const inputLevel = Math.min(useSurface() + 1, 8);
	return (
		<SettingField
			isDefault={draft === DEFAULT_SETTINGS.model.initialPrompt}
			label={t("initialPrompt")}
			onReset={() => {
				setDraft(DEFAULT_SETTINGS.model.initialPrompt);
				onCommit(DEFAULT_SETTINGS.model.initialPrompt);
			}}
			tooltip={t("initialPromptTooltip")}
		>
			<textarea
				aria-label={t("initialPrompt")}
				className={cn(
					"min-h-[64px] w-full resize-y rounded-sm px-2.5 py-2 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
					surfaceClasses(inputLevel),
				)}
				maxLength={600}
				onBlur={() => {
					if (draft !== value) {
						onCommit(draft);
					}
				}}
				onChange={(e) => setDraft(e.target.value)}
				placeholder={t("initialPromptPlaceholder")}
				value={draft}
			/>
		</SettingField>
	);
}

function MainModelSection({
	t,
	settings,
	update,
	catalogModels,
	catalogLoaded,
	statesById,
	systemInfo,
	currentQuantization,
	downloadProgress,
	getFitAssessment,
	initialPromptSupported,
	isSwapping,
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
	const hasAnyCloudKey =
		integrations.openai.apiKey.trim().length > 0 ||
		integrations.elevenlabs.apiKey.trim().length > 0;
	const isCloud = providerOf(selectedModel) !== null;
	// The Cloud tab is only reachable when at least one provider key is
	// configured. Persisted cloud selections without a key are flipped back
	// to the local picker — the cloud-key-removal banner already tells the
	// user what's broken.
	const effectiveSourceIsCloud = isCloud && hasAnyCloudKey;

	return (
		<SettingSection icon={AiMicIcon} title={t("mainModel")}>
			<div className="flex flex-col divide-y divide-surface-1">
				{/* `key` resets the local `source` state inside SourceArea whenever
				 *  the persisted model's source changes or API-key availability
				 *  flips — no derived-state effect needed. */}
				<SourceArea
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					downloadProgress={downloadProgress}
					getFitAssessment={getFitAssessment}
					handleModelChange={handleModelChange}
					hasAnyCloudKey={hasAnyCloudKey}
					initialSourceIsCloud={effectiveSourceIsCloud}
					isCloud={isCloud}
					isSwapping={isSwapping}
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
						isDefault={
							(settings?.language ?? "en") === DEFAULT_SETTINGS.model.language
						}
						label={t("language")}
						layout="row"
						onReset={() =>
							update({ language: DEFAULT_SETTINGS.model.language })
						}
					>
						<ElevatedSurface className="w-52" inline>
							<SearchableSelect
								onChange={(v) => update({ language: v })}
								options={langOpts}
								value={settings?.language ?? "en"}
							/>
						</ElevatedSurface>
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
						isDefault={
							(settings?.translateToEnglish ?? false) ===
							DEFAULT_SETTINGS.model.translateToEnglish
						}
						label={t("translateToEnglish")}
						labelAddon={
							<Toggle
								checked={settings?.translateToEnglish ?? false}
								onCheckedChange={(v) => update({ translateToEnglish: v })}
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
				{initialPromptSupported && (
					<InitialPromptField
						onCommit={(v) => update({ initialPrompt: v })}
						t={t}
						value={settings?.initialPrompt ?? ""}
					/>
				)}
			</div>
		</SettingSection>
	);
}

function ModelLifetimeSection({
	global,
	t,
	update,
}: {
	global: GlobalSettings | undefined;
	t: TFn;
	update: UpdateGlobalFn;
}): ReactNode {
	const value =
		global?.modelUnloadTimeout ?? DEFAULT_SETTINGS.global.modelUnloadTimeout;
	return (
		<SettingSection icon={Timer01Icon} title={t("modelUnloadTimeout")}>
			<SettingField
				isDefault={value === DEFAULT_SETTINGS.global.modelUnloadTimeout}
				label={t("modelUnloadTimeout")}
				layout="row"
				onReset={() =>
					update({
						modelUnloadTimeout: DEFAULT_SETTINGS.global.modelUnloadTimeout,
					})
				}
				tooltip={`${t("modelUnloadTimeoutCaption")} ${t("modelUnloadTimeoutTooltip")}`}
			>
				<ElevatedSurface className="w-52" inline>
					<SearchableSelect
						onChange={(v) =>
							update({ modelUnloadTimeout: v as ModelUnloadTimeoutValue })
						}
						options={[
							{
								id: "immediately",
								label: t("modelUnloadImmediately"),
								icon: FlashIcon,
							},
							{ id: "never", label: t("modelUnloadNever"), icon: InfinityIcon },
							{ id: "min2", label: t("modelUnloadMin2"), icon: Timer01Icon },
							{ id: "min5", label: t("modelUnloadMin5"), icon: Timer01Icon },
							{ id: "min10", label: t("modelUnloadMin10"), icon: Timer01Icon },
							{ id: "min15", label: t("modelUnloadMin15"), icon: Timer01Icon },
							{ id: "hour1", label: t("modelUnloadHour1"), icon: Timer01Icon },
						]}
						value={value}
					/>
				</ElevatedSurface>
			</SettingField>
		</SettingSection>
	);
}

/**
 * Standalone compute-device control. It lives OUTSIDE both the STT and TTS
 * sections because `model.device` is the single device shared by every local
 * model — the loaded ONNX STT session AND local Kokoro TTS (mirrored onto the
 * server's `--tts-device`). Nesting it under "Main Model" made it look like an
 * STT-only knob and left it stranded under a cloud STT selection even though
 * local TTS was still riding on it. The parent renders this only when a GPU is
 * detected AND at least one local model is active: with no GPU there is no
 * choice to make (Auto resolves to CPU), so the section is hidden; it also
 * disappears when STT and TTS are both cloud, since nothing local consumes a
 * device. Because the section never shows without a GPU, the control is a plain
 * Auto/CPU switch — Auto picks the fastest device per model (CPU is the manual
 * escape hatch for GPU contention / driver issues).
 */
function DeviceSection({
	deviceOpts,
	deviceValue,
	t,
	update,
}: {
	deviceOpts: SwitcherOption<DeviceValue>[];
	deviceValue: DeviceValue;
	t: TFn;
	update: UpdateModelFn;
}): ReactNode {
	return (
		<SettingSection icon={CpuSettingsIcon} title={t("device")}>
			<FormControl
				label={t("device")}
				layout="row"
				tooltip={`${t("deviceSectionCaption")} ${t("deviceCaptionGpu")}`}
			>
				<ElevatedSurface className="w-52">
					<Switcher
						fullWidth
						onChange={(v) => update({ device: v })}
						options={deviceOpts}
						value={deviceValue}
					/>
				</ElevatedSurface>
			</FormControl>
		</SettingSection>
	);
}

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
function RealtimeModelSection({
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
								(mainModelInfo === undefined ||
									modelsHaveLanguageOverlap(mainModelInfo, m))
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

// Auto-detect has an empty code; everything else uses the ISO 639-1/2 code
// uppercased as a short visual badge (e.g. "en" → "EN", "yue" → "YUE").
function languageBadge(code: string): string {
	return code === "" ? "AUTO" : code.toUpperCase();
}
const ALL_LANG_OPTS: SelectOption[] = LANGUAGES.map((l) => ({
	id: l.code,
	label: l.name,
	badge: languageBadge(l.code),
}));
// The Device switch is only ever rendered when a GPU is present (see
// DeviceSection), so it is always the full Auto/CPU pair — Auto picks the
// fastest device per model; CPU is the manual override.
function buildDeviceOpts(t: TFn): SwitcherOption<DeviceValue>[] {
	return [
		{ value: "auto", label: t("deviceAutoLabel"), icon: AiSettingIcon },
		{ value: "cpu", label: t("deviceCpuLabel"), icon: CpuIcon },
	];
}

type TtsSettings = SettingsStoreState["settings"]["tts"];
type ElevenIntegration =
	SettingsStoreState["settings"]["integrations"]["elevenlabs"];

/** Whether local Kokoro TTS is the active synthesis source. It rides on the
 *  Model-tab compute device (`model.device` → `--tts-device`), so the Device
 *  control must survive a cloud STT selection while this is true. Mirrors
 *  TtsModelSection's effective-source gate (cloud needs a present + verified
 *  ElevenLabs key, else it falls back to local). */
function isLocalTtsActive(
	tts: TtsSettings | undefined,
	elevenlabs: ElevenIntegration,
): boolean {
	const cloudEffective =
		(tts?.source ?? "local") === "cloud" &&
		elevenlabs.apiKey.trim().length > 0 &&
		elevenlabs.verified === true;
	return (tts?.enabled ?? false) && !cloudEffective;
}

interface ModelControlVisibility {
	showDevice: boolean;
	showLanguage: boolean;
}

/** Which Model-tab controls stay visible for the active main model. A cloud
 *  main hides the STT-local knobs: language (the provider owns it) and
 *  idle-unload-timeout (no local session to unload). `showDevice` is different —
 *  it gates the STANDALONE {@link DeviceSection}, not an STT sub-control, and is
 *  true whenever ANY local model needs a device: a local STT main OR local
 *  Kokoro TTS (both share `model.device`). It only disappears when STT and TTS
 *  are both cloud. A single-language local model also hides language
 *  (auto-detect + one language is a no-op choice). */
function resolveModelControlVisibility(
	selectedIsCloud: boolean,
	supportedLanguages: readonly string[] | undefined,
	localTtsActive: boolean,
): ModelControlVisibility {
	return {
		showLanguage: !selectedIsCloud && supportedLanguages?.length !== 1,
		showDevice: !selectedIsCloud || localTtsActive,
	};
}

function localModelIdOrNull(
	modelId: string | undefined,
	enabled = true,
): string | null {
	if (!enabled || !modelId || providerOf(modelId) !== null) {
		return null;
	}
	return modelId;
}

function quantForFit(
	statesById: StatesById,
	modelId: string | null,
	currentQuantization: OnnxQuantization,
): string {
	return modelId
		? resolveEffectiveQuant(statesById[modelId], currentQuantization)
		: "";
}

function requestedDeviceForFit(deviceValue: DeviceValue): string | null {
	return deviceValue === "cpu" ? "cpu" : null;
}

interface SwapDialogsProps {
	controller: SwapController;
	getModel: ReturnType<typeof useCatalogStore.getState>["getModel"];
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
}

/** Thin composition of the two model-swap gates (download confirmation +
 *  resource warning). Rendered by every surface that drives a swap so the
 *  modals appear regardless of which picker the user touched. */
function SwapDialogs({
	controller,
	getModel,
	statesById,
	systemInfo,
	t,
}: SwapDialogsProps): ReactNode {
	const { pendingDownload, pendingFitWarning, setPendingFitWarning } =
		controller;
	return (
		<>
			<DownloadConfirmationDialog
				getModel={getModel}
				onCancel={controller.cancelPendingDownload}
				pending={pendingDownload}
				statesById={statesById}
				systemInfo={systemInfo}
			/>
			<ResourceWarningDialog
				assessment={pendingFitWarning?.assessment ?? null}
				cancelLabel={t("resourceWarning.cancel")}
				candidateName={pendingFitWarning?.candidateName ?? ""}
				confirmLabel={t("resourceWarning.proceedAnyway")}
				kind="dictation"
				onCancel={() => setPendingFitWarning(null)}
				onConfirm={() => {
					const next = pendingFitWarning?.next;
					setPendingFitWarning(null);
					if (next) {
						next();
					}
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPendingFitWarning(null);
					}
				}}
				open={pendingFitWarning !== null}
				t={(key, vars) =>
					t(`resourceWarning.${key}` as Parameters<typeof t>[0], vars)
				}
			/>
		</>
	);
}

/**
 * Speaker diarization, copied verbatim from the General-settings panel (it now
 * lives on the Transcription tab — the recognition engine — instead of General). The
 * parent gates it to render only in Listen mode (`general.recordingMode ===
 * 'listen'`), matching the original gate.
 *
 * Diarization is toggled at runtime (no server restart). The server pushes
 * started/completed/failed; `useDiarizationToggleStore` tracks the in-flight
 * window. Driven purely by broadcast IPC so it works in the settings window (its
 * own BrowserWindow, no connection store there). The optimistic-revert on
 * failure is performed in the toggle-store's IPC listener
 * (`diarization-toggle-store.ts`) so the failure handler owns the lifecycle
 * directly — no effect-in-render needed here.
 *
 * The persisted key (`general.speakerDiarization`) stays in the `general` slice
 * and is read/written via `updateGeneralSettings` — only the visual home moved.
 */
function SpeakerDiarizationSection(): ReactNode {
	const tGeneral = useTranslations("general");
	const enabled = useSettingsStore(
		(s) => s.settings.general?.speakerDiarization ?? false,
	);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const pending = useDiarizationToggleStore((s) => s.pending);

	return (
		<SettingSection
			icon={UserMultiple02Icon}
			title={tGeneral("speakerDiarization")}
		>
			<SettingField
				isDefault={enabled === DEFAULT_SETTINGS.general.speakerDiarization}
				label={tGeneral("speakerDiarization")}
				labelAddon={
					<div className="flex items-center gap-2">
						{pending ? (
							<Spinner
								aria-label={tGeneral("speakerDiarization")}
								className="size-3.5 text-foreground-muted"
							/>
						) : null}
						<Toggle
							aria-label={tGeneral("speakerDiarization")}
							checked={enabled}
							disabled={pending}
							onCheckedChange={(v) => update({ speakerDiarization: v })}
						/>
					</div>
				}
				onReset={() =>
					update({
						speakerDiarization: DEFAULT_SETTINGS.general.speakerDiarization,
					})
				}
				tooltip={tGeneral("speakerDiarizationTooltip")}
			/>
		</SettingSection>
	);
}

export function ModelSettingsPanel() {
	const global = useSettingsStore((s) => s.settings.global);
	const updateGlobal = useSettingsStore((s) => s.updateGlobalSettings);
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
	// Whether the LLM dictation "Translate" modifier is currently enabled — a
	// boolean selector so the panel only re-renders when it flips (not on every
	// preset edit). Drives the STT-translate ↔ LLM-translate lock below.
	const llmTranslateEnabled = useSettingsStore((s) =>
		s.settings.llm.dictation.presets.some((p) => p.key === "translate"),
	);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	// Local Kokoro TTS shares the Model-tab compute device (mirrored onto the
	// server's `--tts-device`), so the Device control must survive a cloud STT
	// selection while local TTS is still running. `tts` + the ElevenLabs key
	// status mirror TtsModelSection's effective-source gate.
	const tts = useSettingsStore((s) => s.settings.tts);
	const elevenlabs = useSettingsStore(
		(s) => s.settings.integrations.elevenlabs,
	);
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);
	const isListenMode = recordingMode === "listen";
	const showRecordingOverlay = useSettingsStore(
		(s) => s.settings.general?.showRecordingOverlay ?? true,
	);
	const liveTranscriptionDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both",
	);
	const wordByWordPasting = useSettingsStore(
		(s) => s.settings.general?.wordByWordPasting ?? false,
	);
	// Realtime is fully derived from the display picker — the engine has no
	// observable output without a display surface, so there is no separate
	// on/off toggle. The realtime section here is hidden when this is false.
	const realtimeEnabled = isRealtimeEnabled({
		showRecordingOverlay,
		liveTranscriptionDisplay,
		llmDictationEnabled,
		wordByWordPasting,
	});
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo.length > 0;
	const t = useTranslations("model");
	const deviceOpts = buildDeviceOpts(t);
	const deviceValue: DeviceValue = gpuAvailable
		? (settings?.device ?? "auto")
		: "cpu";

	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);

	// Model-state store — drives the inline cache badges and the ⚠ icon
	// in the dropdown labels. Refresh on mount so the server gets re-probed
	// each time the settings panel opens; live updates come through the
	// store's IPC subscriptions (model_cache_changed / swap_completed).
	const statesById = useModelStateStore((s) => s.statesById);
	const modelStatesLoaded = useModelStateStore((s) => s.isLoaded);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	// Live download + swap snapshot lives in its own hook so the panel stays
	// at a reasonable cognitive-complexity score.
	const {
		mainDownloadProgress,
		realtimeDownloadProgress,
		mainSwapping,
		realtimeSwapping,
	} = useSwapProgress();

	// Live host resource snapshot (RAM available, free VRAM, CPU%) for the
	// resource-aware warning modal. Refreshed when the panel mounts.
	const liveResources = useSystemResourcesStore((s) => s.liveResources);
	const refreshLive = useSystemResourcesStore((s) => s.refresh);

	useEffect(() => {
		refreshModelState();
		refreshLive();
	}, [refreshModelState, refreshLive]);

	// Stale-model fallback for both slots lives in its own hook.
	useStaleModelFallback(
		catalogLoaded,
		catalogModels,
		statesById,
		modelStatesLoaded,
		settings?.model,
		settings?.realtimeModel,
		update,
	);

	// Fallback matches the bundled offline base seeded into the HF cache by
	// PyInstaller (see `seed_models.py` + `project_offline_base_and_tts_pack`
	// memory). The legacy "large-v2" fallback resolved to a catalog id the
	// picker no longer surfaces and produced a desync between the main
	// window header ("large-v2") and the picker selection (vosk-russian as
	// the first catalog row).
	const selectedModel = settings?.model ?? "tiny";
	const selectedIsCloud = providerOf(selectedModel) !== null;
	const selectedInfo = selectedIsCloud ? undefined : getModel(selectedModel);
	// Remember the active local model so flipping the source switch Cloud→Local
	// restores the user's last choice instead of resetting to the catalog
	// default. Only local ids are recorded — a cloud selection delegates to the
	// provider and must not overwrite the remembered local pick.
	useEffect(() => {
		if (!selectedIsCloud) {
			recordLastLocalSttModel(selectedModel);
		}
	}, [selectedIsCloud, selectedModel]);
	// Translate-to-English is honored on multilingual Whisper exports
	// (via the ``<|translate|>`` prompt token) AND on NeMo Canary (via
	// the ``target_language`` recognize kwarg). Anything else silently
	// no-ops server-side, so we hide the toggle there to avoid lying
	// to the user. ``.en`` Whisper variants are filtered by the
	// language-detection capability — they advertise English only and
	// have no need for translate-to-English. We likewise hide it when the
	// user pins the source language to English: an en→en translate pass is
	// a no-op, so the toggle would be just as misleading there.
	const translateSupported =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		supportsTranslateToEnglish(selectedInfo) &&
		(settings?.language ?? "en") !== "en";
	// The free-text initial_prompt field shows only for models that actually
	// read the slot (Whisper + Lite-Whisper); every other engine's prompt slot
	// is absent or untrained. Cloud STT delegates to the provider, so it's
	// hidden there too (same rule as the device / language / translate knobs).
	const initialPromptSupported =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		supportsInitialPrompt(selectedInfo);
	// When the STT decoder itself translates to English, force the LLM dictation
	// "Translate" modifier off so the transcript isn't translated twice. The LLM
	// panel additionally disables the row while this holds.
	useLockLlmTranslate(
		translateSupported && (settings?.translateToEnglish ?? false),
		llmTranslateEnabled,
	);
	const currentQuantization = (settings?.onnxQuantization ??
		"") as OnnxQuantization;
	const getFitAssessment = useCallback<GetFitAssessment>(
		(modelId) => {
			if (liveResources === null) {
				return null;
			}
			const mainId = localModelIdOrNull(selectedModel, !selectedIsCloud);
			const realtimeId = localModelIdOrNull(
				settings?.realtimeModel,
				realtimeEnabled && !selectedIsCloud,
			);
			return assessDictationFitClient(modelId, {
				candidateQuant: quantForFit(statesById, modelId, currentQuantization),
				live: liveResources,
				loaded: {
					mainId,
					mainQuant: quantForFit(statesById, mainId, currentQuantization),
					realtimeId,
					realtimeQuant: quantForFit(
						statesById,
						realtimeId,
						currentQuantization,
					),
				},
				requestedDevice: requestedDeviceForFit(deviceValue),
				statesById,
			});
		},
		[
			currentQuantization,
			deviceValue,
			liveResources,
			realtimeEnabled,
			selectedIsCloud,
			selectedModel,
			settings?.realtimeModel,
			statesById,
		],
	);

	const supportedLanguages = selectedInfo?.languages;
	const langOpts =
		!supportedLanguages || supportedLanguages.length === 0
			? ALL_LANG_OPTS
			: ALL_LANG_OPTS.filter(
					(l) => l.id === "" || supportedLanguages.includes(l.id),
				);
	// Which Model-tab controls stay visible. A cloud main hides the local-only
	// knobs (language, idle-unload-timeout, device) — except Device, which
	// local Kokoro TTS also rides on (`model.device` → `--tts-device`). The
	// derivation lives in pure helpers to keep this component under the
	// cognitive-complexity cap.
	const { showDevice, showLanguage } = resolveModelControlVisibility(
		selectedIsCloud,
		supportedLanguages,
		isLocalTtsActive(tts, elevenlabs),
	);

	// Block model switching while files are transcribing — the swap would reload
	// the shared transcriber mid-queue. The detached picker also disables its
	// selector; the reference main enforces the same block as a final safety net.
	const controller = useModelSwapController(
		settings,
		selectedModel,
		currentQuantization,
		deviceValue,
		getModel,
		statesById,
		update,
		isQuantDownloading,
		() => useFileTranscriptionStore.getState().queueActive,
	);

	const useMainModelFlag = quality?.useMainModelForRealtime ?? false;
	const mainModelStreamingKnown = selectedIsCloud || selectedInfo !== undefined;
	const mainModelCanNativeStream =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		isSelectableRealtimeModel(selectedInfo);
	const selectedRealtimeInfo = settings?.realtimeModel
		? getModel(settings.realtimeModel)
		: undefined;
	const effectiveRealtimeInfo = mainModelCanNativeStream
		? selectedInfo
		: selectedRealtimeInfo;
	const updateIntervalApplies =
		isListenMode || effectiveRealtimeInfo?.nativeStreaming !== true;
	const handleRealtimePick = (v: string, quantization?: OnnxQuantization) => {
		if (mainModelCanNativeStream && v !== selectedModel) {
			return;
		}
		controller.handleRealtimeModelChange(v, quantization);
		const shouldReuseMain = v === selectedModel && mainModelCanNativeStream;
		if (shouldReuseMain !== useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: shouldReuseMain });
		}
	};

	useEffect(() => {
		if (!mainModelStreamingKnown) {
			return;
		}
		if (mainModelCanNativeStream) {
			if (settings?.realtimeModel !== selectedModel) {
				update({ realtimeModel: selectedModel });
			}
			if (!useMainModelFlag) {
				updateQuality({ useMainModelForRealtime: true });
			}
			return;
		}
		if (useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: false });
		}
	}, [
		mainModelCanNativeStream,
		mainModelStreamingKnown,
		selectedModel,
		settings?.realtimeModel,
		update,
		updateQuality,
		useMainModelFlag,
	]);

	// Per-quant badge handlers (delete + byte-level pause/resume/cancel) live
	// in one shared feature-layer hook so the settings panel and the detached
	// footer picker wire the exact same controls into SttModelSelector.
	const { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot } =
		useQuantActions();
	const canDeleteQuant = useCallback(
		(modelId: string, quantization: OnnxQuantization) =>
			canDeleteSttQuant(catalogModels, statesById, modelId, quantization),
		[catalogModels, statesById],
	);
	const handleGuardedDeleteQuant = useCallback(
		(modelId: string, quantization: OnnxQuantization) => {
			const recovery = resolveSttDeleteRecovery({
				currentMainModel: selectedModel,
				currentQuantization,
				currentRealtimeModel: settings?.realtimeModel,
				mainModelInfo: selectedInfo,
				modelId,
				models: catalogModels,
				previousModelIds: readLastLocalSttModelHistory(),
				quantization,
				statesById,
			});
			if (!recovery.canDelete) {
				return;
			}
			const requiresRecovery =
				recovery.mainTarget !== undefined ||
				recovery.realtimeTarget !== undefined;
			if (
				requiresRecovery &&
				useFileTranscriptionStore.getState().queueActive
			) {
				return;
			}
			if (recovery.mainTarget) {
				controller.handleModelChange(
					recovery.mainTarget.modelId,
					recovery.mainTarget.quantization,
				);
			}
			if (recovery.realtimeTarget !== undefined) {
				if (recovery.realtimeTarget === null) {
					controller.handleRealtimeModelChange("");
					if (useMainModelFlag) {
						updateQuality({ useMainModelForRealtime: false });
					}
				} else {
					controller.handleRealtimeModelChange(
						recovery.realtimeTarget.modelId,
						recovery.realtimeTarget.quantization,
					);
					const nextMainId = recovery.mainTarget?.modelId ?? selectedModel;
					const realtimeInfo = getModel(recovery.realtimeTarget.modelId);
					const shouldReuseMain =
						recovery.realtimeTarget.modelId === nextMainId &&
						realtimeInfo !== undefined &&
						isSelectableRealtimeModel(realtimeInfo);
					if (shouldReuseMain !== useMainModelFlag) {
						updateQuality({ useMainModelForRealtime: shouldReuseMain });
					}
				}
			}
			handleDeleteQuant(modelId, quantization);
		},
		[
			catalogModels,
			controller,
			currentQuantization,
			getModel,
			handleDeleteQuant,
			selectedInfo,
			selectedModel,
			settings?.realtimeModel,
			statesById,
			updateQuality,
			useMainModelFlag,
		],
	);

	// A precision-badge "download this variant" click opens the confirmation
	// dialog (size + hardware-fit + Download/Cancel) for the right slot instead of
	// silently starting a background fetch — Electron parity. Pause / resume /
	// cancel of an in-flight download still dispatch straight to the server.
	const gateDownloadAction =
		(kind: "main" | "realtime"): typeof handleDownloadAction =>
		(action, modelId, quantization) => {
			if (action === "start") {
				controller.promptDownload(kind, modelId, quantization);
				return;
			}
			handleDownloadAction(action, modelId, quantization, kind);
		};
	const handleMainDownloadAction = gateDownloadAction("main");
	const handleRealtimeDownloadAction = gateDownloadAction("realtime");

	return (
		<div className="flex flex-col gap-2">
			{isListenMode ? null : (
				<MainModelSection
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					downloadProgress={mainDownloadProgress}
					getFitAssessment={getFitAssessment}
					handleModelChange={controller.handleModelChange}
					initialPromptSupported={initialPromptSupported}
					isSwapping={mainSwapping}
					langOpts={langOpts}
					canDeleteQuant={canDeleteQuant}
					onDeleteQuant={handleGuardedDeleteQuant}
					onDownloadAction={handleMainDownloadAction}
					onDownloadSnapshot={handleDownloadSnapshot}
					sections={{
						language: showLanguage,
					}}
					selectedModel={selectedModel}
					settings={settings}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					translateSupported={translateSupported}
					update={update}
				/>
			)}
			{realtimeEnabled && !selectedIsCloud && (
				<RealtimeModelSection
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					downloadProgress={realtimeDownloadProgress}
					getFitAssessment={getFitAssessment}
					handleRealtimeModelChange={handleRealtimePick}
					isSwapping={realtimeSwapping}
					mainModelCanNativeStream={mainModelCanNativeStream}
					mainModelId={selectedModel}
					mainModelInfo={selectedInfo}
					updateIntervalApplies={updateIntervalApplies}
					canDeleteQuant={canDeleteQuant}
					onDeleteQuant={handleGuardedDeleteQuant}
					onDownloadAction={handleRealtimeDownloadAction}
					onDownloadSnapshot={handleDownloadSnapshot}
					quality={quality}
					settings={settings}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					updateQuality={updateQuality}
				/>
			)}
			{/* Speaker diarization - gated to Listen mode (plain cross-tab read of
			    `general.recordingMode`), matching the original General-tab gate.
			    Persists to `general.speakerDiarization`; the runtime toggle wiring
			    lives in the diarization toggle store. */}
			{isListenMode ? <SpeakerDiarizationSection /> : null}
			{/* Compute device — standalone, shared by local STT + local TTS.
			    Shown only when a GPU exists AND a local model needs a device
			    (`showDevice`). With no GPU there is no choice to make (Auto
			    resolves to CPU), so the toggle is hidden rather than shown as a
			    dead single-option switch; it's also hidden when STT and TTS are
			    both cloud. Rendered outside the STT/TTS sections so it doesn't
			    read as belonging to either. */}
			{showDevice && gpuAvailable && (
				<DeviceSection
					deviceOpts={deviceOpts}
					deviceValue={deviceValue}
					t={t}
					update={update}
				/>
			)}
			<ModelLifetimeSection global={global} t={t} update={updateGlobal} />
			<SwapDialogs
				controller={controller}
				getModel={getModel}
				statesById={statesById}
				systemInfo={systemInfo}
				t={t}
			/>
		</div>
	);
}
