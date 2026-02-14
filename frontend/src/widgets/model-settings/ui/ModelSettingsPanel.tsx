"use client";

import { ArrowReloadHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { buildModelOpts, buildRealtimeOpts, useCatalogStore } from "@/entities/model-catalog";
import { SettingSection } from "@/entities/setting";
import { useConnectionStore } from "@/features/connect-server";
import { useSettingsStore } from "@/features/update-settings";
import { COMPUTE_TYPES, LANGUAGES, WHISPER_MODELS } from "@/shared/config/defaults";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { Modal } from "@/shared/ui/modal";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Select } from "@/shared/ui/select";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";

function toOpts(items: readonly string[]): SelectOption[] {
	return items.map((v) => ({ id: v, label: v }));
}

const FALLBACK_MODEL_OPTS = toOpts(WHISPER_MODELS);

const COMPUTE_LABELS: Record<string, string> = {
	default: "Default (model's native precision)",
	auto: "Auto (best for your hardware)",
	int8: "int8",
	int8_float16: "int8_float16",
	int8_float32: "int8_float32",
	int8_bfloat16: "int8_bfloat16",
	int16: "int16",
	float16: "float16",
	float32: "float32",
	bfloat16: "bfloat16",
};
const COMPUTE_OPTS: SelectOption[] = COMPUTE_TYPES.map((v) => ({
	id: v,
	label: COMPUTE_LABELS[v] ?? v,
}));
const LANG_OPTS = LANGUAGES.map((l) => ({ id: l.code, label: l.name }));
const ALL_DEVICE_OPTS: SelectOption[] = [
	{ id: "auto", label: "Auto" },
	{ id: "cpu", label: "CPU" },
];
const CPU_ONLY_OPTS: SelectOption[] = [{ id: "cpu", label: "CPU" }];

export function ModelSettingsPanel() {
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const quality = useSettingsStore((s) => s.settings.quality);
	const updateQuality = useSettingsStore((s) => s.updateQualitySettings);
	const realtimeEnabled = quality?.enableRealtimeTranscription ?? true;
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo?.available ?? true;
	const deviceOpts = gpuAvailable ? ALL_DEVICE_OPTS : CPU_ONLY_OPTS;
	const deviceValue = gpuAvailable ? (settings?.device ?? "auto") : "cpu";
	const t = useTranslations("model");
	const tc = useTranslations("common");
	const tl = useTranslations("llm");

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
	} = useLlmCatalogStore();
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

	// Check if Ollama is installed
	const checkOllama = useCallback(async () => {
		const endpoint = llm?.endpoint ?? "http://localhost:11434";
		try {
			const response = await fetch(`${endpoint}/api/tags`, {
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
		label: `${m.name} (${(m.size / 1e9).toFixed(1)} GB)`,
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
		{ value: "neutral", label: tl("presetNeutral") },
		{ value: "formal", label: tl("presetFormal") },
		{ value: "friendly", label: tl("presetFriendly") },
		{ value: "technical", label: tl("presetTechnical") },
		{ value: "casual", label: tl("presetCasual") },
		{ value: "concise", label: tl("presetConcise") },
	] as const;

	const llmEnabled = llm?.enabled ?? false;
	const llmEndpoint = llm?.endpoint ?? "http://localhost:11434";
	const llmModel = llm?.model ?? "";
	const llmPreset = llm?.preset ?? "neutral";

	return (
		<div className="flex flex-col gap-5">
			<SettingSection title={t("mainModel")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl caption={t("modelCaption")} label={t("model")} tooltip={t("modelTooltip")}>
						<SearchableSelect
							onChange={handleModelChange}
							options={modelOpts}
							value={selectedModel}
						/>
					</FormControl>
					<FormControl caption={t("languageCaption")} label={t("language")}>
						<Select
							onChange={(v) => update({ language: v })}
							options={LANG_OPTS}
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
								options={COMPUTE_OPTS}
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

			<SettingSection
				onToggle={(v) => updateQuality({ enableRealtimeTranscription: v })}
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

			<SettingSection onToggle={handleLlmToggle} title={t("llm")} toggled={llmEnabled}>
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

					<FormControl
						caption={tl("modelCaption")}
						label={tl("model")}
						tooltip={tl("modelTooltip")}
					>
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
							<Button
								aria-label={tc("refresh")}
								className="flex size-8 items-center justify-center rounded-md border border-border bg-surface-secondary font-medium text-[13px] transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
								disabled={isScanning || !llmEnabled}
								onClick={scanModels}
							>
								<HugeiconsIcon
									className={isScanning ? "animate-spin" : ""}
									icon={ArrowReloadHorizontalIcon}
									size={16}
								/>
							</Button>
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

			<Modal isOpen={showOllamaDialog} onClose={() => setShowOllamaDialog(false)}>
				<div className="flex flex-col gap-4 p-6">
					<h2 className="font-semibold text-foreground text-lg">{tl("ollamaRequired")}</h2>
					<p className="text-foreground-secondary text-sm">{tl("ollamaRequiredDescription")}</p>
					<div className="flex gap-3">
						<Button
							className="flex-1 rounded-md border border-accent bg-accent px-4 py-2 font-medium text-white transition-colors duration-150 hover:bg-accent-dim"
							onClick={() => {
								window.open("https://ollama.com", "_blank");
								setShowOllamaDialog(false);
							}}
						>
							{tl("downloadOllama")}
						</Button>
						<Button
							className="flex-1 rounded-md border border-border bg-surface-secondary px-4 py-2 font-medium transition-colors duration-150 hover:bg-surface-hover"
							onClick={() => setShowOllamaDialog(false)}
						>
							{tc("cancel")}
						</Button>
					</div>
				</div>
			</Modal>
		</div>
	);
}
