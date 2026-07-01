import { AiVoiceGeneratorIcon } from "@hugeicons/core-free-icons";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { Switcher } from "@/shared/ui/switcher";
import { TtsModelSelector } from "@/widgets/model-picker/tts";
import { OUT_OF_CREDITS_NOTE } from "../lib/cloud-gate";
import {
	SUPERTONIC_DEFAULT_LANG,
	SUPERTONIC_DEFAULT_VOICE,
	SUPERTONIC_SPEED_MAX,
	SUPERTONIC_SPEED_MIN,
} from "../lib/voice-groups";
import { useTtsModelSection } from "../model/use-tts-model-section";
import { ttsDeleteModel } from "@/shared/api/ipc-client";
import { TtsControls } from "./TtsControls";
import { TtsInstallBanner } from "./TtsInstallBanner";
import { UnifiedCloudTtsControls } from "./UnifiedCloudTtsControls";

export function TtsModelSection() {
	const {
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
		openDetachedTtsPicker,
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
	} = useTtsModelSection();

	return (
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
						<Switcher
							className="w-52"
							fullWidth
							onChange={handleSourceChange}
							options={sourceOpts}
							value={effectiveSource}
						/>
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
									onOpenDetached={openDetachedTtsPicker}
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
								speedMax={isSupertonicModel ? SUPERTONIC_SPEED_MAX : undefined}
								speedMin={isSupertonicModel ? SUPERTONIC_SPEED_MIN : undefined}
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
	);
}
