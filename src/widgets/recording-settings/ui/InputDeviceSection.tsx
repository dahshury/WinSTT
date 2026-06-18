import { Mic02Icon, MicOff01Icon } from "@hugeicons/core-free-icons";
import { useState, type ReactNode } from "react";
import {
	buildInputDeviceOptions,
	MicrophoneLevelMeter,
	useInputDevices,
	useMicrophoneLevels,
} from "@/entities/audio-device";
import { SettingField, SettingSection } from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Select, type SelectOption } from "@/shared/ui/select";
import type {
	AudioSettings,
	AudioT,
	UpdateAudioFn,
} from "./recording-settings-types";

interface InputDeviceSectionProps {
	audio: AudioSettings | undefined;
	t: AudioT;
	update: UpdateAudioFn;
}

export function InputDeviceSection({
	audio,
	t,
	update,
}: InputDeviceSectionProps): ReactNode {
	const { devices, defaultDevice } = useInputDevices();
	const [deviceSelectOpen, setDeviceSelectOpen] = useState(false);
	const defaultLabel = defaultDevice
		? `${t("systemDefault")} (${defaultDevice.name})`
		: t("systemDefault");
	const { deviceOptions, currentDeviceId } = buildInputDeviceOptions(
		devices,
		audio?.inputDeviceIndex ?? null,
		defaultLabel,
		defaultDevice?.name,
	);
	const levels = useMicrophoneLevels(
		deviceSelectOpen,
		deviceOptions.map((option) => option.id),
	);
	const meteredDeviceOptions: SelectOption[] = deviceOptions.map((option) => ({
		...option,
		trailing: (
			<MicrophoneLevelMeter
				active={option.id === currentDeviceId}
				level={levels[option.id] ?? 0}
			/>
		),
	}));

	const [clamshellSelectOpen, setClamshellSelectOpen] = useState(false);
	const { deviceOptions: clamshellDeviceOptions } = buildInputDeviceOptions(
		devices,
		audio?.clamshellMicrophone ?? null,
		defaultLabel,
		defaultDevice?.name,
	);
	const currentClamshellId =
		audio?.clamshellMicrophone == null
			? "disabled"
			: String(audio.clamshellMicrophone);
	const clamshellDeviceRows = clamshellDeviceOptions.filter(
		(option) => option.id !== "default",
	);
	const clamshellLevels = useMicrophoneLevels(
		clamshellSelectOpen,
		clamshellDeviceRows.map((option) => option.id),
	);
	const clamshellOptions: SelectOption[] = [
		{ id: "disabled", label: t("clamshellDisabled"), icon: MicOff01Icon },
		...clamshellDeviceRows.map((option) => ({
			...option,
			trailing: (
				<MicrophoneLevelMeter
					active={option.id === currentClamshellId}
					level={clamshellLevels[option.id] ?? 0}
				/>
			),
		})),
	];

	return (
		<SettingSection icon={Mic02Icon} title={t("inputDevice")}>
			<div className="flex flex-col">
				<SettingField
					isDefault={currentDeviceId === "default"}
					label={t("device")}
					layout="row"
					onReset={() => update({ inputDeviceIndex: null })}
					tooltip={t("deviceTooltip")}
				>
					<ElevatedSurface className="w-52" inline>
						<Select
							onChange={(v) =>
								update({
									inputDeviceIndex:
										v === "default" ? null : Number.parseInt(v, 10),
								})
							}
							onOpenChange={setDeviceSelectOpen}
							options={meteredDeviceOptions}
							value={currentDeviceId}
						/>
					</ElevatedSurface>
				</SettingField>
				<SettingField
					isDefault={currentClamshellId === "disabled"}
					label={t("clamshellLabel")}
					layout="row"
					onReset={() => update({ clamshellMicrophone: null })}
					tooltip={t("clamshellTooltip")}
				>
					<ElevatedSurface className="w-52" inline>
						<Select
							onChange={(v) =>
								update({
									clamshellMicrophone:
										v === "disabled" ? null : Number.parseInt(v, 10),
								})
							}
							onOpenChange={setClamshellSelectOpen}
							options={clamshellOptions}
							value={currentClamshellId}
						/>
					</ElevatedSurface>
				</SettingField>
			</div>
		</SettingSection>
	);
}
