import { PauseCircleIcon } from "@hugeicons/core-free-icons";
import { DEFAULT_SETTINGS, SettingField, SettingSection } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { NumberStepper } from "@/shared/ui/number-stepper";
import type {
	QualitySettings,
	QualityT,
	UpdateQualityFn,
} from "./recording-settings-types";

interface SentencePauseSectionProps {
	q: QualitySettings | undefined;
	t: QualityT;
	update: UpdateQualityFn;
}

export function SentencePauseSection({
	q,
	t,
	update,
}: SentencePauseSectionProps) {
	return (
		<SettingSection icon={PauseCircleIcon} title={t("sentencePauses")}>
			<div className="flex flex-col">
				<SettingField
					isDefault={
						(q?.endOfSentenceDetectionPause ??
							DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause) ===
						DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause
					}
					label={t("endOfSentencePause")}
					layout="row"
					onReset={() =>
						update({
							endOfSentenceDetectionPause:
								DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause,
						})
					}
					tooltip={t("endOfSentencePauseTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={5.0}
							min={0.1}
							onChange={(v) => update({ endOfSentenceDetectionPause: v })}
							step={0.05}
							value={
								q?.endOfSentenceDetectionPause ??
								DEFAULT_SETTINGS.quality.endOfSentenceDetectionPause
							}
						/>
					</ElevatedSurface>
				</SettingField>
				<SettingField
					isDefault={
						(q?.unknownSentenceDetectionPause ??
							DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause) ===
						DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause
					}
					label={t("unknownSentencePause")}
					layout="row"
					onReset={() =>
						update({
							unknownSentenceDetectionPause:
								DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause,
						})
					}
					tooltip={t("unknownSentencePauseTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={5.0}
							min={0.1}
							onChange={(v) => update({ unknownSentenceDetectionPause: v })}
							step={0.05}
							value={
								q?.unknownSentenceDetectionPause ??
								DEFAULT_SETTINGS.quality.unknownSentenceDetectionPause
							}
						/>
					</ElevatedSurface>
				</SettingField>
				<SettingField
					isDefault={
						(q?.midSentenceDetectionPause ??
							DEFAULT_SETTINGS.quality.midSentenceDetectionPause) ===
						DEFAULT_SETTINGS.quality.midSentenceDetectionPause
					}
					label={t("midSentencePause")}
					layout="row"
					onReset={() =>
						update({
							midSentenceDetectionPause:
								DEFAULT_SETTINGS.quality.midSentenceDetectionPause,
						})
					}
					tooltip={t("midSentencePauseTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={10.0}
							min={0.1}
							onChange={(v) => update({ midSentenceDetectionPause: v })}
							step={0.1}
							value={
								q?.midSentenceDetectionPause ??
								DEFAULT_SETTINGS.quality.midSentenceDetectionPause
							}
						/>
					</ElevatedSurface>
				</SettingField>
			</div>
		</SettingSection>
	);
}
