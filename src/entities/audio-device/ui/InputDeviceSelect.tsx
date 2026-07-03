import { useState } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Select, type SelectOption } from "@/shared/ui/select";
import { buildInputDeviceOptions } from "../lib/device-options";
import type { AudioDevice } from "../model/audio-device";
import { useInputDevices } from "../model/use-input-devices";
import {
	MicrophoneLevelMeter,
	useMicrophoneLevels,
} from "./MicrophoneLevelMeter";

export interface InputDevicePickerModel {
	currentDeviceIcon: IconSvgElement | undefined;
	currentDeviceId: string;
	currentDeviceLabel: string;
	deviceOptions: SelectOption[];
}

export interface InputDevicePickerModelOptions {
	defaultDeviceName?: string | null | undefined;
	devices: readonly AudioDevice[];
	inputDeviceIndex: number | null;
	monitorOpen: boolean;
	systemDefaultLabel: string;
}

export function useInputDevicePickerModel({
	defaultDeviceName,
	devices,
	inputDeviceIndex,
	monitorOpen,
	systemDefaultLabel,
}: InputDevicePickerModelOptions): InputDevicePickerModel {
	const defaultLabel = defaultDeviceName
		? `${systemDefaultLabel} (${defaultDeviceName})`
		: systemDefaultLabel;
	const { deviceOptions, currentDeviceId, currentDeviceLabel } =
		buildInputDeviceOptions(
			devices,
			inputDeviceIndex,
			defaultLabel,
			defaultDeviceName,
		);
	const levels = useMicrophoneLevels(
		monitorOpen,
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
	const currentDeviceIcon = meteredDeviceOptions.find(
		(option) => option.id === currentDeviceId,
	)?.icon;

	return {
		currentDeviceIcon,
		currentDeviceId,
		currentDeviceLabel,
		deviceOptions: meteredDeviceOptions,
	};
}

export interface InputDeviceSelectProps {
	"aria-label"?: string;
	className?: string | undefined;
	disabled?: boolean;
	inputDeviceIndex: number | null;
	onChange: (inputDeviceIndex: number | null) => void;
	systemDefaultLabel: string;
}

export function InputDeviceSelect({
	"aria-label": ariaLabel,
	className,
	disabled,
	inputDeviceIndex,
	onChange,
	systemDefaultLabel,
}: InputDeviceSelectProps) {
	const { devices, defaultDevice } = useInputDevices();
	const [open, setOpen] = useState(false);
	const { deviceOptions, currentDeviceId } = useInputDevicePickerModel({
		defaultDeviceName: defaultDevice?.name,
		devices,
		inputDeviceIndex,
		monitorOpen: open,
		systemDefaultLabel,
	});

	return (
		<Select
			className={className}
			onChange={(value) =>
				onChange(value === "default" ? null : Number.parseInt(value, 10))
			}
			onOpenChange={setOpen}
			options={deviceOptions}
			value={currentDeviceId}
			{...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
			{...(disabled === undefined ? {} : { disabled })}
		/>
	);
}
