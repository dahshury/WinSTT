import type { useTranslations } from "use-intl";
import { DEFAULT_SETTINGS, SettingResetButton } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { TtsPreviewButton } from "./TtsPreviewButton";

export type TtsDeviceValue = "auto" | "cuda" | "cpu";

export interface TtsControlsProps {
	activeRequestId: string | null;
	deviceOptions: SelectOption[];
	deviceValue: TtsDeviceValue;
	isLoading: boolean;
	isSpeaking: boolean;
	langForVoice: (voiceId: string) => string;
	onDeviceChange: (next: string) => void;
	onSpeedChange: (next: number) => void;
	onSpeedReset: () => void;
	onVoiceChange: (next: string) => void;
	previewVoice: (voiceId: string, lang: string) => void;
	previewVoiceId: string | null;
	speed: number;
	t: ReturnType<typeof useTranslations>;
	voice: string;
	voiceOptions: SelectOption[];
	voicePlaceholder: string;
}

// Voice / speed / device pickers. Extracted so each focused control stays
// readable and the parent `TtsModelSection` stays composition-only.
export function TtsControls({
	activeRequestId,
	deviceOptions,
	deviceValue,
	isLoading,
	isSpeaking,
	langForVoice,
	onDeviceChange,
	onSpeedChange,
	onSpeedReset,
	onVoiceChange,
	previewVoice,
	previewVoiceId,
	speed,
	t,
	voice,
	voiceOptions,
	voicePlaceholder,
}: TtsControlsProps) {
	return (
		<>
			<FormControl caption={voicePlaceholder} label={t("voice")}>
				<ElevatedSurface inline>
					<SearchableSelect
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
						options={voiceOptions}
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
				caption={t("speedCaption")}
				label={t("speed")}
				labelTrailing={
					<SettingResetButton
						isDefault={speed === DEFAULT_SETTINGS.tts.speed}
						onReset={onSpeedReset}
					/>
				}
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
			<FormControl caption={t("deviceCaption")} label={t("device")}>
				<ElevatedSurface inline>
					<Select
						aria-label={t("device")}
						onChange={onDeviceChange}
						options={deviceOptions}
						value={deviceValue}
					/>
				</ElevatedSurface>
			</FormControl>
		</>
	);
}
