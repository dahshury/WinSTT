import { BellRingIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import { SoundLibrary } from "@/features/recording-sound";
import { cn } from "@/shared/lib/cn";
import { Toggle } from "@/shared/ui/toggle";
import type {
	CommonT,
	GeneralSettings,
	GeneralT,
	SettingsT,
	UpdateGeneralFn,
} from "./recording-settings-types";

interface RecordingSoundSectionProps {
	enabled: boolean;
	general: GeneralSettings | undefined;
	t: GeneralT;
	tCommon: CommonT;
	tSettings: SettingsT;
	update: UpdateGeneralFn;
}

export function RecordingSoundSection({
	enabled,
	general,
	t,
	tCommon,
	tSettings,
	update,
}: RecordingSoundSectionProps): ReactNode {
	return (
		<SettingSection divided icon={BellRingIcon} title={t("recordingSound")}>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.recordingSoundPath}
				hideReset={!enabled}
				label={t("recordingSound")}
				labelAddon={
					<Toggle
						checked={enabled}
						onCheckedChange={(v) => update({ recordingSound: v })}
					/>
				}
				onReset={() =>
					update({
						recordingSoundPath: DEFAULT_SETTINGS.general.recordingSoundPath,
					})
				}
				disabledTooltip={
					enabled
						? undefined
						: tSettings("disabledReason", { name: t("recordingSound") })
				}
				tooltip={t("soundLibraryTooltip")}
				value={general?.recordingSoundPath ?? ""}
			>
				<div
					className={cn(
						"transition-opacity duration-200 ease-out",
						!enabled && "pointer-events-none opacity-40",
					)}
				>
					<SoundLibrary t={t} tCommon={tCommon} />
				</div>
			</SettingField>
		</SettingSection>
	);
}
