import { useState } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Select, type SelectOption } from "@/shared/ui/select";
import {
	applyDeviceSelection,
	buildInputDeviceOptions,
	priorityFromReorderedOptions,
} from "../lib/device-options";
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

export interface InputDeviceSelectProps {
	"aria-label"?: string;
	className?: string | undefined;
	disabled?: boolean;
	inputDeviceIndex: number | null;
	/** Preference order (device names, highest first). */
	inputDevicePriority?: readonly string[];
	onChange: (inputDeviceIndex: number | null) => void;
	/** When provided, device rows become drag-sortable and the new
	 *  name order is reported here (also updated by clicks — see
	 *  `applyDeviceSelection`). */
	onPriorityChange?: (priority: string[]) => void;
	/** Accessible label for the row drag handle. */
	reorderHandleLabel?: string;
	systemDefaultLabel: string;
}

export function InputDeviceSelect({
	"aria-label": ariaLabel,
	className,
	disabled,
	inputDeviceIndex,
	inputDevicePriority = [],
	onChange,
	onPriorityChange,
	reorderHandleLabel,
	systemDefaultLabel,
}: InputDeviceSelectProps) {
	const { devices, defaultDevice } = useInputDevices();
	const [open, setOpen] = useState(false);
	const { deviceOptions, currentDeviceId } = useInputDevicePickerModel({
		defaultDeviceName: defaultDevice?.name,
		devices,
		inputDeviceIndex,
		inputDevicePriority,
		monitorOpen: open,
		systemDefaultLabel,
	});

	return (
		<Select
			className={className}
			onChange={(id) =>
				applyDeviceSelection({
					id,
					onChange,
					onPriorityChange,
					options: deviceOptions,
					priority: inputDevicePriority,
				})
			}
			onOpenChange={setOpen}
			options={deviceOptions}
			value={currentDeviceId}
			{...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
			{...(disabled === undefined ? {} : { disabled })}
			{...(onPriorityChange === undefined
				? {}
				: {
						onReorder: (orderedIds: string[]) =>
							onPriorityChange(
								priorityFromReorderedOptions(deviceOptions, orderedIds),
							),
					})}
			{...(reorderHandleLabel === undefined ? {} : { reorderHandleLabel })}
		/>
	);
}
