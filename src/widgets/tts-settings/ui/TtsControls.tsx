import { DEFAULT_SETTINGS, SettingField } from "@/entities/setting";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import {
	SearchableSelect,
	type SelectOptionGroup,
} from "@/shared/ui/searchable-select";
import { Slider } from "@/shared/ui/slider";
import type { InlineTagsBlocker } from "../lib/inline-tags-gate";
import type { SavedVoice, SavedVoiceValue } from "../model/voice-library";
import { InlineTagsField } from "./InlineTagsField";
import { TtsPreviewButton } from "./TtsPreviewButton";
import { VoiceDesignField } from "./VoiceDesignField";
import { VoiceField, type VoiceFieldClip } from "./VoiceField";

export interface TtsControlsProps {
	activeRequestId: string | null;
	isLoading: boolean;
	isSpeaking: boolean;
	language?: string | undefined;
	languageDefault?: string | undefined;
	languageGroups?: SelectOptionGroup[] | undefined;
	languagePlaceholder?: string | undefined;
	langForVoice: (voiceId: string) => string;
	onLanguageChange?: ((next: string) => void) | undefined;
	onSpeedChange: (next: number) => void;
	onSpeedReset: () => void;
	onVoiceChange: (next: string) => void;
	previewVoice: (voiceId: string, lang: string) => void;
	previewVoiceId: string | null;
	speed: number;
	speedMax?: number | undefined;
	speedMin?: number | undefined;
	t: TranslateFn;
	voice: string;
	voiceDefault?: string | undefined;
	/** True when the selected model is a voice-design model — swaps the voice
	 *  dropdown for the "Design voice" prompt affordance. */
	voiceDesign?: boolean | undefined;
	/** Character budget for the design prompt, from the model's catalog row.
	 *  `0` = unknown → no cap is enforced and the counter is hidden. */
	voiceDesignMaxChars?: number | undefined;
	/** Persist the voice-design prompt (the overloaded `voice` field). Only used
	 *  when `voiceDesign` is true. */
	onVoiceDesignPromptChange?: ((prompt: string) => void) | undefined;
	/** The row takes a style instruction ALONGSIDE its voice (OmniVoice). Renders the
	 *  same prompt editor as an EXTRA field rather than in place of the voice control,
	 *  because these rows clone and `voice` already holds the reference-clip path. */
	voiceInstructSupported?: boolean | undefined;
	voiceInstruct?: string | undefined;
	onVoiceInstructChange?: ((instruct: string) => void) | undefined;
	/** Turn a character description into a voice-design instruct via the
	 *  configured post-processing LLM. Omitted when post-processing isn't
	 *  runnable, which hides the AI affordance entirely. */
	onGenerateVoiceDesignPrompt?:
		| ((description: string) => Promise<string>)
		| undefined;
	voiceGroups: SelectOptionGroup[];
	voicePlaceholder: string;
	/** True when the selected model clones from a reference clip — swaps the
	 *  voice dropdown for the voice card. */
	cloning?: boolean | undefined;
	/** That engine's clip + transcript wiring; only read when `cloning`. The
	 *  preview wiring is assembled here from the props this component already
	 *  carries, so the parent hands over only what is engine-specific. */
	clone?:
		| (Omit<VoiceFieldClip, "onPresetChange" | "presetVoice" | "preview"> & {
				busy: boolean;
		  })
		| undefined;
	/** Inline paralinguistic-tag wiring. Present ONLY when the selected engine
	 *  ships a tag vocabulary (Orpheus / Chatterbox Turbo today) — every other
	 *  engine renders no row at all, since there is no capability to offer. */
	inlineTags?:
		| {
				blockedBy: InlineTagsBlocker | null;
				enabled: boolean;
				onChange: (next: boolean) => void;
				tagList: string;
		  }
		| undefined;
	/** Saved-voice library wiring. Present for the two models whose voice is a
	 *  user-authored artifact worth naming (cloning clip / design prompt); absent
	 *  for preset-bank engines, where the dropdown already IS the library. */
	voiceLibrary?:
		| {
				live: SavedVoiceValue;
				onApply: (value: SavedVoiceValue) => void;
				onDiscard: (input: {
					entry: SavedVoice | null;
					paths: readonly string[];
				}) => void;
				onOverwrite: (id: string, value: SavedVoiceValue) => void;
		  }
		| undefined;
}

// Voice / speed pickers. Extracted so each focused control stays readable
// and the parent `TtsModelSection` stays composition-only. The compute
// device is shared with the main STT model (Transcription tab → `model.device`),
// so there's no per-TTS device picker here.
export function TtsControls({
	activeRequestId,
	isLoading,
	isSpeaking,
	language,
	languageDefault = DEFAULT_SETTINGS.tts.lang,
	languageGroups,
	languagePlaceholder,
	langForVoice,
	onLanguageChange,
	onSpeedChange,
	onSpeedReset,
	onVoiceChange,
	previewVoice,
	previewVoiceId,
	speed,
	speedMax = 2.0,
	speedMin = 0.5,
	t,
	voice,
	voiceDefault = DEFAULT_SETTINGS.tts.voice,
	voiceDesign = false,
	voiceDesignMaxChars = 0,
	onVoiceDesignPromptChange,
	onGenerateVoiceDesignPrompt,
	voiceInstructSupported = false,
	voiceInstruct = "",
	onVoiceInstructChange,
	voiceGroups,
	voicePlaceholder,
	cloning = false,
	clone,
	inlineTags,
	voiceLibrary,
}: TtsControlsProps) {
	const languageSelectGroups = languageGroups ?? [];
	const showLanguageSelect = Boolean(
		languageSelectGroups.length > 0 && language && onLanguageChange,
	);
	return (
		<>
			{/* ONE row for the whole voice: the library combobox names it, and the
			    always-open card under it holds the clips it was cloned from and their
			    transcript. Cloning engines therefore render NO separate voice
			    dropdown — their preset voices live inside that card, offered only
			    while no clip is overriding them. */}
			{voiceLibrary ? (
				<VoiceField
					busy={cloning && clone ? clone.busy : false}
					clip={
						cloning && clone
							? {
									...clone,
									onPresetChange: onVoiceChange,
									// The audition control the merged-away dropdown used to
									// carry: a cloning engine must still be hearable from the
									// settings row, not only through the hotkey.
									preview: {
										activeRequestId,
										isLoading,
										isSpeaking,
										langForVoice,
										onPreview: previewVoice,
										previewVoiceId,
									},
									presetVoice: voice,
								}
							: undefined
					}
					live={voiceLibrary.live}
					onApply={voiceLibrary.onApply}
					onDiscard={voiceLibrary.onDiscard}
					onOverwrite={voiceLibrary.onOverwrite}
					t={t}
				/>
			) : null}
			{cloning ? null : voiceDesign ? (
				// Voice-design models describe the voice with a prompt (stored in the
				// overloaded `voice` field) instead of picking from a bank — swap the
				// dropdown for the "Design voice" affordance.
				<VoiceDesignField
					maxChars={voiceDesignMaxChars}
					onGeneratePrompt={onGenerateVoiceDesignPrompt}
					onPromptChange={
						onVoiceDesignPromptChange ??
						(() => {
							/* no-op */
						})
					}
					prompt={voice}
					t={t}
				/>
			) : (
				<SettingField
					isDefault={voice === voiceDefault}
					label={t("voice")}
					layout="row"
					onReset={() => onVoiceChange(voiceDefault)}
					tooltip={voicePlaceholder}
				>
					<SearchableSelect
						className="w-52"
						groups={voiceGroups}
						inputTrailing={
							<TtsPreviewButton
								activeRequestId={activeRequestId}
								compact={true}
								isLoading={isLoading}
								isSpeaking={isSpeaking}
								langForVoice={langForVoice}
								previewVoice={previewVoice}
								previewVoiceId={previewVoiceId}
								t={t}
								targetVoiceId={voice}
							/>
						}
						onChange={onVoiceChange}
						placeholder={t("noVoicesYet")}
						renderItemTrailing={(option) => (
							<TtsPreviewButton
								activeRequestId={activeRequestId}
								compact={true}
								isLoading={isLoading}
								isSpeaking={isSpeaking}
								langForVoice={langForVoice}
								previewVoice={previewVoice}
								previewVoiceId={previewVoiceId}
								t={t}
								targetVoiceId={option.id}
							/>
						)}
						value={voice}
					/>
				</SettingField>
			)}
			{voiceInstructSupported ? (
				// EXTRA row, not a replacement: these engines clone, so the control above
				// is the clip picker and `voice` holds its path. The instruction is its
				// own setting and reuses the design-prompt editor (same LLM fill).
				<VoiceDesignField
					keyPrefix="voiceInstruct"
					maxChars={voiceDesignMaxChars}
					onGeneratePrompt={onGenerateVoiceDesignPrompt}
					onPromptChange={
						onVoiceInstructChange ??
						(() => {
							/* no-op */
						})
					}
					prompt={voiceInstruct}
					t={t}
				/>
			) : null}
			{showLanguageSelect ? (
				<SettingField
					isDefault={language === languageDefault}
					label={t("language")}
					layout="row"
					onReset={() => onLanguageChange?.(languageDefault)}
					tooltip={t("language")}
				>
					<SearchableSelect
						className="w-52"
						groups={languageSelectGroups}
						onChange={(next) => onLanguageChange?.(next)}
						placeholder={languagePlaceholder ?? t("language")}
						value={language ?? languageDefault}
					/>
				</SettingField>
			) : null}
			<SettingField
				isDefault={speed === DEFAULT_SETTINGS.tts.speed}
				label={t("speed")}
				onReset={onSpeedReset}
				tooltip={t("speedCaption")}
			>
				<Slider
					aria-label={t("speed")}
					formatValue={(v) => `${v.toFixed(1)}×`}
					max={speedMax}
					min={speedMin}
					onChange={onSpeedChange}
					step={0.1}
					value={speed}
				/>
			</SettingField>
			{/* Last row of the tab: unlike everything above it this one is about the
			    TEXT rather than the voice — it rewrites what gets synthesized. */}
			{inlineTags ? (
				<InlineTagsField
					blockedBy={inlineTags.blockedBy}
					enabled={inlineTags.enabled}
					onChange={inlineTags.onChange}
					t={t}
					tagList={inlineTags.tagList}
				/>
			) : null}
		</>
	);
}
