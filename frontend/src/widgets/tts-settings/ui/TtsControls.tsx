import type { useTranslations } from "use-intl";
import { DEFAULT_SETTINGS, SettingResetButton } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { SearchableSelect, type SelectOptionGroup } from "@/shared/ui/searchable-select";
import { Slider } from "@/shared/ui/slider";
import { TtsPreviewButton } from "./TtsPreviewButton";

export interface TtsControlsProps {
	activeRequestId: string | null;
	isLoading: boolean;
	isSpeaking: boolean;
	langForVoice: (voiceId: string) => string;
	onSpeedChange: (next: number) => void;
	onSpeedReset: () => void;
	onVoiceChange: (next: string) => void;
	previewVoice: (voiceId: string, lang: string) => void;
	previewVoiceId: string | null;
	speed: number;
	t: ReturnType<typeof useTranslations>;
	voice: string;
	voiceGroups: SelectOptionGroup[];
	voicePlaceholder: string;
}

// Voice / speed pickers. Extracted so each focused control stays readable
// and the parent `TtsModelSection` stays composition-only. The compute
// device is shared with the main STT model (Model tab → `model.device`),
// so there's no per-TTS device picker here.
export function TtsControls({
	activeRequestId,
	isLoading,
	isSpeaking,
	langForVoice,
	onSpeedChange,
	onSpeedReset,
	onVoiceChange,
	previewVoice,
	previewVoiceId,
	speed,
	t,
	voice,
	voiceGroups,
	voicePlaceholder,
}: TtsControlsProps) {
	return (
		<>
			<FormControl label={t("voice")} layout="row" tooltip={voicePlaceholder}>
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
			</FormControl>
			<FormControl
				label={t("speed")}
				labelTrailing={
					<SettingResetButton
						isDefault={speed === DEFAULT_SETTINGS.tts.speed}
						onReset={onSpeedReset}
					/>
				}
				tooltip={t("speedCaption")}
			>
				<ElevatedSurface inline>
					<Slider
						aria-label={t("speed")}
						formatValue={(v) => `${v.toFixed(1)}×`}
						max={2.0}
						min={0.5}
						onChange={onSpeedChange}
						step={0.1}
						value={speed}
					/>
				</ElevatedSurface>
			</FormControl>
		</>
	);
}
