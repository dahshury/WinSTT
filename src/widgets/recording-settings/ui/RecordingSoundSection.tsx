import { BellRingIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
} from "@/entities/setting";
import { SoundLibrary } from "@/features/recording-sound";
import type {
	CommonT,
	GeneralSettings,
	GeneralT,
	UpdateGeneralFn,
} from "./recording-settings-types";

interface RecordingSoundSectionProps {
	enabled: boolean;
	general: GeneralSettings | undefined;
	t: GeneralT;
	tCommon: CommonT;
	update: UpdateGeneralFn;
}

export function RecordingSoundSection({
	enabled,
	general,
	t,
	tCommon,
	update,
}: RecordingSoundSectionProps): ReactNode {
	// The enable toggle lives on the section header (matching every other
	// master-switch section); when it's off the section body dims + goes inert
	// on its own, so the sound picker needs no separate disabled wrapper. The
	// sound-path reset sits on the header too, shown only while enabled.
	// `boxed` gives the same section-card surface as every other section (e.g.
	// Input Device); the picker renders `bare` so its own surface doesn't nest
	// a second background inside that card.
	return (
		<SettingSection
			boxed
			headerAction={
				enabled ? (
					<SettingResetButton
						isDefault={
							(general?.recordingSoundPath ?? "") ===
							DEFAULT_SETTINGS.general.recordingSoundPath
						}
						onReset={() =>
							update({
								recordingSoundPath: DEFAULT_SETTINGS.general.recordingSoundPath,
							})
						}
					/>
				) : undefined
			}
			icon={BellRingIcon}
			onToggle={(v) => update({ recordingSound: v })}
			title={t("recordingSound")}
			toggled={enabled}
			tooltip={t("soundLibraryTooltip")}
		>
			<div className="py-3.5">
				<SoundLibrary bare t={t} tCommon={tCommon} />
			</div>
		</SettingSection>
	);
}
