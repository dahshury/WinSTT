"use client";

import { AiChat02Icon, AiMagicIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useMemo } from "react";
import { useConnectionStore } from "@/entities/connection";
import { buildModelOpts, buildRealtimeOpts, useCatalogStore } from "@/entities/model-catalog";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { COMPUTE_TYPES, LANGUAGES, WHISPER_MODELS } from "@/shared/config/defaults";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Select } from "@/shared/ui/select";
import { Toggle } from "@/shared/ui/toggle";

export interface ModelSettingsPanelProps {
	llmSlot?: ReactNode;
}

type TFn = ReturnType<typeof useTranslations>;

type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
type ModelSettings = SettingsStoreState["settings"]["model"];
type QualitySettings = SettingsStoreState["settings"]["quality"];
type UpdateModelFn = SettingsStoreState["updateModelSettings"];
type UpdateQualityFn = SettingsStoreState["updateQualitySettings"];

interface MainModelSectionProps {
	computeOpts: SelectOption[];
	deviceOpts: SelectOption[];
	deviceValue: string;
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
					caption={t("useMainModelCaption")}
					label={t("useMainModel")}
					tooltip={t("useMainModelTooltip")}
				>
					<Toggle
						checked={quality?.useMainModelForRealtime ?? false}
						onCheckedChange={(v) => updateQuality({ useMainModelForRealtime: v })}
					/>
				</FormControl>
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
	const deviceValue = gpuAvailable ? (settings?.device ?? "auto") : "cpu";

	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);

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
				quality={quality}
				realtimeEnabled={realtimeEnabled}
				realtimeOpts={realtimeOpts}
				settings={settings}
				t={t}
				update={update}
				updateQuality={updateQuality}
			/>
			{llmSlot}
		</div>
	);
}
