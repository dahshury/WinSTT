"use client";

import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import { useCatalogStore } from "@/entities/model-catalog";
import { SettingSection } from "@/entities/setting";
import { useConnectionStore } from "@/features/connect-server";
import { useSettingsStore } from "@/features/update-settings";

import { COMPUTE_TYPES, LANGUAGES, WHISPER_MODELS } from "@/shared/config/defaults";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Select } from "@/shared/ui/select";

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

const FAMILY_LABELS: Record<string, string> = {
	whisper: "Whisper",
	nemo: "NeMo",
	gigaam: "GigaAM",
	kaldi: "Kaldi",
	"t-one": "T-One",
};

function buildModelOpts(models: ModelInfo[]): SelectOption[] {
	const grouped = new Map<string, ModelInfo[]>();
	for (const m of models) {
		const list = grouped.get(m.family) ?? [];
		list.push(m);
		grouped.set(m.family, list);
	}
	const opts: SelectOption[] = [];
	for (const [family, items] of grouped) {
		const familyLabel = FAMILY_LABELS[family] ?? family;
		for (const m of items) {
			opts.push({
				id: m.id,
				label: `[${familyLabel}] ${m.displayName} (${m.sizeLabel})`,
			});
		}
	}
	return opts;
}

function buildRealtimeOpts(models: ModelInfo[]): SelectOption[] {
	return buildModelOpts(models.filter((m) => m.supportsRealtime));
}

export function ModelSettingsPanel() {
	const settings = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo?.available ?? true;
	const deviceOpts = gpuAvailable ? ALL_DEVICE_OPTS : CPU_ONLY_OPTS;
	const deviceValue = gpuAvailable ? (settings?.device ?? "auto") : "cpu";
	const t = useTranslations("model");
	const tc = useTranslations("common");

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

			<SettingSection title={t("realtimeModelSection")}>
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
			<SettingSection title={t("llm")}>
				<div className="flex items-center justify-center py-8">
					<p className="font-mono text-foreground-muted text-sm">{tc("comingSoon")}</p>
				</div>
			</SettingSection>
		</div>
	);
}
