import { AiVoiceGeneratorIcon } from "@hugeicons/core-free-icons";
import { SettingField, SettingSection } from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { Switcher } from "@/shared/ui/switcher";
import { TtsModelSelector } from "@/features/tts-model-picker";
import { OUT_OF_CREDITS_NOTE } from "../lib/cloud-gate";
import {
	SUPERTONIC_DEFAULT_LANG,
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
		voiceDefault,
		supertonicLanguage,
		effectiveSpeed,
		ttsModels,
		ttsStatesById,
		currentTtsQuant,
		getTtsDownloadSnapshot,
		onTtsDownloadAction,
		openDetachedTtsPicker,
		isSupertonicModel,
		isCloningModel,
		isVoiceDesignModel,
		inlineTags,
		voiceDesignMaxChars,
		maxRefClipSecs,
		referenceClip,
		clonePresetOptions,
		liveSavedVoice,
		applySavedVoice,
		overwriteSavedVoice,
		handleSetReferenceClips,
		handleBrowseReferenceClips,
		discardVoice,
		generateVoiceDesignPrompt,
		needsRefText,
		requiresReferenceClip,
		cloneRefText,
		cloneBusy,
		cloneError,
		handleCloneRefTextChange,
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
		handleVoiceDesignPromptChange,
		isVoiceInstructModel,
		voiceInstruct,
		handleVoiceInstructChange,
		handleLanguageChange,
		handleSpeedChange,
		handleSpeedReset,
		voicePlaceholder,
		installing,
		unloadingLocalModel,
		handleCancelInstall,
		handleEnabledToggle,
		handleSourceChange,
		sourceOpts,
	} = useTtsModelSection();

	return (
		<SettingSection
			boxed
			description={t("description")}
			icon={AiVoiceGeneratorIcon}
			onToggle={handleEnabledToggle}
			title={t("title")}
			// The toggle shows the user's choice immediately but LOCKS while the
			// voice model warms into / drains out of memory, wearing the shared
			// corner spinner badge (same as the post-processing toggle) for the
			// whole window; both release only when the backend confirms the
			// transition finished (or the pending state's safety bound expires).
			togglePending={installing || unloadingLocalModel}
			toggled={enabled}
		>
			<div className="flex flex-col">
				<div
					className={cn(
						"flex flex-col divide-y divide-divider transition-opacity duration-200 ease-out",
						installing && "settings-dim pointer-events-none",
					)}
				>
					{/* No reset on the source switcher: "default" is one of the two
					    visible buttons (clicking Local IS the reset), and forcing a
					    source change can swap engines or open the model picker — the
					    STT source and LLM provider switchers follow the same rule. */}
					<SettingField
						label={tIntegrations("sourceLabel")}
						layout="row"
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
							{/* No reset on the model picker: reverting to the default model
							    is a heavy engine swap (and possibly a download if it was
							    deleted) — same deliberate exclusion as the STT main/realtime
							    and LLM model pickers. */}
							<SettingField label={t("model")} tooltip={t("modelCaption")}>
								<TtsModelSelector
									currentQuantization={currentTtsQuant}
									models={ttsModels}
									onChange={(modelId, quant) =>
										handleModelChange(modelId, quant)
									}
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
								clone={{
									busy: cloneBusy,
									error: cloneError,
									maxSecs: maxRefClipSecs,
									needsRefText,
									onBrowse: handleBrowseReferenceClips,
									onRefTextChange: handleCloneRefTextChange,
									onSetClips: handleSetReferenceClips,
									presets: clonePresetOptions,
									refText: cloneRefText,
									requiresClip: requiresReferenceClip,
									trimmed: referenceClip.trimmed,
								}}
								cloning={isCloningModel}
								inlineTags={inlineTags}
								isLoading={isLoading}
								isSpeaking={isSpeaking}
								language={isSupertonicModel ? supertonicLanguage : undefined}
								languageDefault={SUPERTONIC_DEFAULT_LANG}
								languageGroups={languageGroups}
								languagePlaceholder={t("language")}
								langForVoice={langForVoice}
								onGenerateVoiceDesignPrompt={generateVoiceDesignPrompt}
								onLanguageChange={
									isSupertonicModel ? handleLanguageChange : undefined
								}
								onSpeedChange={handleSpeedChange}
								onSpeedReset={handleSpeedReset}
								onVoiceChange={handleVoiceChange}
								onVoiceDesignPromptChange={handleVoiceDesignPromptChange}
								onVoiceInstructChange={handleVoiceInstructChange}
								voiceInstruct={voiceInstruct}
								voiceInstructSupported={isVoiceInstructModel}
								previewVoice={previewVoice}
								previewVoiceId={previewVoiceId}
								speed={effectiveSpeed}
								speedMax={isSupertonicModel ? SUPERTONIC_SPEED_MAX : undefined}
								speedMin={isSupertonicModel ? SUPERTONIC_SPEED_MIN : undefined}
								t={t}
								voice={voice}
								voiceDefault={voiceDefault}
								voiceDesign={isVoiceDesignModel}
								voiceDesignMaxChars={voiceDesignMaxChars}
								voiceGroups={voiceGroups}
								voiceLibrary={
									// Only the two engines whose voice is a user-authored
									// artifact get a named library; a preset-bank model's
									// dropdown already IS its list of voices.
									isCloningModel || isVoiceDesignModel
										? {
												live: liveSavedVoice,
												onApply: applySavedVoice,
												onDiscard: discardVoice,
												onOverwrite: overwriteSavedVoice,
											}
										: undefined
								}
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
