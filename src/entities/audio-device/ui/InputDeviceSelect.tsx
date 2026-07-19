import { useState } from "react";
import { Select } from "@/shared/ui/select";
import {
	applyDeviceSelection,
	priorityFromReorderedOptions,
} from "../lib/device-options";
import { useInputDevices } from "../model/use-input-devices";
import { useInputDevicePickerModel } from "../model/use-input-device-picker-model";
import type { InputDeviceSelectProps } from "./input-device-select.types";

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
