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
	resolveTtsEnabledModelPatch,
	useTtsInstallGate,
} from "../model/use-tts-install-gate";
import { useTtsPlayback } from "../model/use-tts-playback";
import { TtsModelSelector } from "@picker/tts";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { useTtsModelDownloads } from "../model/use-tts-model-downloads";
import { useTtsVoiceCatalog } from "../model/use-tts-voice-catalog";
import { CloudTtsControls } from "./CloudTtsControls";
import { OpenRouterTtsControls } from "./OpenRouterTtsControls";
import { TtsControls } from "./TtsControls";
import { TtsInstallBanner } from "./TtsInstallBanner";

export function TtsModelSection() {
	const t = useTranslations("tts");
	const tIntegrations = useTranslations("integrations");
	const tts = useSettingsStore((s) => s.settings.tts);
	const update = useSettingsStore((s) => s.updateTtsSettings);
	const integrations = useSettingsStore((s) => s.settings.integrations);
	// OpenRouter is a 2nd cloud TTS provider — reuses the shared LLM key.
	const openrouterKey = useSettingsStore((s) => s.settings.llm.openrouterApiKey);
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);

	// Cloud is only selectable once the ElevenLabs key is present AND the last
	// probe verified it. A persisted `source: "cloud"` without a verified key
	// falls back to local — same posture as the STT model source area, so a
	// removed/invalidated key can never strand TTS on an unreachable provider.
	const elevenVerified =
		integrations.elevenlabs.apiKey.trim().length > 0 &&
		integrations.elevenlabs.verified === true;
	// Probe the live voice catalog whenever the key is VERIFIED — even in local
	// mode — so we know before the user picks Cloud whether the key actually
	// grants the `voices_read` scope that cloud TTS needs. A verified key only
	// proves authentication (so dictation / cloud STT work); voice access is a
	// separate ElevenLabs permission, so that gate lives HERE, not in credential
	// verification (which intentionally accepts a working-but-scoped key).
	const cloud = useCloudTtsVoices(elevenVerified);
	// Cloud gating (allowed / no-voice-access) is derived in a module helper so
	// this component stays under the complexity budget — see `deriveCloudGate`.
	const { cloudAllowed: elevenCloudAllowed, noVoiceAccess } = deriveCloudGate(
		elevenVerified,
		cloud,
	);
	// OpenRouter cloud TTS is available whenever the shared OpenRouter key is set
	// (no separate verify — the speak call surfaces a typed error if it's bad).
	const openrouterConfigured = openrouterKey.trim().length > 0;
	// The Cloud source is selectable if EITHER cloud provider is available.
	const cloudAllowed = elevenCloudAllowed || openrouterConfigured;
	const effectiveSource =
		tts?.source === "cloud" && cloudAllowed ? "cloud" : "local";
	const isCloud = effectiveSource === "cloud";
	// Resolve the active cloud provider to one that's actually available so a
	// persisted `openrouter` choice never strands the picker when only ElevenLabs
	// is keyed (and vice-versa).
	const persistedCloudProvider = tts?.cloud?.provider ?? "elevenlabs";
	let cloudProvider: "elevenlabs" | "openrouter" = "elevenlabs";
	if (persistedCloudProvider === "openrouter" && openrouterConfigured) {
		cloudProvider = "openrouter";
	} else if (elevenCloudAllowed) {
		cloudProvider = "elevenlabs";
	} else if (openrouterConfigured) {
		cloudProvider = "openrouter";
	}
	// Only offer the provider sub-switch when BOTH cloud providers are available.
	const showCloudProviderToggle = elevenCloudAllowed && openrouterConfigured;
	const cloudProviderOpts: SwitcherOption<"elevenlabs" | "openrouter">[] = [
		{ value: "elevenlabs", label: "ElevenLabs", disabled: !elevenCloudAllowed },
		{
			value: "openrouter",
			label: "OpenRouter",
			disabled: !openrouterConfigured,
		},
	];
	const handleCloudProviderChange = (next: "elevenlabs" | "openrouter"): void => {
		update({
			cloud: { ...(tts?.cloud ?? DEFAULT_SETTINGS.tts.cloud), provider: next },
		});
	};

	// Enable gate (state + handlers live in the model hook — see
	// use-tts-install-gate). `handleLocalEnabledToggle` is the LOCAL path: it
	// enables directly when the selected model is already on disk, otherwise it
	// opens the model selector (whose commit flips `enabled` once a model lands).
	// Cloud has nothing to download (see `handleEnabledToggle`).
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

	const catalog = useTtsVoiceCatalog(enabled, model, voice, update);
	// Multi-provider TTS model picker data + per-quant download wiring.
	const ttsModels = useTtsCatalogStore((s) => s.models);
	const ttsStatesById = useTtsModelStateStore((s) => s.statesById);
	const ttsStatesLoaded = useTtsModelStateStore((s) => s.isLoaded);
	const {
		getSnapshot: getTtsDownloadSnapshot,
		onDownloadAction: onTtsDownloadAction,
	} = useTtsModelDownloads();
	const currentTtsQuant = ttsStatesById[model]?.effectiveQuantization ?? "";
	const selectedModelInfo = useTtsCatalogStore((s) => s.getModel(model));
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
	// One unified voice selector for every model: preset voices for Kokoro/Kitten/
	// Piper/Supertonic, or default-voice + clone-from-clip for cloning engines.
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

	// Speak a short sample in the given voice. Cancels any in-flight
	// playback first so rapid voice switching always previews the latest
	// pick (the renderer queue drops chunks whose request_id doesn't match
	// the active one, so an un-cancelled prior preview would otherwise
	// swallow the new one).
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

	// Cloud voice preview plays the voice's FREE pre-generated sample
	// (`previewUrl`) instead of a paid synthesis — browsing voices costs no
	// ElevenLabs credits. Falls back to a (paid) synthesis preview only for a
	// voice with no sample URL. Mirrors `previewVoice`'s cancel-then-mark so the
	// play/stop affordance behaves identically.
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
		// No free sample clip: a usable voice can fall back to a (paid) synthesis
		// preview, but a locked premium voice must NOT — that would 402.
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
		// Cloning engines: "clone from a file" opens a native picker; the chosen
		// WAV path becomes the voice (the backend clones from it). The default and
		// any previously-picked clip are plain values.
		if (nextVoice === TTS_CLONE_ADD) {
			void (async () => {
				const { open } = await import("@tauri-apps/plugin-dialog");
				const picked = await open({
					multiple: false,
					filters: [{ name: "Audio", extensions: ["wav"] }],
				});
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
		// Each voice belongs to one language — derive it so the user doesn't
		// have to keep two pickers in sync. Prefer the catalog field when
		// present; fall back to the prefix heuristic for offline mode.
		const meta = catalog.voices.find((v) => v.id === nextVoice);
		const nextLang = meta?.language ?? deriveLanguage(nextVoice);
		update({ voice: nextVoice, lang: nextLang });
		// Picking a voice in the dropdown immediately previews it — the
		// preview lives in the selector itself, not a separate button.
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

	// While the on-demand install is downloading OR sitting paused, every
	// settings control below the section header is locked. Two reasons:
	//   1. Voice / speed changes can't take effect until the
	//      engine is loaded — letting the user fiddle here pretends to
	//      change something it doesn't, then surprises them once the
	//      install finishes and the new settings retroactively apply.
	//   2. Server-side, swap_parameter on a half-initialized synthesizer
	//      races the warm-up executor. The pause/resume/cancel buttons
	//      in the install banner are the only legitimate interactions
	//      during this window.
	// `installPhase` covers the WHOLE install (engine → model → ready),
	// including the gaps between asset downloads (extraction, ORT session
	// init) where no progress events fire. `downloadProgress.active` is a
	// belt-and-suspenders backup for any window where bytes are streaming
	// before the next status ping arrives.
	// The install gate (and its lock) only applies to LOCAL Kokoro — cloud has
	// nothing to download. In cloud mode the controls stay live and the toggle
	// never opens a dialog.
	const installing =
		!isCloud && (installPhase !== null || downloadProgress.active);
	const handleCancelInstall = (): void => {
		ttsInstallCancel();
		// Cancel means "discard, I don't want this anymore" — flip the
		// toggle back off so the section returns to its pre-enable state
		// rather than sitting on `enabled: true` with no engine.
		update({ enabled: false });
	};

	// Cloud bypasses the confirm-before-download gate entirely — flip `enabled`
	// straight away. Local routes through the gate so the Kokoro install dialog
	// can intercept the off→on edge.
	const handleEnabledToggle = (next: boolean): void => {
		if (isCloud) {
			update({ enabled: next });
			return;
		}
		handleLocalEnabledToggle(next);
	};

	const handleSourceChange = (next: "local" | "cloud"): void => {
		update({ source: next });
	};

	// Local ⇄ Cloud segmented switch — mirrors the STT model `SourceArea`.
	// Cloud is locked (lock badge + tooltip → Integrations) for two reasons:
	//   • no verified key             → the generic "add a key" hint
	//   • verified key, no voices_read → the server's precise permission message
	//     (cloud.error), so the user learns the key works for dictation but lacks
	//     the voice scope. Both badge-clicks deep-link to Integrations.
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
				<div className="flex flex-col divide-y divide-surface-1">
					<div
						className={cn(
							"flex flex-col divide-y divide-surface-1 transition-opacity duration-200 ease-out",
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
							<>
								{showCloudProviderToggle ? (
									<SettingField
										label="Cloud provider"
										layout="row"
										tooltip="Which cloud TTS service to synthesize with: ElevenLabs or OpenRouter."
									>
										<ElevatedSurface className="w-52">
											<Switcher
												fullWidth
												onChange={handleCloudProviderChange}
												options={cloudProviderOpts}
												value={cloudProvider}
											/>
										</ElevatedSurface>
									</SettingField>
								) : null}
								{cloudProvider === "openrouter" ? (
									<OpenRouterTtsControls
										activeRequestId={playback.requestId}
										isLoading={isLoading}
										isSpeaking={isSpeaking}
										previewVoice={previewOpenRouterVoice}
										previewVoiceId={previewVoiceId}
										t={t}
									/>
								) : (
									<CloudTtsControls
										activeRequestId={playback.requestId}
										error={cloud.error}
										groups={cloud.groups}
										isLoading={isLoading}
										isLoadingVoices={cloud.isLoading}
										isSpeaking={isSpeaking}
										previewVoice={previewCloudVoice}
										previewVoiceId={previewVoiceId}
										t={t}
									/>
								)}
							</>
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
