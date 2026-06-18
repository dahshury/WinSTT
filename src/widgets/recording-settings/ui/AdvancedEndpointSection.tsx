import {
	Clock01Icon,
	FlashIcon,
	HourglassIcon,
	InfinityIcon,
	SlidersHorizontalIcon,
	Timer01Icon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Select, type SelectOption } from "@/shared/ui/select";
import type {
	AudioSettings,
	AudioT,
	UpdateAudioFn,
} from "./recording-settings-types";

interface AdvancedSectionProps {
	audio: AudioSettings | undefined;
	t: AudioT;
	update: UpdateAudioFn;
}

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
			<div className="flex flex-col">
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
