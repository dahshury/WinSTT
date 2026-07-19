import { cloneElement, isValidElement, use } from "react";
import { AnchorContext } from "./popover-context";
import { assignRef } from "./popover-ref";
import type { AnchorChildProps, PopoverAnchorProps } from "./popover.types";

export function PopoverAnchor({ children }: PopoverAnchorProps) {
	const ctx = use(AnchorContext);
	if (!isValidElement<AnchorChildProps>(children)) {
		return children;
	}
	const originalRef = children.props.ref;
	return cloneElement(children, {
		ref: (node: HTMLElement | null) => {
			if (ctx) {
				ctx.anchorRef.current = node;
				ctx.setHasAnchor(Boolean(node));
			}
			assignRef(originalRef, node);
		},
	});
}
