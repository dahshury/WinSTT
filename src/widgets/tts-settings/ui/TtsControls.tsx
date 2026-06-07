import type { useTranslations } from "use-intl";
import { DEFAULT_SETTINGS, SettingField } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import {
	SearchableSelect,
	type SelectOptionGroup,
} from "@/shared/ui/searchable-select";
import { Slider } from "@/shared/ui/slider";
import { TtsPreviewButton } from "./TtsPreviewButton";

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
	t: ReturnType<typeof useTranslations>;
	voice: string;
	voiceDefault?: string | undefined;
	voiceGroups: SelectOptionGroup[];
	voicePlaceholder: string;
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
	voiceGroups,
	voicePlaceholder,
}: TtsControlsProps) {
	const languageSelectGroups = languageGroups ?? [];
	const showLanguageSelect = Boolean(
		languageSelectGroups.length > 0 && language && onLanguageChange,
	);
	return (
		<>
			<SettingField
				isDefault={voice === voiceDefault}
				label={t("voice")}
				layout="row"
				onReset={() => onVoiceChange(voiceDefault)}
				tooltip={voicePlaceholder}
			>
				<ElevatedSurface className="w-52" inline>
					<SearchableSelect
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
				</ElevatedSurface>
			</SettingField>
			{showLanguageSelect ? (
				<SettingField
					isDefault={language === languageDefault}
					label={t("language")}
					layout="row"
					onReset={() => onLanguageChange?.(languageDefault)}
					tooltip={t("language")}
				>
					<ElevatedSurface className="w-52" inline>
						<SearchableSelect
							groups={languageSelectGroups}
							onChange={(next) => onLanguageChange?.(next)}
							placeholder={languagePlaceholder ?? t("language")}
							value={language ?? languageDefault}
						/>
					</ElevatedSurface>
				</SettingField>
			) : null}
			<SettingField
				isDefault={speed === DEFAULT_SETTINGS.tts.speed}
				label={t("speed")}
				onReset={onSpeedReset}
				tooltip={t("speedCaption")}
			>
				<ElevatedSurface inline>
					<Slider
						aria-label={t("speed")}
						formatValue={(v) => `${v.toFixed(1)}×`}
						max={speedMax}
						min={speedMin}
						onChange={onSpeedChange}
						step={0.1}
						value={speed}
					/>
				</ElevatedSurface>
			</SettingField>
		</>
	);
}
