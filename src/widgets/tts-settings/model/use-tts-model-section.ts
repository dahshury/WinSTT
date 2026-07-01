import { useEffect } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import {
	resolveTtsModelSelectionPatch,
	useTtsModelDownloads,
	useTtsModelPickerStore,
} from "@/features/tts-model-picker";
import { openModelPickerAtRect } from "@/shared/api/model-picker-window";
import {
	dialogOpenFile,
	ttsCancel,
	ttsCloudPreview,
	ttsInstallCancel,
	ttsOpenRouterPreview,
	ttsSpeak,
} from "@/shared/api/ipc-client";
import type { SwitcherOption } from "@/shared/ui/switcher";
import {
	AiCloud01Icon,
	AiComputerIcon,
	LockIcon,
} from "@hugeicons/core-free-icons";
import { cloudLockFooterText, deriveCloudGate } from "../lib/cloud-gate";
import { demoSentenceForLang, deriveLanguage } from "../lib/voice-demo-text";
import {
	buildCloningVoiceGroups,
	buildLanguageGroups,
	buildStyleVoiceGroups,
	buildVoiceGroups,
	clampSupertonicSpeed,
	resolveSupertonicLanguage,
	SUPERTONIC_MODEL_ID,
	TTS_CLONE_ADD,
} from "../lib/voice-groups";
import { useCloudTtsVoices } from "./use-cloud-tts-voices";
import { useTtsDownloadProgress } from "./use-tts-download-progress";
import {
	buildTtsEnablePatch,
	isTtsModelCached,
	pickCachedTtsModel,
	resolveTtsEnabledModelPatch,
	useTtsInstallGate,
} from "./use-tts-install-gate";
import { useTtsPlayback } from "./use-tts-playback";
import { useTtsVoiceCatalog } from "./use-tts-voice-catalog";

/**
 * Owns the full TTS-model-section state machine — source/install/preview/enable
 * derivation plus every handler — leaving `TtsModelSection.tsx` as pure JSX
 * composition (mirrors how `model-settings` splits its `use-*` hooks). The
 * return shape is intentionally flat: the JSX reads it field-by-field.
 *
 * Behavior is identical to the previous inline implementation.
 */
export function useTtsModelSection() {
	const t = useTranslations("tts");
	const tIntegrations = useTranslations("integrations");
	const tts = useSettingsStore((s) => s.settings.tts);
	const update = useSettingsStore((s) => s.updateTtsSettings);
	const integrations = useSettingsStore((s) => s.settings.integrations);
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);

	const elevenVerified =
		integrations.elevenlabs.apiKey.trim().length > 0 &&
		integrations.elevenlabs.verified === true;
	const cloud = useCloudTtsVoices(elevenVerified);
	const { cloudAllowed: elevenCloudAllowed, noVoiceAccess } = deriveCloudGate(
		elevenVerified,
		cloud,
	);
	const openrouterConfigured = openrouterKey.trim().length > 0;
	const cloudAllowed = elevenCloudAllowed || openrouterConfigured;
	const effectiveSource: "local" | "cloud" =
		tts?.source === "cloud" && cloudAllowed ? "cloud" : "local";
	const isCloud = effectiveSource === "cloud";

	const {
		installPhase,
		installError,
		handleEnabledToggle: handleLocalEnabledToggle,
		retryInstall,
	} = useTtsInstallGate();

	const enabled = tts?.enabled ?? false;
	const model = tts?.model ?? DEFAULT_SETTINGS.tts.model;
	const voice = tts?.voice ?? "af_heart";
	const lang = tts?.lang ?? DEFAULT_SETTINGS.tts.lang;
	const speed = tts?.speed ?? DEFAULT_SETTINGS.tts.speed;
	const hotkey = tts?.hotkey ?? "";

	const catalog = useTtsVoiceCatalog(enabled, model, voice, update);
	const ttsModels = useTtsCatalogStore((s) => s.models);
	const ttsStatesById = useTtsModelStateStore((s) => s.statesById);
	const ttsStatesLoaded = useTtsModelStateStore((s) => s.isLoaded);
	const {
		getSnapshot: getTtsDownloadSnapshot,
		onDownloadAction: onTtsDownloadAction,
	} = useTtsModelDownloads();
	const currentTtsQuant = ttsStatesById[model]?.effectiveQuantization ?? "";
	const selectedModelInfo = useTtsCatalogStore((s) => s.getModel(model));
	const selectedLocalModelCached = isTtsModelCached(ttsStatesById[model]);
	const cachedLocalModel = ttsStatesLoaded
		? pickCachedTtsModel(ttsModels, ttsStatesById)
		: null;
	const isCloningModel = (selectedModelInfo?.cloning ?? "none") !== "none";
	const isSupertonicModel =
		selectedModelInfo?.engine === "supertonic" || model === SUPERTONIC_MODEL_ID;
	const supertonicLanguage = isSupertonicModel
		? resolveSupertonicLanguage(lang, catalog)
		: lang;
	const effectiveSpeed = isSupertonicModel
		? clampSupertonicSpeed(speed)
		: speed;

	useEffect(() => {
		const patch = resolveTtsEnabledModelPatch({
			cloudFallbackAllowed: cloudAllowed,
			enabled,
			isCloud,
			model,
			models: ttsModels,
			statesById: ttsStatesById,
			statesLoaded: ttsStatesLoaded,
		});
		if (patch) {
			update(patch);
		}
	}, [
		cloudAllowed,
		enabled,
		isCloud,
		model,
		ttsModels,
		ttsStatesById,
		ttsStatesLoaded,
		update,
	]);

	const handleModelChange = (nextModel: string): void => {
		update(resolveTtsModelSelectionPatch(nextModel, ttsModels, speed));
	};

	const {
		playback,
		isLoading,
		isSpeaking,
		previewVoiceId,
		setPreviewVoiceId,
		errorReason,
	} = useTtsPlayback();

	const downloadProgress = useTtsDownloadProgress(installPhase);
	const voiceGroups = isCloningModel
		? buildCloningVoiceGroups(voice, t)
		: isSupertonicModel
			? buildStyleVoiceGroups(catalog)
			: buildVoiceGroups(catalog);
	const languageGroups = isSupertonicModel
		? buildLanguageGroups(catalog, t("language"))
		: undefined;

	const langForVoice = (voiceId: string): string =>
		isSupertonicModel
			? supertonicLanguage
			: (catalog.voices.find((v) => v.id === voiceId)?.language ??
				deriveLanguage(voiceId));

	const previewVoice = (nextVoiceId: string, previewLang: string): void => {
		ttsCancel();
		setPreviewVoiceId(nextVoiceId);
		ttsSpeak({
			text: demoSentenceForLang(previewLang, t("testVoiceSample")),
			voice: nextVoiceId,
			lang: previewLang,
			speed: effectiveSpeed,
		});
	};

	const previewCloudVoice = (
		nextVoiceId: string,
		previewLang: string,
	): void => {
		const previewUrl = cloud.voices.find(
			(v) => v.id === nextVoiceId,
		)?.previewUrl;
		if (previewUrl) {
			ttsCancel();
			setPreviewVoiceId(nextVoiceId);
			ttsCloudPreview({ previewUrl });
			return;
		}
		if (!cloud.lockedVoiceIds.has(nextVoiceId)) {
			previewVoice(nextVoiceId, previewLang);
		}
	};

	const previewOpenRouterVoice = (modelId: string, voiceId: string): void => {
		ttsCancel();
		setPreviewVoiceId(`openrouter:${modelId}:${voiceId}`);
		ttsOpenRouterPreview({
			model: modelId,
			voice: voiceId,
			speed: tts?.cloud?.speed ?? DEFAULT_SETTINGS.tts.cloud.speed,
		});
	};

	const handleVoiceChange = (nextVoice: string): void => {
		if (nextVoice === TTS_CLONE_ADD) {
			void (async () => {
				const picked = await dialogOpenFile([
					{ name: "Audio", extensions: ["wav"] },
				]);
				if (typeof picked === "string") {
					update({ voice: picked });
				}
			})();
			return;
		}
		if (isCloningModel) {
			update({ voice: nextVoice });
			return;
		}
		if (isSupertonicModel) {
			update({ voice: nextVoice, lang: supertonicLanguage });
			previewVoice(nextVoice, supertonicLanguage);
			return;
		}
		const meta = catalog.voices.find((v) => v.id === nextVoice);
		const nextLang = meta?.language ?? deriveLanguage(nextVoice);
		update({ voice: nextVoice, lang: nextLang });
		previewVoice(nextVoice, nextLang);
	};

	const handleLanguageChange = (nextLang: string): void => {
		update({ lang: nextLang });
	};

	const handleSpeedChange = (next: number): void => {
		update({ speed: isSupertonicModel ? clampSupertonicSpeed(next) : next });
	};

	const handleSpeedReset = (): void => {
		update({ speed: DEFAULT_SETTINGS.tts.speed });
	};

	const voicePlaceholder =
		catalog.voices.length === 0
			? t("noVoicesYet")
			: isSupertonicModel
				? "10 style voices; choose the speech language separately."
				: t("voiceCaption");

	const installing =
		!isCloud && (installPhase !== null || downloadProgress.active);

	const handleCancelInstall = (): void => {
		ttsInstallCancel();
		update({ enabled: false });
	};

	const handleEnabledToggle = (next: boolean): void => {
		if (!next) {
			if (isCloud) {
				update({ enabled: false });
				return;
			}
			handleLocalEnabledToggle(false);
			return;
		}
		if (isCloud) {
			update(buildTtsEnablePatch(hotkey, DEFAULT_SETTINGS.tts.hotkey));
			return;
		}
		if (selectedLocalModelCached || !cloudAllowed) {
			handleLocalEnabledToggle(true);
			return;
		}
		if (cachedLocalModel) {
			update({
				...buildTtsEnablePatch(hotkey, DEFAULT_SETTINGS.tts.hotkey),
				model: cachedLocalModel,
			});
			return;
		}
		if (ttsStatesLoaded) {
			update({
				...buildTtsEnablePatch(hotkey, DEFAULT_SETTINGS.tts.hotkey),
				source: "cloud",
			});
			return;
		}
		handleLocalEnabledToggle(true);
	};

	const handleSourceChange = (next: "local" | "cloud"): void => {
		if (next === "cloud" || !enabled || !cloudAllowed) {
			update({ source: next });
			return;
		}
		if (selectedLocalModelCached) {
			update({ source: "local" });
			return;
		}
		if (cachedLocalModel) {
			update({ source: "local", model: cachedLocalModel });
			return;
		}
		useTtsModelPickerStore.getState().openFor(true, "local");
	};

	const cloudLockFooter = cloudLockFooterText(
		elevenVerified,
		cloud,
		tIntegrations("cloudDisabledHint"),
	);
	const sourceOpts: SwitcherOption<"local" | "cloud">[] = [
		{
			value: "local",
			label: tIntegrations("sourceLocal"),
			icon: AiComputerIcon,
		},
		{
			value: "cloud",
			label: tIntegrations("sourceCloud"),
			icon: AiCloud01Icon,
			disabled: !cloudAllowed,
			...(cloudAllowed
				? {}
				: {
						badgeIcon: LockIcon,
						badgeTooltip: tIntegrations("sourceTooltip"),
						badgeTooltipFooter: cloudLockFooter,
						onBadgeClick: () => goToIntegrations("integrations"),
					}),
		},
	];

	return {
		t,
		tIntegrations,
		cloud,
		noVoiceAccess,
		elevenVerified,
		elevenCloudAllowed,
		openrouterConfigured,
		effectiveSource,
		isCloud,
		installError,
		retryInstall,
		enabled,
		model,
		voice,
		supertonicLanguage,
		effectiveSpeed,
		ttsModels,
		ttsStatesById,
		currentTtsQuant,
		getTtsDownloadSnapshot,
		onTtsDownloadAction,
		openDetachedTtsPicker: (rect: DOMRect) =>
			openModelPickerAtRect(rect, { pickerKind: "tts" }),
		isSupertonicModel,
		playback,
		isLoading,
		isSpeaking,
		previewVoiceId,
		errorReason,
		downloadProgress,
		voiceGroups,
		languageGroups,
		langForVoice,
		previewVoice,
		previewCloudVoice,
		previewOpenRouterVoice,
		handleModelChange,
		handleVoiceChange,
		handleLanguageChange,
		handleSpeedChange,
		handleSpeedReset,
		voicePlaceholder,
		installing,
		handleCancelInstall,
		handleEnabledToggle,
		handleSourceChange,
		sourceOpts,
	};
}
