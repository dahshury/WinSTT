import {
	Clock01Icon,
	FlashIcon,
	HourglassIcon,
	InfinityIcon,
	PauseCircleIcon,
	Radar02Icon,
	SlidersHorizontalIcon,
	Timer01Icon,
} from "@hugeicons/core-free-icons";
import { type ReactNode } from "react";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Toggle } from "@/shared/ui/toggle";
import type {
	AudioSettings,
	AudioT,
	QualitySettings,
	QualityT,
	UpdateAudioFn,
	UpdateQualityFn,
} from "./recording-settings-types";

interface SmartEndpointSectionProps {
	onToggle: (next: boolean) => void;
	q: QualitySettings | undefined;
	t: QualityT;
	update: UpdateQualityFn;
}

export function SmartEndpointSection({
	q,
	t,
	update,
	onToggle,
}: SmartEndpointSectionProps) {
	const enabled = q?.smartEndpoint ?? false;
	return (
		<SettingSection icon={Radar02Icon} title={t("smartEndpoint")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<SettingField
					isDefault={enabled === DEFAULT_SETTINGS.quality.smartEndpoint}
					label={t("smartEndpointLabel")}
					labelAddon={<Toggle checked={enabled} onCheckedChange={onToggle} />}
					onReset={() => onToggle(DEFAULT_SETTINGS.quality.smartEndpoint)}
					tooltip={t("smartEndpointTooltip")}
				/>
				{/* Detection speed depends on Smart Endpoint being on — shown
				    disabled (not hidden) when off so the option stays discoverable. */}
				<SettingField
					disabled={!enabled}
					disabledReason={t("smartEndpoint")}
					isDefault={
						(q?.smartEndpointSpeed ??
							DEFAULT_SETTINGS.quality.smartEndpointSpeed) ===
						DEFAULT_SETTINGS.quality.smartEndpointSpeed
					}
					label={t("detectionSpeed")}
					layout="row"
					onReset={() =>
						update({
							smartEndpointSpeed: DEFAULT_SETTINGS.quality.smartEndpointSpeed,
						})
					}
					tooltip={t("detectionSpeedTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={3.0}
							min={0.5}
							onChange={(v) => update({ smartEndpointSpeed: v })}
							step={0.1}
							value={
								q?.smartEndpointSpeed ??
								DEFAULT_SETTINGS.quality.smartEndpointSpeed
							}
						/>
					</ElevatedSurface>
				</SettingField>
			</div>
		</SettingSection>
	);
}

interface SentencePauseSectionProps {
	q: QualitySettings | undefined;
	t: QualityT;
	update: UpdateQualityFn;
}

// Sliders that drive the toggle-mode silence-timing heuristic. Surface them
// here (in Endpointing) so users discover them next to Smart Endpoint — they
// are the manual alternative to it.
export function SentencePauseSection({
	q,
	t,
	update,
}: SentencePauseSectionProps) {
	return (
		<SettingSection icon={PauseCircleIcon} title={t("sentencePauses")}>
			<div className="flex flex-col divide-y divide-surface-1">
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

interface AdvancedSectionProps {
	audio: AudioSettings | undefined;
	t: AudioT;
	update: UpdateAudioFn;
}

// Consolidated mic-release picker — a single Select covering the five discrete
// behaviors (always / immediate / 30s / 1m / 5m). The Tauri recorder reads the
// persisted policy live; changing it must not ask for a restart.
export function AdvancedSection({
	audio,
	t,
	update,
}: AdvancedSectionProps): ReactNode {
	const microphoneRelease =
		audio?.microphoneRelease ?? DEFAULT_SETTINGS.audio.microphoneRelease;
	const microphoneReleaseOptions: SelectOption[] = [
		{ id: "always", label: t("microphoneReleaseAlways"), icon: InfinityIcon },
		{
			id: "immediate",
			label: t("microphoneReleaseImmediate"),
			icon: FlashIcon,
		},
		{ id: "sec30", label: t("microphoneReleaseSec30"), icon: Clock01Icon },
		{ id: "min1", label: t("microphoneReleaseMin1"), icon: Timer01Icon },
		{ id: "min5", label: t("microphoneReleaseMin5"), icon: HourglassIcon },
	];
	return (
		<SettingSection icon={SlidersHorizontalIcon} title={t("advancedTitle")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<SettingField
					isDefault={
						microphoneRelease === DEFAULT_SETTINGS.audio.microphoneRelease
					}
					label={t("microphoneRelease")}
					layout="row"
					onReset={() =>
						update({
							microphoneRelease: DEFAULT_SETTINGS.audio.microphoneRelease,
						})
					}
					tooltip={t("microphoneReleaseTooltip")}
				>
					<ElevatedSurface className="w-52" inline>
						<Select
							onChange={(v) =>
								update({
									microphoneRelease: v as
										| "always"
										| "immediate"
										| "sec30"
										| "min1"
										| "min5",
								})
							}
							options={microphoneReleaseOptions}
							value={microphoneRelease}
						/>
					</ElevatedSurface>
				</SettingField>
			</div>
		</SettingSection>
	);
}
