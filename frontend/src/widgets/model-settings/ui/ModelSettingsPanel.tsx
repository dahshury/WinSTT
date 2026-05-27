import {
	AiCloud01Icon,
	AiMagicIcon,
	AiSettingIcon,
	CpuIcon,
	LockIcon,
	SpeechToTextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isRealtimeViable, SttModelSelector } from "@picker";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import {
	needsModelFallback,
	pickDefaultSttModel,
	useCatalogStore,
	useModelStateStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { DownloadConfirmationDialog } from "@/features/model-download";
import { CloudModelSelect } from "@/features/select-cloud-stt-model";
import { type SwapController, useModelSwapController } from "@/features/swap-model";
import { LANGUAGES, type OnnxQuantization } from "@/shared/config/defaults";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { Tooltip } from "@/shared/ui/tooltip";

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
	gpuAvailable: boolean;
	handleModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	isSwapping: boolean;
	langOpts: SelectOption[];
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
	gpuAvailable,
	isSwapping,
	langOpts,
	selectedModel,
	handleModelChange,
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

	// Local-only UI state for which picker is on screen. Initialised from the
	// persisted model (cloud `provider:*` id → "cloud", otherwise "local") so
	// the user lands on the picker that matches what's currently selected.
	// Toggling the source does NOT touch persisted settings — the persisted
	// model only changes when the user picks a row from the visible picker.
	const [source, setSource] = useState<"local" | "cloud">(
		effectiveSourceIsCloud ? "cloud" : "local"
	);
	// Re-sync if the persisted model changes underneath us (e.g. another
	// window picked a model) or the API-key availability flips.
	useEffect(() => {
		setSource(effectiveSourceIsCloud ? "cloud" : "local");
	}, [effectiveSourceIsCloud]);

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
						badgeTooltip: tIntegrations("cloudDisabledHint"),
						onBadgeClick: () => goToIntegrations("integrations"),
					}),
		},
	];

	return (
		<SettingSection icon={SpeechToTextIcon} title={t("mainModel")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl
						caption={tIntegrations("sourceCaption")}
						label={tIntegrations("sourceLabel")}
						tooltip={tIntegrations("sourceTooltip")}
					>
						<div className="flex flex-col gap-1.5">
							<ElevatedSurface>
								<Switcher onChange={(v) => setSource(v)} options={sourceOpts} value={source} />
							</ElevatedSurface>
							{hasAnyCloudKey ? null : (
								<button
									className="inline-flex w-fit cursor-pointer items-center gap-1 bg-transparent text-2xs text-foreground-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
									onClick={() => goToIntegrations("integrations")}
									type="button"
								>
									<HugeiconsIcon
										aria-hidden="true"
										className="shrink-0"
										icon={LockIcon}
										size={10}
									/>
									{tIntegrations("cloudDisabledHint")}
								</button>
							)}
						</div>
					</FormControl>
				</div>
				<div className="col-span-2">
					<FormControl caption={t("modelCaption")} label={t("model")} tooltip={t("modelTooltip")}>
						{source === "cloud" ? (
							<CloudModelSelect
								onSelect={(id) => handleModelChange(id)}
								selectedId={isCloud ? selectedModel : ""}
							/>
						) : (
							<SttModelSelector
								currentQuantization={currentQuantization}
								isLoading={!catalogLoaded || isSwapping}
								kind="main"
								models={catalogModels}
								onChange={handleModelChange}
								statesById={statesById}
								systemInfo={systemInfo}
								value={isCloud ? "" : selectedModel}
							/>
						)}
					</FormControl>
				</div>
				<FormControl caption={t("languageCaption")} label={t("language")}>
					<ElevatedSurface inline>
						<SearchableSelect
							onChange={(v) => update({ language: v })}
							options={langOpts}
							value={settings?.language ?? "en"}
						/>
					</ElevatedSurface>
				</FormControl>
				<FormControl
					caption={gpuAvailable ? t("deviceCaptionGpu") : t("deviceCaptionNoGpu")}
					label={t("device")}
				>
					<ElevatedSurface>
						<Switcher
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
				    is one of the two supported. Matches Handy's gating
				    (managers/transcription.rs:545 + :607). */}
				{translateSupported && (
					<FormControl
						caption={t("translateToEnglishCaption")}
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
					caption={t("modelUnloadTimeoutCaption")}
					label={t("modelUnloadTimeout")}
					tooltip={t("modelUnloadTimeoutTooltip")}
				>
					<ElevatedSurface inline>
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
	handleRealtimeModelChange: (modelId: string, quantization?: OnnxQuantization) => void;
	isSwapping: boolean;
	mainModelId: string;
	onUseMainModel: () => void;
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
	isSwapping,
	handleRealtimeModelChange,
	mainModelId,
	onUseMainModel,
}: RealtimeModelSectionProps): ReactNode {
	// The dedicated realtime picker stays interactive at all times so the user
	// can always pick a different realtime model. The "Use Main Model" affordance
	// is the trailing button on the picker's header.
	const realtimeModelId = settings?.realtimeModel ?? "tiny";
	const modelsMatch = realtimeModelId === mainModelId;
	return (
		<SettingSection icon={AiMagicIcon} title={t("realtimeModelSection")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl
						caption={t("realtimeModelCaption")}
						label={t("realtimeModel")}
						labelTrailing={
							<Tooltip content={t("useMainModelTooltip")}>
								<Button
									className="rounded-md bg-transparent px-1.5 py-0.5 font-medium text-2xs text-foreground-muted leading-none ring-1 ring-divider-strong ring-inset transition-colors hover:not-disabled:bg-surface-2 hover:not-disabled:text-foreground"
									disabled={modelsMatch}
									onClick={onUseMainModel}
								>
									{t("useMainModel")}
								</Button>
							</Tooltip>
						}
						tooltip={t("realtimeModelTooltip")}
					>
						<SttModelSelector
							currentQuantization={currentQuantization}
							isLoading={!catalogLoaded || isSwapping}
							kind="realtime"
							models={catalogModels}
							onChange={handleRealtimeModelChange}
							prefilter={isRealtimeViable}
							statesById={statesById}
							systemInfo={systemInfo}
							value={realtimeModelId}
						/>
					</FormControl>
				</div>
				<FormControl
					caption={t("updateIntervalCaption")}
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
	const deviceOpts = useMemo(() => buildDeviceOpts(t, gpuAvailable), [t, gpuAvailable]);
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
	const mainSwapping = useModelSwapStore((s) => s.activeMain !== null);
	const realtimeSwapping = useModelSwapStore((s) => s.activeRealtime !== null);

	// Live host resource snapshot (RAM available, free VRAM, CPU%) for the
	// resource-aware warning modal. Refreshed when the panel mounts.
	const refreshLive = useSystemResourcesStore((s) => s.refresh);

	useEffect(() => {
		refreshModelState();
		refreshLive();
	}, [refreshModelState, refreshLive]);

	// Guard: STT is the always-on core capability — the selector must never
	// be in a "no model" state. If the saved id is empty (corrupted settings)
	// or refers to a model that's no longer in the catalog (catalog change),
	// auto-pick the smallest cached model so the user always lands on
	// something usable. Skips while the catalog is still loading so we don't
	// false-positive every model as missing during the boot race. Also skips
	// when the active model is a cloud `provider:*` id — those are never in
	// the local catalog by design and should not trigger a fallback.
	useEffect(() => {
		if (!catalogLoaded) {
			return;
		}
		if (providerOf(settings?.model ?? "") !== null) {
			return;
		}
		if (!needsModelFallback(settings?.model, catalogModels)) {
			return;
		}
		const next = pickDefaultSttModel(catalogModels, statesById);
		if (next && next !== settings?.model) {
			// Look up the picked model's catalog entry so we can patch
			// ``model`` and ``backend`` together — ``updateModelSettings``
			// rejects a model-only patch (see the typed ``ModelPatch``).
			// This was the original drift site: the fallback used to write
			// ``{ model: "tiny" }`` while leaving ``backend`` at whatever
			// the previous model used. Disk saved a mismatched pair, every
			// subsequent boot loaded the wrong engine for the right model.
			const fallbackEntry = catalogModels.find((m) => m.id === next);
			if (fallbackEntry?.backend) {
				update({ model: next, backend: fallbackEntry.backend });
			}
		}
	}, [catalogLoaded, catalogModels, statesById, settings?.model, update]);

	// Same guard for the realtime model, narrowed to realtime-viable entries.
	useEffect(() => {
		if (!catalogLoaded) {
			return;
		}
		const realtimeViable = catalogModels.filter((m) => m.supportsRealtime);
		if (!needsModelFallback(settings?.realtimeModel, realtimeViable)) {
			return;
		}
		const next = pickDefaultSttModel(catalogModels, statesById, (m) => m.supportsRealtime);
		if (next && next !== settings?.realtimeModel) {
			update({ realtimeModel: next });
		}
	}, [catalogLoaded, catalogModels, statesById, settings?.realtimeModel, update]);

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

	const langOpts = useMemo(() => {
		const supported = selectedInfo?.languages;
		if (!supported || supported.length === 0) {
			return ALL_LANG_OPTS;
		}
		return ALL_LANG_OPTS.filter((l) => l.id === "" || supported.includes(l.id));
	}, [selectedInfo?.languages]);

	const controller = useModelSwapController(
		settings,
		selectedModel,
		currentQuantization,
		deviceValue,
		getModel,
		statesById,
		update
	);

	const useMainModelFlag = quality?.useMainModelForRealtime ?? false;
	const handleUseMainModel = () => {
		// Mirror the main model into the realtime slot. The controller no-ops when
		// the ids already match, so this is safe to call unconditionally. Also flip
		// the server flag so the realtime worker actually reuses the loaded main
		// transcriber instead of loading a duplicate.
		controller.handleRealtimeModelChange(selectedModel);
		if (!useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: true });
		}
	};
	const handleRealtimePick = (v: string, quantization?: OnnxQuantization) => {
		controller.handleRealtimeModelChange(v, quantization);
		// Picking a model that is NOT the main model means the user wants a
		// separate realtime model — clear the server flag so it actually loads.
		if (v !== selectedModel && useMainModelFlag) {
			updateQuality({ useMainModelForRealtime: false });
		}
	};

	return (
		<div className="flex flex-col gap-2">
			{isListenMode ? null : (
				<MainModelSection
					catalogLoaded={catalogLoaded}
					catalogModels={catalogModels}
					currentQuantization={currentQuantization}
					deviceOpts={deviceOpts}
					deviceValue={deviceValue}
					gpuAvailable={gpuAvailable}
					handleModelChange={controller.handleModelChange}
					isSwapping={mainSwapping}
					langOpts={langOpts}
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
					handleRealtimeModelChange={handleRealtimePick}
					isSwapping={realtimeSwapping}
					mainModelId={selectedModel}
					onUseMainModel={handleUseMainModel}
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
