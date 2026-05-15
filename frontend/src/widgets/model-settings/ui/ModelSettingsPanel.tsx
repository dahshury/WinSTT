"use client";

import { AiChat02Icon, AiMagicIcon, AiSettingIcon, CpuIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnectionStore } from "@/entities/connection";
import {
	buildModelOpts,
	buildRealtimeOpts,
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { onModelSwapFailed, sttReloadModel } from "@/shared/api/ipc-client";
import { COMPUTE_TYPES, LANGUAGES, WHISPER_MODELS } from "@/shared/config/defaults";
import { FormControl } from "@/shared/ui/form-control";
import { Modal } from "@/shared/ui/modal";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Select } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

function formatBytes(bytes: number): string {
	if (bytes <= 0) {
		return "unknown";
	}
	const gb = bytes / (1024 * 1024 * 1024);
	if (gb >= 1) {
		return `${gb.toFixed(1)} GB`;
	}
	const mb = bytes / (1024 * 1024);
	return `${mb.toFixed(0)} MB`;
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

interface MainModelSectionProps {
	computeOpts: SelectOption[];
	deviceOpts: SwitcherOption<DeviceValue>[];
	deviceValue: DeviceValue;
	gpuAvailable: boolean;
	handleModelChange: (v: string) => void;
	isWhisperBackend: boolean;
	langOpts: SelectOption[];
	modelOpts: SelectOption[];
	selectedModel: string;
	settings: ModelSettings | undefined;
	t: TFn;
	update: UpdateModelFn;
}

function MainModelSection({
	t,
	settings,
	update,
	modelOpts,
	langOpts,
	computeOpts,
	deviceOpts,
	deviceValue,
	gpuAvailable,
	isWhisperBackend,
	selectedModel,
	handleModelChange,
}: MainModelSectionProps): ReactNode {
	return (
		<SettingSection icon={AiChat02Icon} title={t("mainModel")}>
			<div className="grid grid-cols-2 gap-x-5 gap-y-5 py-2">
				<FormControl caption={t("modelCaption")} label={t("model")} tooltip={t("modelTooltip")}>
					<SearchableSelect
						onChange={handleModelChange}
						options={modelOpts}
						value={selectedModel}
					/>
				</FormControl>
				<FormControl caption={t("languageCaption")} label={t("language")}>
					<SearchableSelect
						onChange={(v) => update({ language: v })}
						options={langOpts}
						value={settings?.language ?? "en"}
					/>
				</FormControl>
				{isWhisperBackend && (
					<FormControl
						caption={t("computeTypeCaption")}
						label={t("computeType")}
						tooltip={t("computeTypeTooltip")}
					>
						<Select
							onChange={(v) => update({ computeType: v as (typeof COMPUTE_TYPES)[number] })}
							options={computeOpts}
							value={settings?.computeType ?? "default"}
						/>
					</FormControl>
				)}
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
	handleRealtimeModelChange: (v: string) => void;
	isWhisperBackend: boolean;
	onToggle: (v: boolean) => void;
	quality: QualitySettings | undefined;
	realtimeEnabled: boolean;
	realtimeOpts: SelectOption[];
	settings: ModelSettings | undefined;
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
	realtimeOpts,
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
				<FormControl
					caption={t("realtimeModelCaption")}
					disabled={useMainModel}
					label={t("realtimeModel")}
					tooltip={t("realtimeModelTooltip")}
				>
					<SearchableSelect
						onChange={handleRealtimeModelChange}
						options={realtimeOpts}
						value={settings?.realtimeModel ?? "tiny"}
					/>
				</FormControl>
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

function toOpts(items: readonly string[]): SelectOption[] {
	return items.map((v) => ({ id: v, label: v }));
}

const FALLBACK_MODEL_OPTS = toOpts(WHISPER_MODELS);

function buildComputeOpts(t: TFn): SelectOption[] {
	const labels: Record<string, string> = {
		default: t("computeDefaultLabel"),
		auto: t("computeAutoLabel"),
		int8: "int8",
		int8_float16: "int8_float16",
		int8_float32: "int8_float32",
		int8_bfloat16: "int8_bfloat16",
		int16: "int16",
		float16: "float16",
		float32: "float32",
		bfloat16: "bfloat16",
	};
	return COMPUTE_TYPES.map((v) => ({ id: v, label: labels[v] ?? v }));
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
	const computeOpts = useMemo(() => buildComputeOpts(t), [t]);
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

	const modelOpts = useMemo(
		() =>
			catalogLoaded && catalogModels.length > 0
				? buildModelOpts(catalogModels, { statesById, systemInfo })
				: FALLBACK_MODEL_OPTS,
		[catalogLoaded, catalogModels, statesById, systemInfo]
	);

	const realtimeOpts = useMemo(
		() =>
			catalogLoaded && catalogModels.length > 0
				? buildRealtimeOpts(catalogModels, { statesById, systemInfo })
				: FALLBACK_MODEL_OPTS,
		[catalogLoaded, catalogModels, statesById, systemInfo]
	);

	const selectedModel = settings?.model ?? "large-v2";
	const selectedInfo = getModel(selectedModel);
	const isWhisperBackend = !selectedInfo || selectedInfo.backend === "faster_whisper";

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
	}
	const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);

	const issueSwap = useCallback(
		(kind: "main" | "realtime", value: string, previous: string) => {
			if (kind === "main") {
				const info = getModel(value);
				prevMainModelRef.current = previous;
				if (info) {
					update({ model: value, backend: info.backend });
				} else {
					update({ model: value });
				}
			} else {
				prevRealtimeModelRef.current = previous;
				update({ realtimeModel: value });
			}
			sttReloadModel(kind, value);
		},
		[update, getModel]
	);

	const handleModelChange = useCallback(
		(v: string) => {
			const currentModel = settings?.model ?? selectedModel;
			if (v === currentModel) {
				return;
			}
			// If the model isn't already on disk, prompt before kicking off
			// the multi-GB download. Cached / partial / unknown-cache models
			// get the immediate swap path.
			const state = statesById[v];
			if (state && state.cache.state !== "cached") {
				setPendingDownload({ kind: "main", modelId: v, previousModelId: currentModel });
				return;
			}
			issueSwap("main", v, currentModel);
		},
		[issueSwap, statesById, settings?.model, selectedModel]
	);

	const handleRealtimeModelChange = useCallback(
		(v: string) => {
			const current = settings?.realtimeModel ?? "";
			if (v === current) {
				return;
			}
			const state = statesById[v];
			if (state && state.cache.state !== "cached") {
				setPendingDownload({ kind: "realtime", modelId: v, previousModelId: current });
				return;
			}
			issueSwap("realtime", v, current);
		},
		[issueSwap, statesById, settings?.realtimeModel]
	);

	const confirmPendingDownload = useCallback(() => {
		if (!pendingDownload) {
			return;
		}
		issueSwap(pendingDownload.kind, pendingDownload.modelId, pendingDownload.previousModelId);
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
				computeOpts={computeOpts}
				deviceOpts={deviceOpts}
				deviceValue={deviceValue}
				gpuAvailable={gpuAvailable}
				handleModelChange={handleModelChange}
				isWhisperBackend={isWhisperBackend}
				langOpts={langOpts}
				modelOpts={modelOpts}
				selectedModel={selectedModel}
				settings={settings}
				t={t}
				update={update}
			/>
			<RealtimeModelSection
				handleRealtimeModelChange={handleRealtimeModelChange}
				isWhisperBackend={isWhisperBackend}
				onToggle={handleRealtimeToggle}
				quality={quality}
				realtimeEnabled={realtimeEnabled}
				realtimeOpts={realtimeOpts}
				settings={settings}
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
	pending: { kind: "main" | "realtime"; modelId: string; previousModelId: string } | null;
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
	const totalBytes = state?.cache.total_bytes ?? 0;
	const downloaded = state?.cache.downloaded_bytes ?? 0;
	const remainingLabel =
		totalBytes > downloaded
			? `Need to download: ${formatBytes(totalBytes - downloaded)}`
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
		state && state.estimated_bytes > 0 ? formatBytes(state.estimated_bytes) : "unknown";
	const availableLabel = hasGpu
		? `GPU VRAM: ${formatBytes(systemInfo?.gpus[0]?.total_vram_bytes ?? 0)}`
		: `RAM: ${formatBytes(systemInfo?.total_ram_bytes ?? 0)}`;

	return (
		<Modal isOpen={isOpen} onClose={onCancel}>
			<div className="flex w-[420px] flex-col gap-3 p-4 text-foreground">
				<h2 className="font-semibold text-base">Download model?</h2>
				<p className="text-foreground-secondary text-sm">
					<span className="font-medium text-foreground">
						{info?.displayName ?? pending?.modelId}
					</span>
					{info?.sizeLabel ? ` (${info.sizeLabel})` : ""} isn't downloaded yet.
				</p>
				<div className="flex flex-col gap-1 rounded-md border border-border bg-surface-tertiary p-3 text-foreground-secondary text-xs">
					<div>
						<span className="text-foreground">Status:</span>{" "}
						{state?.cache.state === "partial"
							? `Partial download (${Math.round((state.cache.progress ?? 0) * 100)}%)`
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
