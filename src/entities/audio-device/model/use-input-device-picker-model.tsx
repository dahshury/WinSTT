import type { IconSvgElement } from "@hugeicons/react";
import type { SelectOption } from "@/shared/ui/select";
import { buildInputDeviceOptions } from "../lib/device-options";
import type { AudioDevice } from "./audio-device";
import { useMicrophoneLevels } from "./use-microphone-levels";
import { MicrophoneLevelMeter } from "../ui/MicrophoneLevelMeter";

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
	/** Preference order (device names, highest first) — device rows are
	 *  displayed in this order, listed names before unlisted devices. */
	inputDevicePriority?: readonly string[];
	monitorOpen: boolean;
	systemDefaultLabel: string;
}

export function useInputDevicePickerModel({
	defaultDeviceName,
	devices,
	inputDeviceIndex,
	inputDevicePriority = [],
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
			inputDevicePriority,
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
