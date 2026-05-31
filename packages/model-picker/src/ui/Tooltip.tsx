"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

/**
 * Internal Tooltip wrappers used across the OpenRouter model selector widget.
 *
 * The shared `@/shared/ui/tooltip` is content-prop-only (string content); the
 * ported event_manager components pass rich JSX, so we re-export Base UI's
 * primitives here in a shadcn-compatible shape.
 *
 * `TooltipTrigger` and `TooltipContent` live in their own sibling files
 * (one-component-per-file rule); re-exported here so existing call sites
 * keep working via `import { Tooltip, TooltipTrigger, TooltipContent } from "./Tooltip"`.
 */

export { TooltipContent, type TooltipContentProps } from "./TooltipContent";
export { TooltipTrigger } from "./TooltipTrigger";

export interface TooltipProps {
	children: ReactNode;
	/**
	 * Open delay in ms. Honored only when a parent `<TooltipPrimitive.Provider>`
	 * is in scope; Base UI sets the per-tooltip delay there in 1.4. Accepted
	 * here for API parity with the ported components — silently ignored
	 * otherwise.
	 */
	delay?: number;
	/** When true, the tooltip never opens. */
	disabled?: boolean;
}

export function Tooltip({ children, disabled }: TooltipProps) {
	return <TooltipPrimitive.Root disabled={disabled}>{children}</TooltipPrimitive.Root>;
}
