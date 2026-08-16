import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Check } from "@/shared/ui/data-grid/primitives/icons";
import {
	OPTION_DRAG_HANDLE_SIZE,
	OptionDragHandle,
	SortableOptionRows,
	type SelectOption,
} from "@/shared/ui/select";
import {
	applyDeviceSelection,
	priorityFromReorderedOptions,
} from "../lib/device-options";
import { useInputDevicePickerModel } from "../model/use-input-device-picker-model";
import { useInputDevices } from "../model/use-input-devices";
import type { InputDeviceSelectProps } from "./input-device-select.types";

export type InlineInputDeviceListProps = Omit<
	InputDeviceSelectProps,
	"aria-label" | "disabled"
> & {
	ariaLabel: string;
	/** Fired after a device is picked, so a host that opened this as a drill-down
	 *  view can navigate back. */
	onPicked?: (() => void) | undefined;
};

/**
 * The input-device picker rendered as a flat list instead of a `Select`.
 *
 * The tray menu needs this: it lives in a ~192px OS window, and a portaled
 * dropdown there gets clipped by the window itself. Inline in a drill-down view
 * the list simply grows the window, so every device stays reachable. Live level
 * meters and drag-to-reorder priority are the same ones the `Select` shows.
 */
export function InlineInputDeviceList({
	ariaLabel,
	inputDeviceIndex,
	inputDevicePriority = [],
	onChange,
	onPicked,
	onPriorityChange,
	reorderHandleLabel,
	systemDefaultLabel,
}: InlineInputDeviceListProps) {
	const { devices, defaultDevice } = useInputDevices();
	const [dragSorting, setDragSorting] = useState(false);
	const { deviceOptions, currentDeviceId } = useInputDevicePickerModel({
		defaultDeviceName: defaultDevice?.name,
		devices,
		inputDeviceIndex,
		inputDevicePriority,
		// The list is always on screen while its view is, so the level meters
		// stay live for as long as it is mounted.
		monitorOpen: true,
		systemDefaultLabel,
	});
	const substrate = useSurface();

	const select = (id: string) => {
		applyDeviceSelection({
			id,
			onChange,
			onPriorityChange,
			options: deviceOptions,
			priority: inputDevicePriority,
		});
		onPicked?.();
	};

	const renderRow = (option: SelectOption) => {
		const isSelected = option.id === currentDeviceId;
		return (
			<div
				className={cn(
					"flex min-h-8 items-center gap-1.5 rounded px-1.5",
					surfaceHoverBg(substrate + 1),
					isSelected && "text-accent",
				)}
				key={option.id}
			>
				{option.sortable ? (
					<OptionDragHandle label={reorderHandleLabel} />
				) : (
					<span className={cn("shrink-0", OPTION_DRAG_HANDLE_SIZE)} />
				)}
				<button
					aria-pressed={isSelected}
					className="flex min-w-0 flex-1 items-center gap-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent"
					onClick={() => select(option.id)}
					type="button"
				>
					{option.icon ? (
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0 text-foreground-dim"
							icon={option.icon}
							size={13}
						/>
					) : null}
					<span className="min-w-0 flex-1 truncate">{option.label}</span>
					{isSelected ? <Check className="size-3.5 shrink-0" /> : null}
				</button>
				{option.trailing ? (
					<span className="shrink-0">{option.trailing}</span>
				) : null}
			</div>
		);
	};

	return (
		// While a row is being dragged its pointer events are fenced off, so the
		// drop's pointerup can't also count as picking that device.
		<div
			aria-label={ariaLabel}
			className={cn(
				"flex flex-col gap-0.5",
				dragSorting && "[&_button]:pointer-events-none",
			)}
			data-nav-initial-focus
			role="group"
		>
			{onPriorityChange ? (
				<SortableOptionRows
					onReorder={(orderedIds) =>
						onPriorityChange(
							priorityFromReorderedOptions(deviceOptions, orderedIds),
						)
					}
					onSortingChange={setDragSorting}
					options={deviceOptions}
					renderRow={renderRow}
				/>
			) : (
				deviceOptions.map((option) => renderRow(option))
			)}
		</div>
	);
}
