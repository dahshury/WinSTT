"use client";

import { AiMagicIcon, AiSettingIcon, CpuIcon, SpeechToTextIcon } from "@hugeicons/core-free-icons";
import { isRealtimeViable, resolveQuantCache, SttModelSelector } from "@picker";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelStateStore, useModelSwapStore } from "@/entities/model-catalog";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { useDownloadStore } from "@/features/model-download";
import {
	type FitAssessmentEntry,
	onModelDownloadComplete,
	onModelSwapFailed,
	sttReloadModel,
} from "@/shared/api/ipc-client";
import { LANGUAGES, type OnnxQuantization } from "@/shared/config/defaults";
import { formatBytes } from "@/shared/lib/format-bytes";
import { surfaceClasses, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { DownloadActions, type DownloadPhase, DownloadProgressBar } from "@/shared/ui/download";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Modal } from "@/shared/ui/modal";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

/** "12 MB / 30 MB · 2 MB/s" — drives the right-side caption on the dictation
 *  progress bar. Hidden when no total has been received yet (early frames). */
function formatStatsLine(downloaded: number, total: number, speed: number): string {
	const parts: string[] = [];
	if (total > 0) {
		parts.push(`${formatBytes(downloaded) ?? "0 B"} / ${formatBytes(total) ?? "0 B"}`);
	}
	if (speed > 0) {
		if (speed < 1024) {
			parts.push(`${speed.toFixed(0)} B/s`);
		} else if (speed < 1024 * 1024) {
			parts.push(`${(speed / 1024).toFixed(1)} KB/s`);
		} else {
			parts.push(`${(speed / (1024 * 1024)).toFixed(1)} MB/s`);
		}
	}
	return parts.join(" · ");
}

/** Byte size with this widget's legacy `<= 0 → "unknown"` sentinel. */
function sizeLabel(bytes: number | null | undefined): string {
	return formatBytes(bytes) ?? "unknown";
}

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
	isWhisperBackend: boolean;
	langOpts: SelectOption[];
	selectedModel: string;
	settings: ModelSettings | undefined;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
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
	isWhisperBackend,
	langOpts,
	selectedModel,
	handleModelChange,
}: MainModelSectionProps): ReactNode {
	return (
		<SettingSection icon={SpeechToTextIcon} title={t("mainModel")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl caption={t("modelCaption")} label={t("model")} tooltip={t("modelTooltip")}>
						<SttModelSelector
							currentQuantization={currentQuantization}
							isLoading={!catalogLoaded || isSwapping}
							models={catalogModels}
							onChange={handleModelChange}
							statesById={statesById}
							systemInfo={systemInfo}
							value={selectedModel}
						/>
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
				{isWhisperBackend && (
					<FormControl
						caption={t("beamSizeCaption")}
						label={t("beamSize")}
						tooltip={t("beamSizeTooltip")}
					>
						<ElevatedSurface inline>
							<NumberStepper
								max={20}
								min={1}
								onChange={(v) => update({ beamSize: v })}
								step={1}
								value={settings?.beamSize ?? 5}
							/>
						</ElevatedSurface>
					</FormControl>
				)}
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
	isWhisperBackend: boolean;
	onToggle: (v: boolean) => void;
	quality: QualitySettings | undefined;
	realtimeEnabled: boolean;
	settings: ModelSettings | undefined;
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
	update: UpdateModelFn;
	updateQuality: UpdateQualityFn;
}

function RealtimeModelSection({
	t,
	settings,
	update,
	quality,
	updateQuality,
	catalogModels,
	catalogLoaded,
	statesById,
	systemInfo,
	currentQuantization,
	realtimeEnabled,
	onToggle,
	isSwapping,
	isWhisperBackend,
	handleRealtimeModelChange,
}: RealtimeModelSectionProps): ReactNode {
	// When the realtime worker reuses the main model, the dedicated realtime
	// model picker and beam size have no effect server-side — gray them out so
	// the user isn't tweaking dead controls. The update interval still drives
	// how often realtime fires, so it stays enabled.
	const useMainModel = quality?.useMainModelForRealtime ?? false;
	return (
		<SettingSection
			icon={AiMagicIcon}
			onToggle={onToggle}
			title={t("realtimeModelSection")}
			toggled={realtimeEnabled}
		>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl
						caption={t("realtimeModelCaption")}
						disabled={useMainModel}
						label={t("realtimeModel")}
						tooltip={t("realtimeModelTooltip")}
					>
						<SttModelSelector
							currentQuantization={currentQuantization}
							disabled={useMainModel}
							isLoading={!catalogLoaded || isSwapping}
							models={catalogModels}
							onChange={handleRealtimeModelChange}
							prefilter={isRealtimeViable}
							statesById={statesById}
							systemInfo={systemInfo}
							value={settings?.realtimeModel ?? "tiny"}
						/>
					</FormControl>
				</div>
				<FormControl
					caption={t("useMainModelCaption")}
					label={t("useMainModel")}
					labelAddon={
						<Toggle
							checked={useMainModel}
							onCheckedChange={(v) => updateQuality({ useMainModelForRealtime: v })}
						/>
					}
					tooltip={t("useMainModelTooltip")}
				/>
				<FormControl
					caption={t("updateIntervalCaption")}
					label={t("updateInterval")}
					tooltip={t("updateIntervalTooltip")}
				>
					<ElevatedSurface inline>
						<NumberStepper
							min={0.01}
							onChange={(v) => updateQuality({ realtimeProcessingPause: v })}
							step={0.01}
							value={quality?.realtimeProcessingPause ?? 0.02}
						/>
					</ElevatedSurface>
				</FormControl>
				{isWhisperBackend && (
					<FormControl
						caption={t("realtimeBeamSizeCaption")}
						disabled={useMainModel}
						label={t("realtimeBeamSize")}
						tooltip={t("realtimeBeamSizeTooltip")}
					>
						<ElevatedSurface inline>
							<NumberStepper
								max={20}
								min={1}
								onChange={(v) => update({ beamSizeRealtime: v })}
								step={1}
								value={settings?.beamSizeRealtime ?? 3}
							/>
						</ElevatedSurface>
					</FormControl>
				)}
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

/** Fire-and-forget guard for the model-swap gate. The gate already surfaces
 *  user-facing failures via the resource/download dialogs; this only keeps an
 *  unexpected rejection from becoming an unhandled promise. */
function reportSwapGateError(err: unknown): void {
	console.error("model swap gate failed", err);
}

// Pending-download confirmation dialog state. Holds the model id that
// the user picked when it wasn't already cached. Cleared on confirm or
// cancel; cancel also reverts the picker (mirror of swap-failed path).
interface PendingDownload {
	kind: "main" | "realtime";
	modelId: string;
	previousModelId: string;
	quantization?: OnnxQuantization;
}

// Pending resource-warning dialog state. When the server's fit assessment
// returns ``critical`` (definitely won't fit), we hold the user's choice
// here and require an explicit "Proceed anyway" before either kicking off
// the download or issuing the swap. Cancel reverts the picker silently.
interface PendingFitWarning {
	assessment: FitAssessmentEntry;
	candidateName: string;
	// next: what to do after the user confirms. Either open the download
	// dialog or issue the swap directly, depending on cache state at
	// decision time.
	next: () => void;
}

interface SwapController {
	cancelPendingDownload: () => void;
	confirmPendingDownload: () => void;
	handleModelChange: (v: string, quantization?: OnnxQuantization) => void;
	handleRealtimeModelChange: (v: string, quantization?: OnnxQuantization) => void;
	pendingDownload: PendingDownload | null;
	pendingFitWarning: PendingFitWarning | null;
	setPendingFitWarning: (value: PendingFitWarning | null) => void;
}

/** Owns the resource-gate → download-confirm → hot-swap pipeline plus its
 *  rollback effects. Extracted from the panel so the widget body stays a
 *  thin composition shell. */
function useModelSwapController(
	settings: ModelSettings | undefined,
	selectedModel: string,
	currentQuantization: OnnxQuantization,
	deviceValue: DeviceValue,
	getModel: ReturnType<typeof useCatalogStore.getState>["getModel"],
	statesById: StatesById,
	update: UpdateModelFn
): SwapController {
	const assessDictationFitOnServer = useSystemResourcesStore((s) => s.assessDictationFitOnServer);

	// Track the previous model id for each picker so a server-side swap
	// failure can revert the setting back to what was actually loaded.
	const prevMainModelRef = useRef<string | null>(null);
	const prevRealtimeModelRef = useRef<string | null>(null);

	const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);
	const [pendingFitWarning, setPendingFitWarning] = useState<PendingFitWarning | null>(null);

	const issueSwap = useCallback(
		(
			kind: "main" | "realtime",
			value: string,
			previous: string,
			quantization?: OnnxQuantization
		) => {
			const quantizationChanging =
				quantization !== undefined && quantization !== currentQuantization;
			if (kind === "main") {
				const info = getModel(value);
				prevMainModelRef.current = previous;
				const patch: Parameters<UpdateModelFn>[0] = info
					? { model: value, backend: info.backend }
					: { model: value };
				if (quantizationChanging) {
					patch.onnxQuantization = quantization;
				}
				update(patch);
			} else {
				prevRealtimeModelRef.current = previous;
				const patch: Parameters<UpdateModelFn>[0] = { realtimeModel: value };
				if (quantizationChanging) {
					patch.onnxQuantization = quantization;
				}
				update(patch);
			}
			// model.onnxQuantization is a STARTUP_ONLY key — touching it triggers a
			// full server restart that boots with the new quantization (and the new
			// model field). Skip the hot-swap call to avoid racing the restart.
			if (!quantizationChanging) {
				sttReloadModel(kind, value);
			}
		},
		[update, getModel, currentQuantization]
	);

	// Common downstream behavior once the user has accepted any warnings:
	// either prompt for download (if target precision isn't cached) or
	// hot-swap directly.
	const proceedWithSelection = useCallback(
		(
			kind: "main" | "realtime",
			v: string,
			previous: string,
			quantization: OnnxQuantization | undefined
		) => {
			// If the *target precision* isn't already on disk, prompt before
			// kicking off the download — a model can be cached at int8 but not
			// at fp16, so check the quantization the swap will actually load.
			const state = statesById[v];
			const targetQuant = quantization ?? currentQuantization;
			const targetCache = resolveQuantCache(state, targetQuant);
			if (state && targetCache?.state !== "cached") {
				setPendingDownload({ kind, modelId: v, previousModelId: previous, quantization });
				return;
			}
			issueSwap(kind, v, previous, quantization);
		},
		[issueSwap, statesById, currentQuantization]
	);

	// Resource-aware gate: round-trip the server for an authoritative fit
	// verdict. If ``critical`` (won't fit given current load), surface the
	// ResourceWarningDialog and stash the onward action; otherwise proceed
	// straight to the existing download/swap path.
	const gateWithAssessment = useCallback(
		async (
			kind: "main" | "realtime",
			v: string,
			previous: string,
			quantization: OnnxQuantization | undefined
		) => {
			const candidate = getModel(v);
			const candidateName = candidate?.displayName ?? v;
			const targetQuant = quantization ?? currentQuantization;
			const assessment = await assessDictationFitOnServer(v, targetQuant, deviceValue);
			if (assessment && assessment.severity === "critical") {
				setPendingFitWarning({
					assessment,
					candidateName,
					next: () => proceedWithSelection(kind, v, previous, quantization),
				});
				return;
			}
			proceedWithSelection(kind, v, previous, quantization);
		},
		[assessDictationFitOnServer, currentQuantization, deviceValue, getModel, proceedWithSelection]
	);

	const handleModelChange = useCallback(
		(v: string, quantization?: OnnxQuantization) => {
			const currentModel = settings?.model ?? selectedModel;
			const quantizationChanging =
				quantization !== undefined && quantization !== currentQuantization;
			if (v === currentModel) {
				// Pure quantization swap on the already-loaded model. Push the new
				// value; the STARTUP_ONLY restart handles the rest.
				if (quantizationChanging) {
					update({ onnxQuantization: quantization });
				}
				return;
			}
			gateWithAssessment("main", v, currentModel, quantization).catch(reportSwapGateError);
		},
		[gateWithAssessment, settings?.model, selectedModel, currentQuantization, update]
	);

	const handleRealtimeModelChange = useCallback(
		(v: string, quantization?: OnnxQuantization) => {
			const current = settings?.realtimeModel ?? "";
			const quantizationChanging =
				quantization !== undefined && quantization !== currentQuantization;
			if (v === current) {
				if (quantizationChanging) {
					update({ onnxQuantization: quantization });
				}
				return;
			}
			gateWithAssessment("realtime", v, current, quantization).catch(reportSwapGateError);
		},
		[gateWithAssessment, settings?.realtimeModel, currentQuantization, update]
	);

	// Kick off the swap (which triggers the download) but keep the modal
	// open so the user sees live progress and can Stop without re-clicking
	// the picker. Closing only happens on explicit Cancel/Esc or when the
	// download-complete event fires (handled below).
	const confirmPendingDownload = useCallback(() => {
		if (!pendingDownload) {
			return;
		}
		issueSwap(
			pendingDownload.kind,
			pendingDownload.modelId,
			pendingDownload.previousModelId,
			pendingDownload.quantization
		);
	}, [issueSwap, pendingDownload]);

	const cancelPendingDownload = useCallback(() => {
		setPendingDownload(null);
	}, []);

	// Auto-close when the model the modal is targeting finishes downloading
	// successfully — at that point the swap completes naturally and the
	// settings panel can show the new active model. Cancellations keep the
	// modal open so the user can resume or discard.
	useEffect(
		() =>
			onModelDownloadComplete((model, cancelled) => {
				if (cancelled) {
					return;
				}
				setPendingDownload((current) => (current?.modelId === model ? null : current));
			}),
		[]
	);

	// Failure handler: roll the picker back to whatever was loaded before
	// the user's selection. Uses the per-kind ref captured at click time.
	useEffect(
		() =>
			onModelSwapFailed(({ kind }) => {
				if (kind === "main") {
					const prev = prevMainModelRef.current;
					if (prev !== null) {
						update({ model: prev });
					}
				} else {
					const prev = prevRealtimeModelRef.current;
					if (prev !== null) {
						update({ realtimeModel: prev });
					}
				}
			}),
		[update]
	);

	return {
		pendingDownload,
		pendingFitWarning,
		setPendingFitWarning,
		handleModelChange,
		handleRealtimeModelChange,
		confirmPendingDownload,
		cancelPendingDownload,
	};
}

interface SwapDialogsProps {
	controller: SwapController;
	getModel: ReturnType<typeof useCatalogStore.getState>["getModel"];
	statesById: StatesById;
	systemInfo: SystemInfo;
	t: TFn;
}

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
	const realtimeEnabled = quality?.enableRealtimeTranscription ?? true;
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

	const selectedModel = settings?.model ?? "large-v2";
	const selectedInfo = getModel(selectedModel);
	const isWhisperBackend = !selectedInfo || selectedInfo.backend === "faster_whisper";
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

	const handleRealtimeToggle = useCallback(
		(v: boolean) => updateQuality({ enableRealtimeTranscription: v }),
		[updateQuality]
	);

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
					isWhisperBackend={isWhisperBackend}
					langOpts={langOpts}
					selectedModel={selectedModel}
					settings={settings}
					statesById={statesById}
					systemInfo={systemInfo}
					t={t}
					update={update}
				/>
			)}
			<RealtimeModelSection
				catalogLoaded={catalogLoaded}
				catalogModels={catalogModels}
				currentQuantization={currentQuantization}
				handleRealtimeModelChange={controller.handleRealtimeModelChange}
				isSwapping={realtimeSwapping}
				isWhisperBackend={isWhisperBackend}
				onToggle={handleRealtimeToggle}
				quality={quality}
				realtimeEnabled={realtimeEnabled}
				settings={settings}
				statesById={statesById}
				systemInfo={systemInfo}
				t={t}
				update={update}
				updateQuality={updateQuality}
			/>
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

interface DownloadConfirmationDialogProps {
	getModel: (
		id: string
	) => ReturnType<typeof useCatalogStore.getState>["getModel"] extends (id: string) => infer R
		? R
		: never;
	onCancel: () => void;
	onConfirm: () => void;
	pending: {
		kind: "main" | "realtime";
		modelId: string;
		previousModelId: string;
		quantization?: OnnxQuantization;
	} | null;
	statesById: Record<string, ReturnType<typeof useModelStateStore.getState>["statesById"][string]>;
	systemInfo: ReturnType<typeof useModelStateStore.getState>["systemInfo"];
}

function DownloadConfirmationDialog({
	pending,
	getModel,
	onConfirm,
	onCancel,
	statesById,
	systemInfo,
}: DownloadConfirmationDialogProps): ReactNode {
	return (
		<Modal isOpen={pending !== null} onClose={onCancel}>
			<DownloadConfirmationContent
				getModel={getModel}
				onCancel={onCancel}
				onConfirm={onConfirm}
				pending={pending}
				statesById={statesById}
				systemInfo={systemInfo}
			/>
		</Modal>
	);
}

function dialogTitle(phase: DownloadPhase): string {
	if (phase === "active") {
		return "Downloading model";
	}
	if (phase === "paused") {
		return "Resume download?";
	}
	return "Download model?";
}

function dialogSubtitle(
	phase: DownloadPhase,
	displayName: string,
	sizeSuffix: string,
	quantLabel: string
): ReactNode {
	if (phase === "active") {
		return (
			<>
				<span className="font-medium text-foreground">{displayName}</span>
				{sizeSuffix} is downloading at{" "}
				<span className="font-medium text-foreground">{quantLabel}</span>.
			</>
		);
	}
	if (phase === "paused") {
		return (
			<>
				<span className="font-medium text-foreground">{displayName}</span>
				{sizeSuffix} is partly downloaded at{" "}
				<span className="font-medium text-foreground">{quantLabel}</span>. Resume to finish, or
				discard to clear the partial files.
			</>
		);
	}
	return (
		<>
			<span className="font-medium text-foreground">{displayName}</span>
			{sizeSuffix} isn't downloaded yet at{" "}
			<span className="font-medium text-foreground">{quantLabel}</span>.
		</>
	);
}

const DIALOG_ACTION_LABELS = {
	download: "Download",
	stop: "Stop",
	discard: "Discard",
	resume: "Resume",
} as const;

function dismissLabel(phase: DownloadPhase): string {
	if (phase === "active") {
		return "Hide";
	}
	if (phase === "paused") {
		return "Close";
	}
	return "Cancel";
}

function resolveDownloadPhase(isDownloading: boolean, partialOnDisk: boolean): DownloadPhase {
	if (isDownloading) {
		return "active";
	}
	if (partialOnDisk) {
		return "paused";
	}
	return "idle";
}

type TargetCache = ReturnType<typeof resolveQuantCache>;
type ModelState = StatesById[string] | undefined;

interface DownloadFitness {
	availableLabel: string;
	estimatedLabel: string;
	isUncomfortable: boolean;
}

/** Hardware fitness — surface the same heuristic the picker uses, plus
 *  concrete numbers so the user can decide. We don't refuse — the user
 *  can always proceed at their own risk. */
function computeFitness(state: ModelState, systemInfo: SystemInfo): DownloadFitness {
	const hasGpu = !!systemInfo && systemInfo.gpus.length > 0;
	const isUncomfortable =
		!!state &&
		state.estimated_bytes > 0 &&
		(hasGpu ? !state.comfortable_on_gpu : !state.comfortable_on_cpu);
	const estimatedLabel =
		state && state.estimated_bytes > 0 ? sizeLabel(state.estimated_bytes) : "unknown";
	const availableLabel = hasGpu
		? `GPU VRAM: ${sizeLabel(systemInfo?.gpus[0]?.total_vram_bytes ?? 0)}`
		: `RAM: ${sizeLabel(systemInfo?.total_ram_bytes ?? 0)}`;
	return { isUncomfortable, estimatedLabel, availableLabel };
}

interface LiveDownload {
	downloadedBytes: number;
	progress: number | null;
	speedBps: number;
	totalBytes: number;
}

function ActiveProgress({ live }: { live: LiveDownload }): ReactNode {
	return (
		<DownloadProgressBar
			label={live.progress == null ? "Starting..." : `${live.progress}%`}
			percent={live.progress}
			statsLabel={formatStatsLine(live.downloadedBytes, live.totalBytes, live.speedBps)}
			variant="active"
		/>
	);
}

function PausedProgress({ targetCache }: { targetCache: TargetCache }): ReactNode {
	const pausedPercent =
		targetCache && targetCache.total_bytes > 0
			? Math.round((targetCache.progress ?? 0) * 100)
			: null;
	return (
		<DownloadProgressBar
			label={pausedPercent == null ? "Paused" : `Paused at ${pausedPercent}%`}
			percent={pausedPercent}
			statsLabel={formatStatsLine(
				targetCache?.downloaded_bytes ?? 0,
				targetCache?.total_bytes ?? 0,
				0
			)}
			variant="paused"
		/>
	);
}

function IdleInfoCard({
	infoLevel,
	targetCache,
	fitness,
}: {
	infoLevel: number;
	targetCache: TargetCache;
	fitness: DownloadFitness;
}): ReactNode {
	const pausedDownloaded = targetCache?.downloaded_bytes ?? 0;
	const pausedTotal = targetCache?.total_bytes ?? 0;
	return (
		<div
			className={`flex flex-col gap-1 rounded-md p-3 text-foreground-secondary text-xs ${surfaceClasses(infoLevel)}`}
		>
			<div>
				<span className="text-foreground">Status:</span> Not downloaded
			</div>
			<div>
				<span className="text-foreground">
					{pausedTotal > pausedDownloaded
						? `Need to download: ${sizeLabel(pausedTotal - pausedDownloaded)}`
						: "Size: unknown until headers fetched"}
				</span>
			</div>
			<div>
				<span className="text-foreground">Estimated memory:</span> {fitness.estimatedLabel} ·{" "}
				{fitness.availableLabel}
			</div>
		</div>
	);
}

function DownloadConfirmationContent({
	pending,
	getModel,
	onConfirm,
	onCancel,
	statesById,
	systemInfo,
}: DownloadConfirmationDialogProps): ReactNode {
	// Modal raised the substrate by +4; inside the modal, info cards lift +1.
	const substrate = useSurface();
	const infoLevel = Math.min(substrate + 1, 8);
	const buttonHover = Math.min(substrate + 2, 8);
	const state = pending ? statesById[pending.modelId] : undefined;
	const info = pending ? getModel(pending.modelId) : undefined;
	const targetQuant = pending?.quantization ?? "";
	const targetCache = resolveQuantCache(state, targetQuant);
	const quantLabel = targetQuant === "" ? "default precision" : targetQuant;

	// Live download state from the store — drives the progress bar and the
	// active/paused/idle branch. The store is fed by the IPC listener
	// installed in DownloadOverlay's parent; if no download is in flight,
	// `isDownloading` is false and we fall through to disk-cache state.
	const live = useDownloadStore(
		useShallow((s) => ({
			isDownloading: s.isDownloading,
			modelName: s.modelName,
			progress: s.progress,
			downloadedBytes: s.downloadedBytes,
			totalBytes: s.totalBytes,
			speedBps: s.speedBps,
			cancelDownload: s.cancelDownload,
			discardCache: s.discardCache,
		}))
	);

	const isThisDownloading = live.isDownloading && live.modelName === pending?.modelId;
	const partialOnDisk = targetCache?.state === "partial";
	const phase: DownloadPhase = resolveDownloadPhase(isThisDownloading, partialOnDisk);

	const fitness = computeFitness(state, systemInfo);
	const displayName = info?.displayName ?? pending?.modelId ?? "";
	const sizeSuffix = info?.sizeLabel ? ` (${info.sizeLabel})` : "";

	const handleStop = useCallback(() => {
		live.cancelDownload();
	}, [live]);

	const handleDiscard = useCallback(() => {
		if (!pending) {
			return;
		}
		live.discardCache(pending.modelId);
	}, [live, pending]);

	const dismissButtonClass = `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-foreground text-sm ${surfaceClasses(infoLevel)} ${surfaceHoverBg(buttonHover)}`;

	return (
		<div className="flex w-[440px] flex-col gap-3 p-4 text-foreground">
			<h2 className="font-semibold text-base">{dialogTitle(phase)}</h2>
			<p className="text-foreground-secondary text-sm">
				{dialogSubtitle(phase, displayName, sizeSuffix, quantLabel)}
			</p>
			{phase === "active" && <ActiveProgress live={live} />}
			{phase === "paused" && <PausedProgress targetCache={targetCache} />}
			{phase === "idle" && (
				<IdleInfoCard fitness={fitness} infoLevel={infoLevel} targetCache={targetCache} />
			)}
			{fitness.isUncomfortable && phase !== "active" && (
				<div className="rounded-md border border-error/40 bg-error/10 p-3 text-error text-xs">
					⚠ This model may not run comfortably on your hardware. Loading may fail or transcription
					may be slow. You can continue at your own risk.
				</div>
			)}
			<div className="mt-1 flex items-center justify-end gap-2">
				<button className={dismissButtonClass} onClick={onCancel} type="button">
					{dismissLabel(phase)}
				</button>
				<DownloadActions
					labels={DIALOG_ACTION_LABELS}
					onDiscard={handleDiscard}
					onDownload={onConfirm}
					onResume={onConfirm}
					onStop={handleStop}
					phase={phase}
				/>
			</div>
		</div>
	);
}
