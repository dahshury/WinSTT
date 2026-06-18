import { Radar02Icon } from "@hugeicons/core-free-icons";
import { DEFAULT_SETTINGS, SettingField, SettingSection } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Toggle } from "@/shared/ui/toggle";
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
		<SettingSection icon={Radar02Icon} title={t("smartEndpoint")}>
			<div className="flex flex-col">
				<SettingField
					isDefault={enabled === DEFAULT_SETTINGS.quality.smartEndpoint}
					label={t("smartEndpointLabel")}
					labelAddon={<Toggle checked={enabled} onCheckedChange={onToggle} />}
					onReset={() => onToggle(DEFAULT_SETTINGS.quality.smartEndpoint)}
					tooltip={t("smartEndpointTooltip")}
				/>
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
