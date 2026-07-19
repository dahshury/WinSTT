import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRef, useState } from "react";
import { AnchorContext } from "./popover-context";
import type { PopoverProps } from "./popover.types";

export function Popover({
	children,
	defaultOpen,
	modal,
	onOpenChange,
	open,
}: PopoverProps) {
	const anchorRef = useRef<HTMLElement | null>(null);
	const [hasAnchor, setHasAnchor] = useState(false);
	return (
		<AnchorContext.Provider value={{ anchorRef, hasAnchor, setHasAnchor }}>
			<PopoverPrimitive.Root
				defaultOpen={defaultOpen}
				modal={modal}
				onOpenChange={(next) => onOpenChange?.(next)}
				open={open}
			>
				{children}
			</PopoverPrimitive.Root>
		</AnchorContext.Provider>
	);
}
