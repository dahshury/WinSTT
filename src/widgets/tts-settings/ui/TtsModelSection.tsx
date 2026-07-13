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
		isVoiceDesignModel,
		needsRefText,
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
			// voice model warms into / drains out of memory — the dimmed body +
			// locked toggle ARE the pending signal (no spinner); both release
			// only when the backend confirms the transition finished.
			toggleDisabled={installing || unloadingLocalModel}
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
								onVoiceDesignPromptChange={handleVoiceDesignPromptChange}
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
								voiceDesign={isVoiceDesignModel}
								voiceGroups={voiceGroups}
								voicePlaceholder={voicePlaceholder}
							/>
							{needsRefText &&
							voice !== "" &&
							voice !== "female" &&
							voice !== "male" ? (
								<div className="flex flex-col gap-1.5">
									<label
										className="text-xs font-medium text-foreground-muted"
										htmlFor="tts-clone-ref-text"
									>
										{t("cloneRefLabel")}
									</label>
									<textarea
										className="min-h-[4.5rem] w-full resize-y rounded-md border border-border bg-surface-1 px-2.5 py-2 text-sm text-foreground outline-none focus:border-accent"
										disabled={cloneBusy}
										id="tts-clone-ref-text"
										onChange={(e) => handleCloneRefTextChange(e.target.value)}
										placeholder={
											cloneBusy
												? t("cloneRefTranscribing")
												: t("cloneRefPlaceholder")
										}
										value={cloneRefText}
									/>
									{cloneError ? (
										<span className="text-xs text-danger">{cloneError}</span>
									) : (
										<span className="text-xs text-foreground-muted">
											{t("cloneRefHint")}
										</span>
									)}
								</div>
							) : null}
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
