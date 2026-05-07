"use client";

import {
	AiBrain02Icon,
	AiChat02Icon,
	AiMagicIcon,
	ArrowReloadHorizontalIcon,
	BookOpen01Icon,
	BrushIcon,
	HappyIcon,
	PencilIcon,
	Suit01Icon,
	WavingHand01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "@/entities/connection";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { buildModelOpts, buildRealtimeOpts, useCatalogStore } from "@/entities/model-catalog";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { detectOllama, fetchOllamaModels, startOllama } from "@/shared/api/ipc-client";
import { COMPUTE_TYPES, LANGUAGES, WHISPER_MODELS } from "@/shared/config/defaults";
import { buildOllamaApiUrl } from "@/shared/lib/ollama-endpoint";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { Modal } from "@/shared/ui/modal";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Select } from "@/shared/ui/select";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";
import { Tooltip } from "@/shared/ui/tooltip";

type TFn = ReturnType<typeof useTranslations>;

type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
type ModelSettings = SettingsStoreState["settings"]["model"];
type LlmSettings = SettingsStoreState["settings"]["llm"];
type UpdateModelFn = SettingsStoreState["updateModelSettings"];
type UpdateLlmFn = SettingsStoreState["updateLlmSettings"];
type LlmPreset = NonNullable<LlmSettings>["preset"];
type LlmPresetOptions = ReadonlyArray<{ value: LlmPreset; label: string }>;

interface MainModelSectionProps {
	t: TFn;
	settings: ModelSettings | undefined;
	update: UpdateModelFn;
	modelOpts: SelectOption[];
	langOpts: SelectOption[];
	computeOpts: SelectOption[];
	deviceOpts: SelectOption[];
	deviceValue: string;
	gpuAvailable: boolean;
	isWhisperBackend: boolean;
	selectedModel: string;
	handleModelChange: (v: string) => void;
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
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
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
					<Select
						onChange={(v) => update({ device: v as "auto" | "cpu" })}
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
	t: TFn;
	settings: ModelSettings | undefined;
	update: UpdateModelFn;
	realtimeOpts: SelectOption[];
	realtimeEnabled: boolean;
	onToggle: (v: boolean) => void;
	isWhisperBackend: boolean;
}

function RealtimeModelSection({
	t,
	settings,
	update,
	realtimeOpts,
	realtimeEnabled,
	onToggle,
	isWhisperBackend,
}: RealtimeModelSectionProps): ReactNode {
	return (
		<SettingSection
			icon={AiMagicIcon}
			onToggle={onToggle}
			title={t("realtimeModelSection")}
			toggled={realtimeEnabled}
		>
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption={t("realtimeModelCaption")}
					label={t("realtimeModel")}
					tooltip={t("realtimeModelTooltip")}
				>
					<SearchableSelect
						onChange={(v) => update({ realtimeModel: v })}
						options={realtimeOpts}
						value={settings?.realtimeModel ?? "tiny"}
					/>
				</FormControl>
				{isWhisperBackend && (
					<FormControl
						caption={t("realtimeBeamSizeCaption")}
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

interface LlmSectionProps {
	t: TFn;
	tc: TFn;
	tl: TFn;
	llm: LlmSettings | undefined;
	updateLlm: UpdateLlmFn;
	llmEnabled: boolean;
	llmEndpoint: string;
	llmModel: string;
	llmPreset: LlmPreset;
	llmModelOpts: Array<{ id: string; label: string }>;
	llmPresetOpts: LlmPresetOptions;
	isScanning: boolean;
	scanModels: () => void;
	handleLlmToggle: (enabled: boolean) => Promise<void>;
	handleLlmDropdownOpen: (open: boolean) => void;
	llmError: string | null | undefined;
	ollamaInstalled: boolean | null;
}

function LlmSection({
	t,
	tc,
	tl,
	updateLlm,
	llmEnabled,
	llmEndpoint,
	llmModel,
	llmPreset,
	llmModelOpts,
	llmPresetOpts,
	isScanning,
	scanModels,
	handleLlmToggle,
	handleLlmDropdownOpen,
	llmError,
	ollamaInstalled,
}: LlmSectionProps): ReactNode {
	return (
		<SettingSection
			icon={AiBrain02Icon}
			onToggle={handleLlmToggle}
			title={t("llm")}
			toggled={llmEnabled}
		>
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl
					caption={tl("endpointCaption")}
					label={tl("endpoint")}
					tooltip={tl("endpointTooltip")}
				>
					<TextField
						onChange={(e) => updateLlm({ endpoint: e.target.value })}
						placeholder="http://localhost:11434"
						value={llmEndpoint}
					/>
				</FormControl>

				<FormControl caption={tl("modelCaption")} label={tl("model")} tooltip={tl("modelTooltip")}>
					<div className="flex gap-2">
						<div className="flex-1">
							<SearchableSelect
								disabled={isScanning || !llmEnabled}
								onChange={(v) => updateLlm({ model: v })}
								onOpenChange={handleLlmDropdownOpen}
								options={llmModelOpts}
								placeholder={isScanning ? tc("scanning") : tl("selectModel")}
								value={llmModel}
							/>
						</div>
						<Tooltip content={tc("refresh")}>
							<Button
								aria-label={tc("refresh")}
								className="flex size-8 items-center justify-center rounded-md border border-border bg-surface-secondary font-medium text-body transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
								disabled={isScanning || !llmEnabled}
								onClick={scanModels}
							>
								<HugeiconsIcon
									className={isScanning ? "animate-spin" : ""}
									icon={ArrowReloadHorizontalIcon}
									size={16}
								/>
							</Button>
						</Tooltip>
					</div>
				</FormControl>

				<div className="col-span-2">
					<FormControl
						caption={tl("presetCaption")}
						label={tl("preset")}
						tooltip={tl("presetTooltip")}
					>
						<Switcher
							onChange={(v) => updateLlm({ preset: v })}
							options={llmPresetOpts}
							value={llmPreset}
						/>
					</FormControl>
				</div>

				{llmError && (
					<div className="col-span-2 rounded bg-error/10 p-3 text-error text-sm">{llmError}</div>
				)}

				{llmEnabled && ollamaInstalled === false && (
					<div className="col-span-2 rounded bg-warning/10 p-3 text-sm text-warning">
						<div className="font-medium">{tl("ollamaNotAvailable")}</div>
						<div className="mt-1">{tl("ollamaNotAvailableDescription")}</div>
					</div>
				)}
			</div>
		</SettingSection>
	);
}

interface OllamaDialogProps {
	tc: TFn;
	tl: TFn;
	isOpen: boolean;
	onClose: () => void;
	onStarted: () => void;
}

function OllamaDialog({ tc, tl, isOpen, onClose, onStarted }: OllamaDialogProps): ReactNode {
	const [installed, setInstalled] = useState<boolean | null>(null);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		setStartError(null);
		setStarting(false);
		let cancelled = false;
		(async () => {
			const result = await detectOllama();
			if (!cancelled) {
				setInstalled(result.installed);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isOpen]);

	const openDownload = () => {
		window.open("https://ollama.com", "_blank");
		onClose();
	};

	const handleStart = async () => {
		setStarting(true);
		setStartError(null);
		const result = await startOllama();
		if (!result.started) {
			setStarting(false);
			setStartError(result.error ?? tl("ollamaStartFailed"));
			return;
		}
		// Give Ollama a moment to bind the port before parents re-scan.
		setTimeout(() => {
			setStarting(false);
			onStarted();
		}, 1500);
	};

	const showRun = installed === true;
	const title = showRun ? tl("ollamaNotRunning") : tl("ollamaRequired");
	const description = showRun ? tl("ollamaNotRunningDescription") : tl("ollamaRequiredDescription");

	return (
		<Modal isOpen={isOpen} onClose={onClose}>
			<div className="flex flex-col gap-4 p-6">
				<h2 className="font-semibold text-foreground text-lg">{title}</h2>
				<p className="text-foreground-secondary text-sm">{description}</p>
				{startError && (
					<div className="rounded bg-error/10 p-2 text-error text-xs">{startError}</div>
				)}
				<div className="flex gap-3">
					{showRun ? (
						<Button
							className="flex-1 rounded-md border border-accent bg-accent px-4 py-2 font-medium text-white transition-colors duration-150 hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-60"
							disabled={starting}
							onClick={handleStart}
						>
							{starting ? tl("starting") : tl("runOllama")}
						</Button>
					) : (
						<Button
							className="flex-1 rounded-md border border-accent bg-accent px-4 py-2 font-medium text-white transition-colors duration-150 hover:bg-accent-dim"
							onClick={openDownload}
						>
							{tl("downloadOllama")}
						</Button>
					)}
					<Button
						className="flex-1 rounded-md border border-border bg-surface-secondary px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover"
						disabled={starting}
						onClick={onClose}
					>
						{tc("cancel")}
					</Button>
				</div>
			</div>
		</Modal>
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
function buildDeviceOpts(t: TFn, gpuAvailable: boolean): SelectOption[] {
	const cpu = { id: "cpu", label: t("deviceCpuLabel") };
	if (!gpuAvailable) {
		return [cpu];
	}
	return [{ id: "auto", label: t("deviceAutoLabel") }, cpu];
}

export function ModelSettingsPanel() {
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
	const realtimeEnabled = quality?.enableRealtimeTranscription ?? true;
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo?.available ?? true;
	const t = useTranslations("model");
	const tc = useTranslations("common");
	const tl = useTranslations("llm");
	const deviceOpts = useMemo(() => buildDeviceOpts(t, gpuAvailable), [t, gpuAvailable]);
	const computeOpts = useMemo(() => buildComputeOpts(t), [t]);
	const deviceValue = gpuAvailable ? (settings?.device ?? "auto") : "cpu";

	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);

	// LLM state
	const llm = useSettingsStore((s) => s.settings.llm);
	const updateLlm = useSettingsStore((s) => s.updateLlmSettings);
	const {
		models: llmModels,
		isLoaded: llmLoaded,
		isScanning,
		error: llmError,
		scanModels,
	} = useLlmCatalogStore(
		useShallow((s) => ({
			models: s.models,
			isLoaded: s.isLoaded,
			isScanning: s.isScanning,
			error: s.error,
			scanModels: s.scanModels,
		}))
	);
	const [showOllamaDialog, setShowOllamaDialog] = useState(false);
	const [ollamaInstalled, setOllamaInstalled] = useState<boolean | null>(null);

	const modelOpts = useMemo(
		() =>
			catalogLoaded && catalogModels.length > 0
				? buildModelOpts(catalogModels)
				: FALLBACK_MODEL_OPTS,
		[catalogLoaded, catalogModels]
	);

	const realtimeOpts = useMemo(
		() =>
			catalogLoaded && catalogModels.length > 0
				? buildRealtimeOpts(catalogModels)
				: FALLBACK_MODEL_OPTS,
		[catalogLoaded, catalogModels]
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

	const handleModelChange = useCallback(
		(v: string) => {
			const info = getModel(v);
			if (info) {
				update({ model: v, backend: info.backend });
			} else {
				update({ model: v });
			}
		},
		[update, getModel]
	);

	// Check if Ollama is reachable
	const checkOllama = useCallback(async () => {
		const endpoint = llm?.endpoint ?? "http://localhost:11434";

		// In Electron, probe Ollama through IPC to avoid renderer CORS limitations.
		if (window.electronAPI != null) {
			const result = await fetchOllamaModels();
			setOllamaInstalled(result.reachable);
			return result.reachable;
		}

		try {
			const response = await fetch(buildOllamaApiUrl(endpoint, "/api/tags"), {
				method: "GET",
				signal: AbortSignal.timeout(2000),
			});
			setOllamaInstalled(response.ok);
			return response.ok;
		} catch {
			setOllamaInstalled(false);
			return false;
		}
	}, [llm?.endpoint]);

	// Check Ollama on mount and when loading LLM models
	useEffect(() => {
		if (!llmLoaded) {
			checkOllama();
		}
	}, [llmLoaded, checkOllama]);

	// Check Ollama status when the component mounts if LLM is already enabled
	useEffect(() => {
		if (llm?.enabled) {
			checkOllama();
		}
	}, [llm?.enabled, checkOllama]);

	// After a scan, ensure llm.model points at an available model:
	// - keep the previous selection if it's still installed,
	// - otherwise fall back to the first model returned.
	useEffect(() => {
		if (llmModels.length === 0) {
			return;
		}
		const current = llm?.model ?? "";
		const stillInstalled = current && llmModels.some((m) => m.name === current);
		if (stillInstalled) {
			return;
		}
		const first = llmModels[0]?.name;
		if (first && first !== current) {
			updateLlm({ model: first });
		}
	}, [llmModels, llm?.model, updateLlm]);

	// Handle LLM toggle
	const handleLlmToggle = useCallback(
		async (enabled: boolean) => {
			if (enabled) {
				const installed = await checkOllama();
				if (!installed) {
					setShowOllamaDialog(true);
					return;
				}
				// Scan models when enabling
				if (!llmLoaded) {
					scanModels();
				}
			}
			updateLlm({ enabled });
		},
		[checkOllama, llmLoaded, scanModels, updateLlm]
	);

	const llmModelOpts = llmModels.map((m) => ({
		id: m.name,
		label: `${m.name} (${((m.size ?? 0) / 1e9).toFixed(1)} GB)`,
	}));

	// Handle dropdown open to auto-refresh models
	const handleLlmDropdownOpen = useCallback(
		(open: boolean) => {
			if (open && !isScanning) {
				scanModels();
			}
		},
		[isScanning, scanModels]
	);

	const llmPresetOpts = [
		{ value: "neutral", label: tl("presetNeutral"), icon: PencilIcon },
		{ value: "formal", label: tl("presetFormal"), icon: Suit01Icon },
		{ value: "friendly", label: tl("presetFriendly"), icon: WavingHand01Icon },
		{ value: "technical", label: tl("presetTechnical"), icon: BookOpen01Icon },
		{ value: "casual", label: tl("presetCasual"), icon: HappyIcon },
		{ value: "concise", label: tl("presetConcise"), icon: BrushIcon },
	] as const;

	const llmEnabled = llm?.enabled ?? false;
	const llmEndpoint = llm?.endpoint ?? "http://localhost:11434";
	const llmModel = llm?.model ?? "";
	const llmPreset = llm?.preset ?? "neutral";

	const closeOllamaDialog = useCallback(() => setShowOllamaDialog(false), []);
	const handleOllamaStarted = useCallback(() => {
		setShowOllamaDialog(false);
		// Re-scan to populate models and clear the unreachable error.
		scanModels();
		// Now that Ollama is running, finally enable the LLM setting.
		updateLlm({ enabled: true });
	}, [scanModels, updateLlm]);
	const handleRealtimeToggle = useCallback(
		(v: boolean) => updateQuality({ enableRealtimeTranscription: v }),
		[updateQuality]
	);

	return (
		<div className="flex flex-col gap-5">
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
				isWhisperBackend={isWhisperBackend}
				onToggle={handleRealtimeToggle}
				realtimeEnabled={realtimeEnabled}
				realtimeOpts={realtimeOpts}
				settings={settings}
				t={t}
				update={update}
			/>
			<LlmSection
				handleLlmDropdownOpen={handleLlmDropdownOpen}
				handleLlmToggle={handleLlmToggle}
				isScanning={isScanning}
				llm={llm}
				llmEnabled={llmEnabled}
				llmEndpoint={llmEndpoint}
				llmError={llmError}
				llmModel={llmModel}
				llmModelOpts={llmModelOpts}
				llmPreset={llmPreset}
				llmPresetOpts={llmPresetOpts}
				ollamaInstalled={ollamaInstalled}
				scanModels={scanModels}
				t={t}
				tc={tc}
				tl={tl}
				updateLlm={updateLlm}
			/>
			<OllamaDialog
				isOpen={showOllamaDialog}
				onClose={closeOllamaDialog}
				onStarted={handleOllamaStarted}
				tc={tc}
				tl={tl}
			/>
		</div>
	);
}
