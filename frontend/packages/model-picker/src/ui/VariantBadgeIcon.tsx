"use client";

import type { ComponentPropsWithoutRef } from "react";
import { Badge } from "@/shared/ui/badge";
import { getVariantIcon } from "../lib/model-selector-display-utils";
import { MODEL_VARIANT_INFO, type ModelVariant } from "../lib/model-variant-utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

export interface VariantBadgeIconProps {
	variant: ModelVariant;
}

/**
 * Icon-only variant chip rendered on the model-selector trigger. The visible
 * surface is a square badge holding just the variant glyph; the human-readable
 * label (e.g. "Free", "Nitro") shows up in a tooltip on hover. Used in the
 * collapsed trigger where every horizontal pixel matters — the icon alone is
 * enough recognition and the badge no longer crowds out the model name.
 */
export function VariantBadgeIcon({ variant }: VariantBadgeIconProps) {
	const label = MODEL_VARIANT_INFO[variant]?.label ?? variant;
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<Badge
						{...(props as ComponentPropsWithoutRef<"span">)}
						aria-label={label}
						className="size-5 shrink-0 justify-center p-0"
						variant="outline"
					>
						{getVariantIcon(variant)}
					</Badge>
				)}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
