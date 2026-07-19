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
