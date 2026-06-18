import {
	AiCloud01Icon,
	AiComputerIcon,
	AiVoiceGeneratorIcon,
	LockIcon,
} from "@hugeicons/core-free-icons";
import { useEffect } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import {
	ttsCancel,
	ttsCloudPreview,
	ttsDeleteModel,
	dialogOpenFile,
	ttsInstallCancel,
	ttsOpenRouterPreview,
	ttsSpeak,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import {
	cloudLockFooterText,
	deriveCloudGate,
	OUT_OF_CREDITS_NOTE,
} from "../lib/cloud-gate";
import { demoSentenceForLang, deriveLanguage } from "../lib/voice-demo-text";
import {
	buildCloningVoiceGroups,
	buildLanguageGroups,
	buildStyleVoiceGroups,
	buildVoiceGroups,
	clampSupertonicSpeed,
	resolveSupertonicLanguage,
	SUPERTONIC_DEFAULT_LANG,
	SUPERTONIC_DEFAULT_VOICE,
	SUPERTONIC_MODEL_ID,
	SUPERTONIC_SPEED_MAX,
	SUPERTONIC_SPEED_MIN,
	TTS_CLONE_ADD,
} from "../lib/voice-groups";
import { useCloudTtsVoices } from "../model/use-cloud-tts-voices";
import { useTtsDownloadProgress } from "../model/use-tts-download-progress";
import {
	buildTtsEnablePatch,
	isTtsModelCached,
	pickCachedTtsModel,
	resolveTtsEnabledModelPatch,
	useTtsInstallGate,
} from "../model/use-tts-install-gate";
import { useTtsPlayback } from "../model/use-tts-playback";
import { TtsModelSelector } from "@/widgets/model-picker/tts";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { useTtsModelPickerStore } from "@/features/tts-model-picker";
import { useTtsModelDownloads } from "../model/use-tts-model-downloads";
import { useTtsVoiceCatalog } from "../model/use-tts-voice-catalog";
import { TtsControls } from "./TtsControls";
import { TtsInstallBanner } from "./TtsInstallBanner";
import { UnifiedCloudTtsControls } from "./UnifiedCloudTtsControls";

function useTtsModelSectionRender() {
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
	const effectiveSource =
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
		const nextModelInfo = ttsModels.find(
			(candidate) => candidate.id === nextModel,
		);
		if (
			nextModelInfo?.engine === "supertonic" ||
			nextModel === SUPERTONIC_MODEL_ID
		) {
			update({
				model: nextModel,
				voice: SUPERTONIC_DEFAULT_VOICE,
				lang: SUPERTONIC_DEFAULT_LANG,
				speed: clampSupertonicSpeed(speed),
			});
			return;
		}
		update({ model: nextModel });
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

	return (
		<>
			<SettingSection
				description={t("description")}
				icon={AiVoiceGeneratorIcon}
				onToggle={handleEnabledToggle}
				title={t("title")}
				toggleDisabled={installing}
				toggled={enabled}
			>
				<div className="flex flex-col">
					<div
						className={cn(
							"flex flex-col transition-opacity duration-200 ease-out",
							installing && "pointer-events-none opacity-40",
						)}
					>
						<SettingField
							isDefault={effectiveSource === DEFAULT_SETTINGS.tts.source}
							label={tIntegrations("sourceLabel")}
							layout="row"
							onReset={() => handleSourceChange(DEFAULT_SETTINGS.tts.source)}
							tooltip={tIntegrations("sourceTooltip")}
						>
							<ElevatedSurface className="w-52">
								<Switcher
									fullWidth
									onChange={handleSourceChange}
									options={sourceOpts}
									value={effectiveSource}
								/>
							</ElevatedSurface>
						</SettingField>
						{noVoiceAccess ? (
							<p className="px-1 pt-2 text-2xs text-foreground-muted leading-relaxed">
								{cloud.error}
							</p>
						) : null}
						{elevenVerified && cloud.creditsExhausted ? (
							<p className="px-1 pt-2 text-2xs text-warning leading-relaxed">
								{OUT_OF_CREDITS_NOTE}
							</p>
						) : null}
						{isCloud ? (
							<UnifiedCloudTtsControls
								activeRequestId={playback.requestId}
								elevenAvailable={elevenCloudAllowed}
								elevenError={cloud.error}
								elevenGroups={cloud.groups}
								elevenLoadingVoices={cloud.isLoading}
								isLoading={isLoading}
								isSpeaking={isSpeaking}
								openrouterAvailable={openrouterConfigured}
								previewElevenVoice={previewCloudVoice}
								previewOpenRouterVoice={previewOpenRouterVoice}
								previewVoiceId={previewVoiceId}
								t={t}
							/>
						) : (
							<>
								<SettingField
									isDefault={model === DEFAULT_SETTINGS.tts.model}
									label={t("model")}
									layout="row"
									onReset={() => handleModelChange(DEFAULT_SETTINGS.tts.model)}
									tooltip={t("modelCaption")}
								>
									<TtsModelSelector
										currentQuantization={currentTtsQuant}
										models={ttsModels}
										onChange={(modelId) => handleModelChange(modelId)}
										onDeleteQuant={(modelId, quant) =>
											ttsDeleteModel(modelId, quant)
										}
										onDownloadAction={onTtsDownloadAction}
										onDownloadSnapshot={getTtsDownloadSnapshot}
										statesById={ttsStatesById}
										value={model}
									/>
								</SettingField>
								<TtsControls
									activeRequestId={playback.requestId}
									isLoading={isLoading}
									isSpeaking={isSpeaking}
									language={isSupertonicModel ? supertonicLanguage : undefined}
									languageDefault={SUPERTONIC_DEFAULT_LANG}
									languageGroups={languageGroups}
									languagePlaceholder={t("language")}
									langForVoice={langForVoice}
									onLanguageChange={
										isSupertonicModel ? handleLanguageChange : undefined
									}
									onSpeedChange={handleSpeedChange}
									onSpeedReset={handleSpeedReset}
									onVoiceChange={handleVoiceChange}
									previewVoice={previewVoice}
									previewVoiceId={previewVoiceId}
									speed={effectiveSpeed}
									speedMax={
										isSupertonicModel ? SUPERTONIC_SPEED_MAX : undefined
									}
									speedMin={
										isSupertonicModel ? SUPERTONIC_SPEED_MIN : undefined
									}
									t={t}
									voice={voice}
									voiceDefault={
										isSupertonicModel
											? SUPERTONIC_DEFAULT_VOICE
											: DEFAULT_SETTINGS.tts.voice
									}
									voiceGroups={voiceGroups}
									voicePlaceholder={voicePlaceholder}
								/>
							</>
						)}
					</div>
					{isCloud ? null : (
						<TtsInstallBanner
							downloadProgress={downloadProgress}
							errorReason={errorReason}
							installError={installError}
							onCancelInstall={handleCancelInstall}
							onRetry={retryInstall}
							t={t}
						/>
					)}
				</div>
			</SettingSection>
		</>
	);
}

export function TtsModelSection() {
	return useTtsModelSectionRender();
}
