"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { isValidElement, type ComponentPropsWithoutRef, type ReactNode } from "react";

type TriggerProps = ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>;
type TooltipTriggerProps = Omit<TriggerProps, "children"> & {
	children?: ReactNode;
};

export function TooltipTrigger({ children, render, ...props }: TooltipTriggerProps) {
	if (render !== undefined) {
		return <TooltipPrimitive.Trigger render={render} {...props} />;
	}
	if (isValidElement(children)) {
		return <TooltipPrimitive.Trigger render={children} {...props} />;
	}
	return <TooltipPrimitive.Trigger {...props}>{children}</TooltipPrimitive.Trigger>;
}
