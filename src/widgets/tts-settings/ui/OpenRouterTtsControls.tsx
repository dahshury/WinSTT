import { useEffect } from "react";
import type { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	useSettingsStore,
} from "@/entities/setting";
import type { OpenRouterTtsModel } from "@/shared/api/models";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import {
	SearchableSelect,
	type SelectOptionGroup,
} from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { useOpenRouterTtsCatalogStore } from "../model/openrouter-tts-catalog-store";
import { TtsPreviewButton } from "./TtsPreviewButton";

export interface OpenRouterTtsControlsProps {
	activeRequestId: string | null;
	isLoading: boolean;
	isSpeaking: boolean;
	previewVoice: (modelId: string, voiceId: string) => void;
	previewVoiceId: string | null;
	t: ReturnType<typeof useTranslations>;
}

const CLOUD_DEFAULTS = DEFAULT_SETTINGS.tts.cloud;

const VOICE_GROUP_LABELS: Record<string, string> = {
	af: "American female",
	am: "American male",
	bf: "British female",
	bm: "British male",
	en: "English",
	gb: "British English",
	fr: "French",
	es: "Spanish",
	de: "German",
};

function pct(value: number): string {
	return `${Math.round(value * 100)}`;
}

function modelLabel(model: OpenRouterTtsModel): string {
	return `${model.name} - Q${pct(model.quality_score)} / S${pct(model.speed_score)}`;
}

function titleCase(value: string): string {
	return value
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
}

function voiceBase(voiceId: string): string {
	return voiceId.split(":")[0] ?? voiceId;
}

function voiceLabel(voiceId: string): string {
	const base = voiceBase(voiceId);
	const locale = /^([a-z]{2})-([A-Z]{2})-(.+)$/.exec(base);
	if (locale) {
		return `${titleCase(locale[3] ?? "")} (${locale[1]}-${locale[2]})`;
	}
	const underscored = /^([a-z]{2})_(.+)$/.exec(base);
	if (underscored) {
		return `${titleCase(underscored[2] ?? "")} (${underscored[1]?.toUpperCase()})`;
	}
	return titleCase(base);
}

function voiceGroupKey(voiceId: string): string {
	const base = voiceBase(voiceId);
	const locale = /^([a-z]{2})-([A-Z]{2})-/.exec(base);
	if (locale) {
		return `${locale[1]}-${locale[2]}`;
	}
	const underscored = /^([a-z]{2})_/.exec(base);
	return underscored?.[1] ?? "voices";
}

function voiceGroupLabel(groupKey: string): string {
	if (groupKey === "voices") {
		return "Voices";
	}
	return VOICE_GROUP_LABELS[groupKey] ?? groupKey.toUpperCase();
}

function voiceGroupBadge(groupKey: string): string | undefined {
	if (groupKey === "voices") {
		return undefined;
	}
	return groupKey.slice(0, 3).toUpperCase();
}

function buildVoiceGroups(voices: readonly string[]): SelectOptionGroup[] {
	const groups = new Map<string, SelectOption[]>();
	for (const voice of voices) {
		const key = voiceGroupKey(voice);
		const existing = groups.get(key) ?? [];
		existing.push({ id: voice, label: voiceLabel(voice) });
		groups.set(key, existing);
	}
	return [...groups.entries()].map(([key, options]) => {
		const badge = voiceGroupBadge(key);
		return {
			value: key,
			label: voiceGroupLabel(key),
			...(badge ? { badge } : {}),
			options,
		};
	});
}

function previewKey(modelId: string, voiceId: string): string {
	return `openrouter:${modelId}:${voiceId}`;
}

export function OpenRouterTtsControls({
	activeRequestId,
	isLoading,
	isSpeaking,
	previewVoice,
	previewVoiceId,
	t,
}: OpenRouterTtsControlsProps) {
	const cloud = useSettingsStore((s) => s.settings.tts.cloud);
	const update = useSettingsStore((s) => s.updateTtsSettings);
	const models = useOpenRouterTtsCatalogStore((s) => s.models);
	const isScanning = useOpenRouterTtsCatalogStore((s) => s.isScanning);
	const error = useOpenRouterTtsCatalogStore((s) => s.error);
	const scanModels = useOpenRouterTtsCatalogStore((s) => s.scanModels);

	useEffect(() => {
		scanModels().catch(() => undefined);
	}, [scanModels]);

	const patchCloud = (next: Partial<typeof cloud>): void => {
		update({ cloud: { ...cloud, ...next } });
	};

	const selectedModel =
		models.find((model) => model.id === cloud.openrouterModel) ?? null;
	const selectedVoices = selectedModel?.supported_voices ?? [];
	const selectedVoiceIsValid = selectedVoices.includes(cloud.openrouterVoice);
	const selectedVoice = selectedVoiceIsValid
		? cloud.openrouterVoice
		: (selectedVoices[0] ?? "");

	useEffect(() => {
		if (isScanning || models.length === 0) {
			return;
		}
		const nextModel =
			models.find((model) => model.id === cloud.openrouterModel) ?? models[0];
		if (!nextModel) {
			return;
		}
		const voices = nextModel.supported_voices;
		const nextVoice = voices.includes(cloud.openrouterVoice)
			? cloud.openrouterVoice
			: (voices[0] ?? "");
		const patch: Partial<typeof cloud> = {};
		if (cloud.openrouterModel !== nextModel.id) {
			patch.openrouterModel = nextModel.id;
		}
		if (cloud.openrouterVoice !== nextVoice) {
			patch.openrouterVoice = nextVoice;
		}
		if (Object.keys(patch).length > 0) {
			update({ cloud: { ...cloud, ...patch } });
		}
	}, [cloud, isScanning, models, update]);

	const modelGroups: SelectOptionGroup[] = [
		{
			value: "openrouter",
			label: "OpenRouter",
			badge: "OR",
			options: models.map((model) => ({
				id: model.id,
				label: modelLabel(model),
			})),
		},
	];

	const voiceGroups = buildVoiceGroups(selectedVoices);
	const hasModels = models.length > 0;
	const hasVoices = selectedVoices.length > 0;

	let modelPlaceholder = "Choose an OpenRouter speech model";
	if (error) {
		modelPlaceholder = "Could not load models";
	} else if (isScanning) {
		modelPlaceholder = "Loading models...";
	}

	let voicePlaceholder = "Choose a voice";
	if (!selectedModel) {
		voicePlaceholder = "Choose a speech model first";
	} else if (!hasVoices) {
		voicePlaceholder = "No voices published for this model";
	}

	const handleModelChange = (modelId: string): void => {
		const nextModel = models.find((model) => model.id === modelId);
		patchCloud({
			openrouterModel: modelId,
			openrouterVoice: nextModel?.supported_voices[0] ?? "",
		});
	};

	const handleVoiceChange = (voiceId: string): void => {
		patchCloud({ openrouterVoice: voiceId });
	};

	const previewSelectedVoice = (model: OpenRouterTtsModel, voiceId: string) => {
		previewVoice(model.id, voiceId);
	};

	return (
		<>
			<SettingField
				label={t("model")}
				layout="row"
				tooltip="OpenRouter speech model. Quality and speed scores are normalized to the same 0-100 scale as the local TTS catalog."
			>
				<ElevatedSurface className="w-72" inline>
					<SearchableSelect
						disabled={!hasModels}
						groups={modelGroups}
						onChange={handleModelChange}
						placeholder={modelPlaceholder}
						value={hasModels ? cloud.openrouterModel : ""}
					/>
				</ElevatedSurface>
			</SettingField>

			<SettingField
				label={t("voice")}
				layout="row"
				tooltip="Voices are loaded from OpenRouter's model catalog for the selected speech model."
			>
				<ElevatedSurface className="w-72" inline>
					<SearchableSelect
						disabled={!selectedModel || !hasVoices}
						groups={voiceGroups}
						inputTrailing={
							selectedModel && selectedVoice ? (
								<TtsPreviewButton
									activeRequestId={activeRequestId}
									compact={true}
									isLoading={isLoading}
									isSpeaking={isSpeaking}
									langForVoice={() => ""}
									previewVoice={() =>
										previewSelectedVoice(selectedModel, selectedVoice)
									}
									previewVoiceId={previewVoiceId}
									t={t}
									targetVoiceId={previewKey(selectedModel.id, selectedVoice)}
								/>
							) : null
						}
						onChange={handleVoiceChange}
						placeholder={voicePlaceholder}
						renderItemTrailing={(option) =>
							selectedModel ? (
								<TtsPreviewButton
									activeRequestId={activeRequestId}
									compact={true}
									isLoading={isLoading}
									isSpeaking={isSpeaking}
									langForVoice={() => ""}
									previewVoice={() =>
										previewSelectedVoice(selectedModel, option.id)
									}
									previewVoiceId={previewVoiceId}
									t={t}
									targetVoiceId={previewKey(selectedModel.id, option.id)}
								/>
							) : null
						}
						value={hasVoices ? selectedVoice : ""}
					/>
				</ElevatedSurface>
			</SettingField>

			<SettingField
				isDefault={cloud.speed === CLOUD_DEFAULTS.speed}
				label={t("speed")}
				onReset={() => patchCloud({ speed: CLOUD_DEFAULTS.speed })}
				tooltip={t("cloudSpeedCaption")}
			>
				<ElevatedSurface inline>
					<Slider
						aria-label={t("speed")}
						formatValue={(v) => `${v.toFixed(2)}x`}
						max={1.2}
						min={0.7}
						onChange={(v) => patchCloud({ speed: v })}
						step={0.05}
						value={cloud.speed}
					/>
				</ElevatedSurface>
			</SettingField>
		</>
	);
}
