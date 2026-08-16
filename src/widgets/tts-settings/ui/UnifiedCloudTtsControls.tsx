import { OpenRouterModelSelector } from "@/features/select-cloud-stt-model";
import { SettingField, useSettingsStore } from "@/entities/setting";
import { useEffect } from "react";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { parseModelSelection } from "@/shared/lib/openrouter-model-selection";
import type { SelectOptionGroup } from "@/shared/ui/searchable-select";
import {
	buildCloudPickerModels,
	type CloudTtsProvider,
	providerForModelId,
	resolveActiveCloudProvider,
	resolveOpenRouterTtsFallback,
} from "../lib/cloud-tts-picker";
import { useOpenRouterTtsCatalogStore } from "@/entities/openrouter-catalog";
import { CloudTtsControls } from "./CloudTtsControls";
import { OpenRouterTtsControls } from "./OpenRouterTtsControls";

// Independent UI/favorites namespace so the cloud-TTS picker's filter/sort and
// starred models stay separate from the LLM and cloud-STT OpenRouter pickers.
const CLOUD_TTS_SELECTOR_UI_STORAGE_KEY = "winstt:model-picker:cloud-tts-ui";
const CLOUD_TTS_FAVORITE_MODELS_STORAGE_KEY =
	"winstt:cloud-tts-favorite-models";
const CLOUD_TTS_FAVORITE_PROVIDERS_STORAGE_KEY =
	"winstt:cloud-tts-favorite-providers";

export interface UnifiedCloudTtsControlsProps {
	activeRequestId: string | null;
	/** ElevenLabs is keyed + verified + grants voice access. */
	elevenAvailable: boolean;
	/** ElevenLabs voice list (grouped) from `useCloudTtsVoices`. */
	elevenGroups: SelectOptionGroup[];
	/** ElevenLabs voice-fetch error, or null. */
	elevenError: string | null;
	/** True while the ElevenLabs voice list is loading. */
	elevenLoadingVoices: boolean;
	isLoading: boolean;
	isSpeaking: boolean;
	/** The shared LLM OpenRouter key is set. */
	openrouterAvailable: boolean;
	/** Play an ElevenLabs voice's free sample (or paid fallback). */
	previewElevenVoice: (voiceId: string, lang: string) => void;
	/** Synthesize a short OpenRouter preview for the model/voice. */
	previewOpenRouterVoice: (modelId: string, voiceId: string) => void;
	previewVoiceId: string | null;
	t: TranslateFn;
}

/**
 * Merged cloud-TTS controls — ONE rich model picker spanning whichever
 * providers are keyed (ElevenLabs engine models + OpenRouter speech models),
 * with the picked model implying the provider. Below the picker, the active
 * provider's voice + tuning controls render (ElevenLabs voice + stability/etc.,
 * or the OpenRouter per-model voice + speed). Replaces the old ElevenLabs↔
 * OpenRouter sub-toggle — there is no separate provider switch; you change
 * provider by picking a model from the other group.
 */
export function UnifiedCloudTtsControls({
	activeRequestId,
	elevenAvailable,
	elevenGroups,
	elevenError,
	elevenLoadingVoices,
	isLoading,
	isSpeaking,
	openrouterAvailable,
	previewElevenVoice,
	previewOpenRouterVoice,
	previewVoiceId,
	t,
}: UnifiedCloudTtsControlsProps) {
	const cloud = useSettingsStore((s) => s.settings.tts.cloud);
	const update = useSettingsStore((s) => s.updateTtsSettings);
	const openrouterModels = useOpenRouterTtsCatalogStore((s) => s.models);
	const openrouterLoaded = useOpenRouterTtsCatalogStore((s) => s.isLoaded);
	const openrouterScanning = useOpenRouterTtsCatalogStore((s) => s.isScanning);
	const openrouterError = useOpenRouterTtsCatalogStore((s) => s.error);
	const scanOpenrouterModels = useOpenRouterTtsCatalogStore(
		(s) => s.scanModels,
	);

	const persisted: CloudTtsProvider = cloud.provider ?? "elevenlabs";
	const activeProvider = resolveActiveCloudProvider(
		persisted,
		elevenAvailable,
		openrouterAvailable,
	);

	// Resolve a usable model without requiring the user to open the picker first.
	// The catalog landing drives the persistence effect below.
	useEffect(() => {
		if (openrouterAvailable && !openrouterLoaded && !openrouterScanning) {
			fireAndForget(scanOpenrouterModels(), "tts.prewarmOpenrouterModels");
		}
	}, [
		openrouterAvailable,
		openrouterLoaded,
		openrouterScanning,
		scanOpenrouterModels,
	]);

	const pickerModels = buildCloudPickerModels({
		elevenAvailable,
		openrouterAvailable,
		openrouterModels,
	});

	const openrouterSelection = resolveOpenRouterTtsFallback(
		openrouterModels,
		cloud.openrouterModel,
		cloud.openrouterVoice,
	);
	const selectedOpenrouterModel =
		openrouterSelection?.modelId ?? cloud.openrouterModel;
	const selectedModelId =
		activeProvider === "elevenlabs" ? cloud.model : selectedOpenrouterModel;

	// The picker previously displayed the first live model when the persisted id
	// was empty/stale without saving that effective choice. Rust therefore read
	// the stale id and failed at playback time. Commit the exact model + valid
	// voice that the UI is showing once the catalog is available.
	useEffect(() => {
		if (
			activeProvider !== "openrouter" ||
			!openrouterAvailable ||
			openrouterSelection === null
		) {
			return;
		}
		if (
			cloud.provider === "openrouter" &&
			cloud.openrouterModel === openrouterSelection.modelId &&
			cloud.openrouterVoice === openrouterSelection.voiceId
		) {
			return;
		}
		update({
			cloud: {
				...cloud,
				provider: "openrouter",
				openrouterModel: openrouterSelection.modelId,
				openrouterVoice: openrouterSelection.voiceId,
			},
		});
	}, [
		activeProvider,
		cloud,
		openrouterAvailable,
		openrouterSelection?.modelId,
		openrouterSelection?.voiceId,
		update,
	]);

	let modelPlaceholder = "Choose a cloud voice model";
	if (openrouterError && !elevenAvailable) {
		modelPlaceholder = "Could not load models";
	} else if (openrouterScanning && pickerModels.length === 0) {
		modelPlaceholder = "Loading models…";
	}

	const handleModelChange = (selection: string): void => {
		const { modelId } = parseModelSelection(selection);
		if (providerForModelId(modelId) === "elevenlabs") {
			update({ cloud: { ...cloud, provider: "elevenlabs", model: modelId } });
			return;
		}
		const nextModel = openrouterModels.find((m) => m.id === modelId);
		update({
			cloud: {
				...cloud,
				provider: "openrouter",
				openrouterModel: modelId,
				openrouterVoice: nextModel?.supported_voices[0] ?? "",
			},
		});
	};

	return (
		<>
			<SettingField
				label={t("model")}
				tooltip="Cloud voice model — searchable and filterable, the same picker the post-processing tab uses. Pick an ElevenLabs or OpenRouter model; the voice options below follow your choice."
			>
				<OpenRouterModelSelector
					favoriteModelsStorageKey={CLOUD_TTS_FAVORITE_MODELS_STORAGE_KEY}
					favoriteProvidersStorageKey={CLOUD_TTS_FAVORITE_PROVIDERS_STORAGE_KEY}
					isLoading={openrouterScanning && pickerModels.length === 0}
					models={pickerModels}
					onChange={handleModelChange}
					onOpen={() => {
						if (openrouterAvailable) {
							fireAndForget(scanOpenrouterModels(), "tts.scanOpenrouterModels");
						}
					}}
					placeholder={modelPlaceholder}
					popupWidthClass="w-[max(580px,var(--anchor-width))]"
					uiStorageKey={CLOUD_TTS_SELECTOR_UI_STORAGE_KEY}
					value={selectedModelId}
				/>
			</SettingField>

			{activeProvider === "elevenlabs" ? (
				<CloudTtsControls
					activeRequestId={activeRequestId}
					error={elevenError}
					groups={elevenGroups}
					isLoading={isLoading}
					isLoadingVoices={elevenLoadingVoices}
					isSpeaking={isSpeaking}
					previewVoice={previewElevenVoice}
					previewVoiceId={previewVoiceId}
					t={t}
				/>
			) : (
				<OpenRouterTtsControls
					activeRequestId={activeRequestId}
					isLoading={isLoading}
					isSpeaking={isSpeaking}
					previewVoice={previewOpenRouterVoice}
					previewVoiceId={previewVoiceId}
					t={t}
				/>
			)}
		</>
	);
}
