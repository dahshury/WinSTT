import {
	AiCloud01Icon,
	AiMagicIcon,
	AiSettingIcon,
	CpuIcon,
	LockIcon,
	SpeechToTextIcon,
} from "@hugeicons/core-free-icons";
import { isRealtimeViable, SttModelSelector } from "@picker";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { DownloadConfirmationDialog, useQuantActions } from "@/features/model-download";
import { CloudModelSelect } from "@/features/select-cloud-stt-model";
import { type SwapController, useModelSwapController } from "@/features/swap-model";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend } from "@/shared/api/ipc-client";
import { LANGUAGES, type OnnxQuantization } from "@/shared/config/defaults";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { useStaleModelFallback } from "../model/use-stale-model-fallback";
import { useSwapProgress } from "../model/use-swap-progress";

export interface ModelSettingsPanelProps {
	llmSlot?: ReactNode;
	ttsSlot?: ReactNode;
}

type TFn = ReturnType<typeof useTranslations>;

type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
type ModelSettings = SettingsStoreState["settings"]["model"];
type QualitySettings = SettingsStoreState["settings"]["quality"];
type UpdateModelFn = SettingsStoreState["updateModelSettings"];
type UpdateQualityFn = SettingsStoreState["updateQualitySettings"];

type DeviceValue = "auto" | "cpu";
type CatalogModels = ReturnType<typeof useCatalogStore.getState>["models"];
type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type SystemInfo = ReturnType<typeof useModelStateStore.getState>["systemInfo"];

interface MainModelSectionProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentQuantization: OnnxQuantization;
	deviceOpts: SwitcherOption<DeviceValue>[];
	deviceValue: DeviceValue;
	/** Snapshot of the in-flight download (model id + percent). Drives the
	 *  picker's "Downloading X · 23%" trigger AND distinguishes "we're
	 *  fetching bytes" from "the server is loading weights" so the picker
	 *  doesn't lock down for the entire multi-GB download. */
	downloadProgress: { modelId: string; percent: number | null } | null;
	gpuAvailable: boolean;
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	isSwapping: boolean;
	langOpts: SelectOption[];
	/** Per-quant delete handler (after the picker's AlertDialog confirms). */
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	/** Per-quant download action — start / pause / resume / cancel. */
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization
	) => void;
	/** Per-quant live download snapshot lookup. */
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization
	) => import("@/features/model-download").QuantDownloadState | undefined;
	selectedModel: string;
	settings: ModelSettings | undefined;
	/** False when the active model advertises exactly one language — the
	 *  picker would only offer "auto-detect + that one language", which is a
	 *  no-op choice, so we hide the language control entirely. Multilingual
	 *  models (empty `languages`) and cloud models keep it. */
	showLanguage: boolean;
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
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	hasAnyCloudKey: boolean;
	initialSourceIsCloud: boolean;
	isCloud: boolean;
	isSwapping: boolean;
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization
	) => void;
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization
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
	handleModelChange,
	hasAnyCloudKey,
	initialSourceIsCloud,
	isCloud,
	isSwapping,
	onDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	selectedModel,
	statesById,
	systemInfo,
	t,
	tIntegrations,
}: SourceAreaProps): ReactNode {
	const [source, setSource] = useState<"local" | "cloud">(initialSourceIsCloud ? "cloud" : "local");
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);
	const sourceOpts: SwitcherOption<"local" | "cloud">[] = [
		{ value: "local", label: tIntegrations("sourceLocal"), icon: CpuIcon },
		{
			value: "cloud",
			label: tIntegrations("sourceCloud"),
			icon: AiCloud01Icon,
			disabled: !hasAnyCloudKey,
			...(hasAnyCloudKey
				? {}
				: {
						badgeIcon: LockIcon,
						badgeTooltip: tIntegrations("sourceCaption"),
						badgeTooltipFooter: tIntegrations("cloudDisabledHint"),
						onBadgeClick: () => goToIntegrations("integrations"),
					}),
		},
	];
	// Open the detached picker window (full work area, can extend beyond the
	// 700×560 settings window) instead of an in-window popup — mirrors the
	// main-window footer chip. Main anchors it above this trigger's rect.
	const openDetachedPicker = (rect: DOMRect) =>
		ipcSend(IPC.MODEL_PICKER_OPEN, {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
			kind: "main",
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
							onChange={(v) => setSource(v)}
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
							kind="main"
							models={catalogModels}
							onChange={handleModelChange}
							onDeleteQuant={onDeleteQuant}
							onDownloadAction={onDownloadAction}
							onDownloadSnapshot={onDownloadSnapshot}
							onOpenDetached={openDetachedPicker}
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

function MainModelSection({
	t,
	settings,
	update,
	catalogModels,
	catalogLoaded,
	statesById,
	systemInfo,
	currentQuantization,
	deviceOpts,
	deviceValue,
	downloadProgress,
	gpuAvailable,
	isSwapping,
	langOpts,
	onDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	selectedModel,
	handleModelChange,
	showLanguage,
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
		<SettingSection icon={SpeechToTextIcon} title={t("mainModel")}>
			<div className="flex flex-col divide-y divide-surface-1">
				{/* `key` resets the local `source` state inside SourceArea whenever
				 *  the persisted model's source changes or API-key availability
				 *  flips — no derived-state effect needed. */}
				<SourceArea
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					downloadProgress={downloadProgress}
					handleModelChange={handleModelChange}
					hasAnyCloudKey={hasAnyCloudKey}
					initialSourceIsCloud={effectiveSourceIsCloud}
					isCloud={isCloud}
					isSwapping={isSwapping}
					key={effectiveSourceIsCloud ? "cloud" : "local"}
					onDeleteQuant={onDeleteQuant}
					onDownloadAction={onDownloadAction}
					onDownloadSnapshot={onDownloadSnapshot}
					selectedModel={selectedModel}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					tIntegrations={tIntegrations}
				/>
				{showLanguage && (
					<FormControl label={t("language")} layout="row">
						<ElevatedSurface className="w-52" inline>
							<SearchableSelect
								onChange={(v) => update({ language: v })}
								options={langOpts}
								value={settings?.language ?? "en"}
							/>
						</ElevatedSurface>
					</FormControl>
				)}
				<FormControl
					label={t("device")}
					layout="row"
					tooltip={gpuAvailable ? t("deviceCaptionGpu") : t("deviceCaptionNoGpu")}
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
					<FormControl
						label={t("translateToEnglish")}
						labelAddon={
							<Toggle
								checked={settings?.translateToEnglish ?? false}
								onCheckedChange={(v) => update({ translateToEnglish: v })}
							/>
						}
						tooltip={t("translateToEnglishTooltip")}
					/>
				)}
				<FormControl
					label={t("modelUnloadTimeout")}
					layout="row"
					tooltip={t("modelUnloadTimeoutTooltip")}
				>
					<ElevatedSurface className="w-52" inline>
						<SearchableSelect
							onChange={(v) =>
								update({
									modelUnloadTimeout: v as
										| "immediately"
										| "never"
										| "min2"
										| "min5"
										| "min10"
										| "min15"
										| "hour1",
								})
							}
							options={[
								{ id: "immediately", label: t("modelUnloadImmediately") },
								{ id: "never", label: t("modelUnloadNever") },
								{ id: "min2", label: t("modelUnloadMin2") },
								{ id: "min5", label: t("modelUnloadMin5") },
								{ id: "min10", label: t("modelUnloadMin10") },
								{ id: "min15", label: t("modelUnloadMin15") },
								{ id: "hour1", label: t("modelUnloadHour1") },
							]}
							value={settings?.modelUnloadTimeout ?? "min5"}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
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
	handleRealtimeModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	isSwapping: boolean;
	/** Forwarded to the picker — same handler the main picker uses. */
	onDeleteQuant: (modelId: string, quantization: OnnxQuantization) => void;
	/** Forwarded to the picker — per-quant download action. */
	onDownloadAction: (
		action: "start" | "pause" | "resume" | "cancel",
		modelId: string,
		quantization: OnnxQuantization
	) => void;
	/** Forwarded to the picker — per-quant download snapshot lookup. */
	onDownloadSnapshot: (
		modelId: string,
		quantization: OnnxQuantization
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
	isSwapping,
	handleRealtimeModelChange,
	onDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
}: RealtimeModelSectionProps): ReactNode {
	const realtimeModelId = settings?.realtimeModel ?? "tiny";
	// Identical to the main STT model selector — same component, same detached
	// picker window; the ONLY difference is the realtime prefilter.
	const openDetachedRealtimePicker = (rect: DOMRect) =>
		ipcSend(IPC.MODEL_PICKER_OPEN, {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
			kind: "realtime",
		});
	return (
		<SettingSection icon={AiMagicIcon} title={t("realtimeModelSection")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl label={t("realtimeModel")} tooltip={t("realtimeModelTooltip")}>
						<SttModelSelector
							currentQuantization={currentQuantization}
							downloadProgress={downloadProgress}
							isLoading={!catalogLoaded || isSwapping}
							kind="realtime"
							models={catalogModels}
							onChange={handleRealtimeModelChange}
							onDeleteQuant={onDeleteQuant}
							onDownloadAction={onDownloadAction}
							onDownloadSnapshot={onDownloadSnapshot}
							onOpenDetached={openDetachedRealtimePicker}
							prefilter={isRealtimeViable}
							statesById={statesById}
							systemInfo={systemInfo}
							value={realtimeModelId}
						/>
					</FormControl>
				</div>
				<FormControl
					label={t("updateInterval")}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(quality?.realtimeProcessingPause ??
									DEFAULT_SETTINGS.quality.realtimeProcessingPause) ===
								DEFAULT_SETTINGS.quality.realtimeProcessingPause
							}
							onReset={() =>
								updateQuality({
									realtimeProcessingPause: DEFAULT_SETTINGS.quality.realtimeProcessingPause,
								})
							}
						/>
					}
					layout="row"
					tooltip={t("updateIntervalTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							min={0.01}
							onChange={(v) => updateQuality({ realtimeProcessingPause: v })}
							step={0.01}
							value={
								quality?.realtimeProcessingPause ?? DEFAULT_SETTINGS.quality.realtimeProcessingPause
							}
						/>
					</ElevatedSurface>
				</FormControl>
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
function buildDeviceOpts(t: TFn, gpuAvailable: boolean): SwitcherOption<DeviceValue>[] {
	const cpu: SwitcherOption<DeviceValue> = {
		value: "cpu",
		label: t("deviceCpuLabel"),
		icon: CpuIcon,
	};
	if (!gpuAvailable) {
		return [cpu];
	}
	return [{ value: "auto", label: t("deviceAutoLabel"), icon: AiSettingIcon }, cpu];
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
	const { pendingDownload, pendingFitWarning, setPendingFitWarning } = controller;
	return (
		<>
			<DownloadConfirmationDialog
				getModel={getModel}
				onCancel={controller.cancelPendingDownload}
				onConfirm={controller.confirmPendingDownload}
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
				t={(key, vars) => t(`resourceWarning.${key}` as Parameters<typeof t>[0], vars)}
			/>
		</>
	);
}

export function ModelSettingsPanel({ llmSlot, ttsSlot }: ModelSettingsPanelProps = {}) {
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const isListenMode = recordingMode === "listen";
	const showRecordingOverlay = useSettingsStore(
		(s) => s.settings.general?.showRecordingOverlay ?? true
	);
	const liveTranscriptionDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both"
	);
	// Realtime is fully derived from the display picker — the engine has no
	// observable output without a display surface, so there is no separate
	// on/off toggle. The realtime section here is hidden when this is false.
	const realtimeEnabled = isRealtimeEnabled({
		showRecordingOverlay,
		liveTranscriptionDisplay,
	});
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo?.available ?? true;
	const t = useTranslations("model");
	const deviceOpts = buildDeviceOpts(t, gpuAvailable);
	const deviceValue: DeviceValue = gpuAvailable ? (settings?.device ?? "auto") : "cpu";

	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);

	// Model-state store — drives the inline cache badges and the ⚠ icon
	// in the dropdown labels. Refresh on mount so the server gets re-probed
	// each time the settings panel opens; live updates come through the
	// store's IPC subscriptions (model_cache_changed / swap_completed).
	const statesById = useModelStateStore((s) => s.statesById);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	// Live download + swap snapshot lives in its own hook so the panel stays
	// at a reasonable cognitive-complexity score.
	const { downloadProgress, mainSwapping, realtimeSwapping } = useSwapProgress();

	// Live host resource snapshot (RAM available, free VRAM, CPU%) for the
	// resource-aware warning modal. Refreshed when the panel mounts.
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
		settings?.model,
		settings?.realtimeModel,
		update
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
	// Translate-to-English is honored on multilingual Whisper exports
	// (via the ``<|translate|>`` prompt token) AND on NeMo Canary (via
	// the ``target_language`` recognize kwarg). Anything else silently
	// no-ops server-side, so we hide the toggle there to avoid lying
	// to the user. ``.en`` Whisper variants are filtered by the
	// language-detection capability — they advertise English only and
	// have no need for translate-to-English.
	const translateSupported =
		!selectedIsCloud &&
		selectedInfo !== undefined &&
		((selectedInfo.family === "whisper" && selectedInfo.supportsLanguageDetection) ||
			selectedInfo.family === "nemo");
	const currentQuantization = (settings?.onnxQuantization ?? "") as OnnxQuantization;

	const supportedLanguages = selectedInfo?.languages;
	const langOpts =
		!supportedLanguages || supportedLanguages.length === 0
			? ALL_LANG_OPTS
			: ALL_LANG_OPTS.filter((l) => l.id === "" || supportedLanguages.includes(l.id));
	// Hide the language control for single-language models — the picker would
	// only offer "auto-detect + that one language", which is a no-op choice.
	// Multilingual models (empty `languages`) and cloud models (no catalog
	// entry, so `supportedLanguages` is undefined) keep the control.
	const showLanguage = supportedLanguages?.length !== 1;

	const controller = useModelSwapController(
		settings,
		selectedModel,
		currentQuantization,
		deviceValue,
		getModel,
		statesById,
		update
	);

	const handleRealtimePick = (v: string, quantization?: OnnxQuantization) => {
		controller.handleRealtimeModelChange(v, quantization);
		// Picking the main model as the realtime model lets the server reuse the
		// already-loaded main transcriber; any other pick loads that model.
		updateQuality({ useMainModelForRealtime: v === selectedModel });
	};

	// Per-quant badge handlers (delete + byte-level pause/resume/cancel) live
	// in one shared feature-layer hook so the settings panel and the detached
	// footer picker wire the exact same controls into SttModelSelector.
	const { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot } = useQuantActions();

	return (
		<div className="flex flex-col gap-2">
			{isListenMode ? null : (
				<MainModelSection
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					deviceOpts={deviceOpts}
					deviceValue={deviceValue}
					downloadProgress={downloadProgress}
					gpuAvailable={gpuAvailable}
					handleModelChange={controller.handleModelChange}
					isSwapping={mainSwapping}
					langOpts={langOpts}
					onDeleteQuant={handleDeleteQuant}
					onDownloadAction={handleDownloadAction}
					onDownloadSnapshot={handleDownloadSnapshot}
					selectedModel={selectedModel}
					settings={settings}
					showLanguage={showLanguage}
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
					downloadProgress={downloadProgress}
					handleRealtimeModelChange={handleRealtimePick}
					isSwapping={realtimeSwapping}
					onDeleteQuant={handleDeleteQuant}
					onDownloadAction={handleDownloadAction}
					onDownloadSnapshot={handleDownloadSnapshot}
					quality={quality}
					settings={settings}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					updateQuality={updateQuality}
				/>
			)}
			{llmSlot}
			{ttsSlot}
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
