import { Radar02Icon } from "@hugeicons/core-free-icons";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
} from "@/entities/setting";
import { NumberStepper } from "@/shared/ui/number-stepper";
import type {
	QualitySettings,
	QualityT,
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
		<SettingSection
			boxed
			icon={Radar02Icon}
			onToggle={onToggle}
			title={t("smartEndpoint")}
			toggled={enabled}
			tooltip={t("smartEndpointTooltip")}
		>
			<SettingField
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
				<NumberStepper
					max={3.0}
					min={0.5}
					onChange={(v) => update({ smartEndpointSpeed: v })}
					step={0.1}
					value={
						q?.smartEndpointSpeed ?? DEFAULT_SETTINGS.quality.smartEndpointSpeed
					}
				/>
			</SettingField>
		</SettingSection>
	);
}
