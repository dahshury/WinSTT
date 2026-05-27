"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentPropsWithoutRef } from "react";

type TriggerProps = ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>;

export function TooltipTrigger(props: TriggerProps) {
	return <TooltipPrimitive.Trigger {...props} />;
}
