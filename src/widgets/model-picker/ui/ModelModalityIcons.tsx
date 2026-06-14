"use client";

import {
	File01Icon,
	GridIcon,
	Image01Icon,
	Mic01Icon,
	TextIcon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

interface ModalityIconConfig {
	bgClass: string;
	borderClass: string;
	description: string;
	icon: ReactNode;
	iconSm: ReactNode;
	label: string;
	shortLabel: string;
	textClass: string;
}

/**
 * Per-modality chip definitions, keyed by the lowercased modality string
 * returned by OpenRouter (e.g. `text`, `image`, `audio`, `video`, `file`,
 * `embeddings`). The chips reuse the same styling cadence as
 * `EndpointFeatureIcons` so embedding rows and chat rows feel coherent.
 */
// fluidfunctionalism: modality glyphs are NEUTRAL. The icon SHAPE (and its
// tooltip) carries the meaning — text/image/audio/video/file each read at a
// glance from the glyph alone — so every chip shares one muted gray treatment
// instead of a six-hue rainbow. Keeps the meta row calmly grayscale.
const NEUTRAL_GLYPH_CHROME = {
	bgClass: "bg-foreground/[0.04]",
	textClass: "text-foreground-muted",
	borderClass: "border-border/60",
} as const;

const MODALITY_ICONS: Record<string, ModalityIconConfig> = {
	text: {
		icon: <HugeiconsIcon className="size-3" icon={TextIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={TextIcon} />,
		label: "Text",
		shortLabel: "TXT",
		description: "Accepts plain text as input.",
		...NEUTRAL_GLYPH_CHROME,
	},
	image: {
		icon: <HugeiconsIcon className="size-3" icon={Image01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Image01Icon} />,
		label: "Image",
		shortLabel: "IMG",
		description: "Accepts images as input (vision / multimodal).",
		...NEUTRAL_GLYPH_CHROME,
	},
	audio: {
		icon: <HugeiconsIcon className="size-3" icon={Mic01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Mic01Icon} />,
		label: "Audio",
		shortLabel: "AUD",
		description: "Accepts audio as input.",
		...NEUTRAL_GLYPH_CHROME,
	},
	video: {
		icon: <HugeiconsIcon className="size-3" icon={Video01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Video01Icon} />,
		label: "Video",
		shortLabel: "VID",
		description: "Accepts video frames as input.",
		...NEUTRAL_GLYPH_CHROME,
	},
	file: {
		icon: <HugeiconsIcon className="size-3" icon={File01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={File01Icon} />,
		label: "File",
		shortLabel: "FILE",
		description: "Accepts file attachments (PDF, docs, …) as input.",
		...NEUTRAL_GLYPH_CHROME,
	},
	embeddings: {
		icon: <HugeiconsIcon className="size-3" icon={GridIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={GridIcon} />,
		label: "Embeddings",
		shortLabel: "EMB",
		description: "Produces dense vector embeddings as output.",
		...NEUTRAL_GLYPH_CHROME,
	},
};

/** Display order — keeps the row stable regardless of upstream ordering. */
const MODALITY_PRIORITY = ["text", "image", "audio", "video", "file"] as const;

export interface ModelModalityIconsProps {
	className?: string;
	/** Drops chip background/border so glyphs sit inside a unified meta pill. */
	flat?: boolean;
	/** Hard cap on rendered chips. Defaults to 4 (matches feature-icon row). */
	maxIcons?: number;
	modalities: readonly string[] | undefined;
	size?: "sm" | "md";
}

export function ModelModalityIcons({
	className,
	flat = false,
	maxIcons = 4,
	modalities,
	size = "sm",
}: ModelModalityIconsProps) {
	if (!modalities || modalities.length === 0) {
		return null;
	}
	const present = new Set(modalities.map((m) => m.toLowerCase()));
	const chips: Array<{ config: ModalityIconConfig; key: string }> = [];
	for (const key of MODALITY_PRIORITY) {
		if (chips.length >= maxIcons) {
			break;
		}
		if (present.has(key)) {
			chips.push({ key, config: MODALITY_ICONS[key] as ModalityIconConfig });
		}
	}
	if (chips.length === 0) {
		return null;
	}

	const isSmall = size === "sm";
	const sizeClass = (() => {
		if (flat) {
			return isSmall ? "size-4" : "size-5";
		}
		return isSmall ? "size-4 p-0.5" : "size-5 p-0.5";
	})();
	return (
		<div className={cn("flex items-center gap-0.5", className)}>
			{chips.map(({ key, config }) => (
				<Tooltip key={key}>
					<TooltipTrigger
						render={(props) => (
							<div
								{...(props as ComponentPropsWithoutRef<"div">)}
								className={cn(
									"inline-flex cursor-default items-center justify-center transition-[transform,box-shadow,color] duration-150",
									flat
										? cn(config.textClass, "hover:scale-110")
										: cn(
												"rounded-md border hover:scale-105 hover:shadow-sm",
												config.bgClass,
												config.textClass,
												config.borderClass,
											),
									sizeClass,
								)}
							>
								{isSmall ? config.iconSm : config.icon}
							</div>
						)}
					/>
					<TooltipContent className="max-w-xs" side="top">
						<p className="font-semibold text-body-sm">{config.label}</p>
						<p className="text-foreground-muted text-xs-tight leading-relaxed">
							{config.description}
						</p>
					</TooltipContent>
				</Tooltip>
			))}
		</div>
	);
}
