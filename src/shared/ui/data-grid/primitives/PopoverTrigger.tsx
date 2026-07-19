import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { PopoverTriggerProps } from "./popover.types";

export function PopoverTrigger({
	asChild,
	children,
	...props
}: PopoverTriggerProps) {
	if (asChild) {
		return <PopoverPrimitive.Trigger render={children} />;
	}
	return (
		<PopoverPrimitive.Trigger {...props}>{children}</PopoverPrimitive.Trigger>
	);
}
