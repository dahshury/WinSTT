"use client";

import { AiChat02Icon, AiMagicIcon, AiSettingIcon, CpuIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { onModelSwapFailed, sttReloadModel } from "@/shared/api/ipc-client";
import { LANGUAGES, type OnnxQuantization } from "@/shared/config/defaults";
import { formatBytes } from "@/shared/lib/format-bytes";
import { FormControl } from "@/shared/ui/form-control";
import { Modal } from "@/shared/ui/modal";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import {
	isRealtimeViable,
	resolveQuantCache,
	SttModelSelector,
} from "@/widgets/stt-model-selector";

/** Byte size with this widget's legacy `<= 0 → "unknown"` sentinel. */
function sizeLabel(bytes: number | null | undefined): string {
	return formatBytes(bytes) ?? "unknown";
}

export interface ModelSettingsPanelProps {
	llmSlot?: ReactNode;
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
	isWhisperBackend,
	langOpts,
	selectedModel,
	handleModelChange,
}: MainModelSectionProps): ReactNode {
	return (
		<SettingSection icon={AiChat02Icon} title={t("mainModel")}>
			<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
				<div className="col-span-2">
					<FormControl caption={t("modelCaption")} label={t("model")} tooltip={t("modelTooltip")}>
						<SttModelSelector
							currentQuantization={currentQuantization}
							isLoading={!catalogLoaded}
							models={catalogModels}
							onChange={handleModelChange}
							statesById={statesById}
							systemInfo={systemInfo}
							value={selectedModel}
						/>
					</FormControl>
				</div>
				<FormControl caption={t("languageCaption")} label={t("language")}>
					<SearchableSelect
						onChange={(v) => update({ language: v })}
						options={langOpts}
						value={settings?.language ?? "en"}
					/>
				</FormControl>
				<FormControl
					caption={gpuAvailable ? t("deviceCaptionGpu") : t("deviceCaptionNoGpu")}
					label={t("device")}
				>
					<Switcher
						onChange={(v) => update({ device: v })}
						options={deviceOpts}
						value={deviceValue}
					/>
				</FormControl>
				{isWhisperBackend && (
					<FormControl
						caption={t("beamSizeCaption")}
						label={t("beamSize")}
						tooltip={t("beamSizeTooltip")}
					>
						<NumberStepper
							max={20}
							min={1}
							onChange={(v) => update({ beamSize: v })}
							step={1}
							value={settings?.beamSize ?? 5}
						/>
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
			<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
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
					<NumberStepper
						min={0.01}
						onChange={(v) => updateQuality({ realtimeProcessingPause: v })}
						step={0.01}
						value={quality?.realtimeProcessingPause ?? 0.02}
					/>
				</FormControl>
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
							isLoading={!catalogLoaded}
							models={catalogModels}
							onChange={handleRealtimeModelChange}
							prefilter={isRealtimeViable}
							statesById={statesById}
							systemInfo={systemInfo}
							value={settings?.realtimeModel ?? "tiny"}
						/>
					</FormControl>
				</div>
				{isWhisperBackend && (
					<FormControl
						caption={t("realtimeBeamSizeCaption")}
						disabled={useMainModel}
						label={t("realtimeBeamSize")}
						tooltip={t("realtimeBeamSizeTooltip")}
					>
						<NumberStepper
							max={20}
							min={1}
							onChange={(v) => update({ beamSizeRealtime: v })}
							step={1}
							value={settings?.beamSizeRealtime ?? 3}
						/>
					</FormControl>
				)}
			</div>
		</SettingSection>
	);
}

const ALL_LANG_OPTS = LANGUAGES.map((l) => ({ id: l.code, label: l.name }));
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

export function ModelSettingsPanel({ llmSlot }: ModelSettingsPanelProps = {}) {
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
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
	useEffect(() => {
		refreshModelState();
	}, [refreshModelState]);

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

	// Track the previous model id for each picker so a server-side swap
	// failure can revert the setting back to what was actually loaded. The
	// store is the source of truth; we just need to remember what was
	// there *before* the user's selection so we can roll back.
	const prevMainModelRef = useRef<string | null>(null);
	const prevRealtimeModelRef = useRef<string | null>(null);

	// Pending-download confirmation dialog state. Holds the model id that
	// the user picked when it wasn't already cached. Cleared on confirm or
	// cancel; cancel also reverts the picker (mirror of swap-failed path).
	interface PendingDownload {
		kind: "main" | "realtime";
		modelId: string;
		previousModelId: string;
		quantization?: OnnxQuantization;
	}
	const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);

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
			// If the *target precision* isn't already on disk, prompt before
			// kicking off the download — a model can be cached at int8 but not
			// at fp16, so check the quantization the swap will actually load.
			const state = statesById[v];
			const targetQuant = quantization ?? currentQuantization;
			const targetCache = resolveQuantCache(state, targetQuant);
			if (state && targetCache?.state !== "cached") {
				setPendingDownload({
					kind: "main",
					modelId: v,
					previousModelId: currentModel,
					quantization,
				});
				return;
			}
			issueSwap("main", v, currentModel, quantization);
		},
		[issueSwap, statesById, settings?.model, selectedModel, currentQuantization, update]
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
			const state = statesById[v];
			const targetQuant = quantization ?? currentQuantization;
			const targetCache = resolveQuantCache(state, targetQuant);
			if (state && targetCache?.state !== "cached") {
				setPendingDownload({
					kind: "realtime",
					modelId: v,
					previousModelId: current,
					quantization,
				});
				return;
			}
			issueSwap("realtime", v, current, quantization);
		},
		[issueSwap, statesById, settings?.realtimeModel, currentQuantization, update]
	);

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
		setPendingDownload(null);
	}, [issueSwap, pendingDownload]);

	const cancelPendingDownload = useCallback(() => {
		setPendingDownload(null);
	}, []);

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

	const handleRealtimeToggle = useCallback(
		(v: boolean) => updateQuality({ enableRealtimeTranscription: v }),
		[updateQuality]
	);

	return (
		<div className="flex flex-col gap-2">
			<MainModelSection
				catalogLoaded={catalogLoaded}
				catalogModels={catalogModels}
				currentQuantization={currentQuantization}
				deviceOpts={deviceOpts}
				deviceValue={deviceValue}
				gpuAvailable={gpuAvailable}
				handleModelChange={handleModelChange}
				isWhisperBackend={isWhisperBackend}
				langOpts={langOpts}
				selectedModel={selectedModel}
				settings={settings}
				statesById={statesById}
				systemInfo={systemInfo}
				t={t}
				update={update}
			/>
			<RealtimeModelSection
				catalogLoaded={catalogLoaded}
				catalogModels={catalogModels}
				currentQuantization={currentQuantization}
				handleRealtimeModelChange={handleRealtimeModelChange}
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
			<DownloadConfirmationDialog
				getModel={getModel}
				onCancel={cancelPendingDownload}
				onConfirm={confirmPendingDownload}
				pending={pendingDownload}
				statesById={statesById}
				systemInfo={systemInfo}
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
	const isOpen = pending !== null;
	const state = pending ? statesById[pending.modelId] : undefined;
	const info = pending ? getModel(pending.modelId) : undefined;
	const targetQuant = pending?.quantization ?? "";
	const targetCache = resolveQuantCache(state, targetQuant);
	const quantLabel = targetQuant === "" ? "default precision" : targetQuant;
	const totalBytes = targetCache?.total_bytes ?? 0;
	const downloaded = targetCache?.downloaded_bytes ?? 0;
	const remainingLabel =
		totalBytes > downloaded
			? `Need to download: ${sizeLabel(totalBytes - downloaded)}`
			: "Size: unknown until headers fetched";

	// Hardware fitness — surface the same heuristic the picker uses, plus
	// concrete numbers so the user can decide. We don't refuse — the user
	// can always proceed at their own risk.
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

	return (
		<Modal isOpen={isOpen} onClose={onCancel}>
			<div className="flex w-[420px] flex-col gap-3 p-4 text-foreground">
				<h2 className="font-semibold text-base">Download model?</h2>
				<p className="text-foreground-secondary text-sm">
					<span className="font-medium text-foreground">
						{info?.displayName ?? pending?.modelId}
					</span>
					{info?.sizeLabel ? ` (${info.sizeLabel})` : ""} isn't downloaded yet at{" "}
					<span className="font-medium text-foreground">{quantLabel}</span>.
				</p>
				<div className="flex flex-col gap-1 rounded-md border border-border bg-surface-tertiary p-3 text-foreground-secondary text-xs">
					<div>
						<span className="text-foreground">Status:</span>{" "}
						{targetCache?.state === "partial"
							? `Partial download (${Math.round((targetCache.progress ?? 0) * 100)}%)`
							: "Not downloaded"}
					</div>
					<div>
						<span className="text-foreground">{remainingLabel}</span>
					</div>
					<div>
						<span className="text-foreground">Estimated memory:</span> {estimatedLabel} ·{" "}
						{availableLabel}
					</div>
				</div>
				{isUncomfortable && (
					<div className="rounded-md border border-error/40 bg-error/10 p-3 text-error text-xs">
						⚠ This model may not run comfortably on your hardware. Loading may fail or transcription
						may be slow. You can continue at your own risk.
					</div>
				)}
				<div className="mt-1 flex justify-end gap-2">
					<button
						className="rounded-md border border-border bg-surface-tertiary px-3 py-1.5 text-foreground text-sm hover:bg-surface-hover"
						onClick={onCancel}
						type="button"
					>
						Cancel
					</button>
					<button
						className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-foreground text-sm hover:bg-accent-hover"
						onClick={onConfirm}
						type="button"
					>
						Download
					</button>
				</div>
			</div>
		</Modal>
	);
}
