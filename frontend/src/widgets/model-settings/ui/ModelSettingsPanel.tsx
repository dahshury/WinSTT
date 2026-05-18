"use client";

import { AiMagicIcon, AiSettingIcon, CpuIcon, SpeechToTextIcon } from "@hugeicons/core-free-icons";
import { isRealtimeViable, SttModelSelector } from "@picker";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelStateStore, useModelSwapStore } from "@/entities/model-catalog";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { DownloadConfirmationDialog } from "@/features/model-download";
import { type SwapController, useModelSwapController } from "@/features/swap-model";
import { LANGUAGES, type OnnxQuantization } from "@/shared/config/defaults";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

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
