"use client";

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

export interface SelectedModelNameParts {
	full: string;
	main: string;
	variant?: string | null | undefined;
}

type SelectedModelMetaTone =
	| "accent"
	| "neutral"
	| "success"
	| "teal"
	| "warning";
type SelectedModelMetaPlacement = "below" | "right";

export interface SelectedModelMetaItem {
	description?: ReactNode | undefined;
	icon?: IconSvgElement | undefined;
	key: string;
	label: string;
	tone?: SelectedModelMetaTone | undefined;
	title?: string | undefined;
}

interface SelectedModelNameProps {
	className?: string | undefined;
	mainClassName?: string | undefined;
	parts: SelectedModelNameParts;
	variantClassName?: string | undefined;
}

interface SelectedModelMetaProps {
	className?: string | undefined;
	items: readonly SelectedModelMetaItem[];
	placement: SelectedModelMetaPlacement;
}

interface SelectedModelSummaryProps {
	leading?: ReactNode;
	meta?: readonly SelectedModelMetaItem[] | undefined;
	metaPlacement?: SelectedModelMetaPlacement | undefined;
	name: SelectedModelNameParts;
	trailing?: ReactNode;
}

function SelectedModelName({
	className,
	mainClassName,
	parts,
	variantClassName,
}: SelectedModelNameProps) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className={cn(
							"flex min-w-0 max-w-full items-baseline gap-1.5 leading-tight",
							className,
						)}
					>
						<span
							className={cn(
								"min-w-0 truncate font-medium text-body text-foreground tracking-tight",
								mainClassName,
							)}
						>
							{parts.main}
						</span>
						{parts.variant ? (
							<span
								className={cn(
									"max-w-[45%] shrink-0 truncate font-medium text-body-sm text-foreground-muted tracking-tight",
									variantClassName,
								)}
							>
								{parts.variant}
							</span>
						) : null}
					</span>
				)}
			/>
			<TooltipContent side="top">{parts.full}</TooltipContent>
		</Tooltip>
	);
}

// Toned icon+text per segment — the connected pill supplies the surface, so
// each segment only tints its glyph/label (blue = quant, green = memory/size,
// gray = neutral facts). Mirrors the OpenRouter picker's colored-badge style
// while reading as ONE badge rather than a row of competing bordered chips.
const META_SEG_TONE: Record<SelectedModelMetaTone, string> = {
	accent: "text-accent",
	neutral: "text-foreground-secondary",
	success: "text-success",
	teal: "text-activity",
	warning: "text-warning",
};

/** One segment of the connected spec badge — an optional glyph + optional label.
 *  Label-less segments (a bare glyph, e.g. a model capability) render as an even
 *  square so every segment is the same height. Wrapped in a tooltip. */
function MetaSegment({
	first,
	item,
}: {
	first: boolean;
	item: SelectedModelMetaItem;
}) {
	const icon = item.icon;
	const title = item.title ?? item.label;
	const tone = item.tone ?? "neutral";
	const ariaLabel = item.label ? `${title}: ${item.label}` : title;
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						aria-label={ariaLabel}
						className={cn(
							"inline-flex h-[22px] max-w-[7.5rem] cursor-default items-center justify-center gap-1 px-2 font-medium text-[10.5px] leading-none tabular-nums transition-colors",
							first ? null : "border-foreground/15 border-l",
							META_SEG_TONE[tone],
						)}
						data-meta-key={item.key}
					>
						{icon ? (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3 shrink-0"
								icon={icon}
							/>
						) : null}
						{item.label ? (
							<span className="min-w-0 truncate">{item.label}</span>
						) : null}
					</span>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">{title}</p>
				{item.description ? (
					<p className="text-foreground-muted text-xs-tight leading-relaxed">
						{item.description}
					</p>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}

function TextMetaItems({ items }: { items: readonly SelectedModelMetaItem[] }) {
	return (
		<>
			{items.map((item, index) => (
				<span className="inline-flex min-w-0 items-center gap-1" key={item.key}>
					{index > 0 ? (
						<span aria-hidden="true" className="text-foreground-dim/45">
							·
						</span>
					) : null}
					{item.title ? (
						<Tooltip>
							<TooltipTrigger
								render={(props) => (
									<span
										{...(props as ComponentPropsWithoutRef<"span">)}
										className="truncate tabular-nums"
									>
										{item.label}
									</span>
								)}
							/>
							<TooltipContent side="top">{item.title}</TooltipContent>
						</Tooltip>
					) : (
						<span className="truncate tabular-nums">{item.label}</span>
					)}
				</span>
			))}
		</>
	);
}

function SelectedModelMeta({
	className,
	items,
	placement,
}: SelectedModelMetaProps) {
	if (items.length === 0) {
		return null;
	}
	const hasIconItems = items.some((item) => item.icon);
	if (hasIconItems) {
		// ONE connected badge: uniform-height segments joined by hairline dividers,
		// colored per tone. Replaces the old row of separate bordered chips.
		return (
			<span
				className={cn(
					"inline-flex max-w-full items-stretch overflow-hidden rounded-md border border-border/60 bg-foreground/[0.03]",
					className,
				)}
			>
				{items.map((item, index) => (
					<MetaSegment first={index === 0} item={item} key={item.key} />
				))}
			</span>
		);
	}
	return (
		<span
			className={cn(
				"flex min-w-0 items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-foreground-muted leading-tight",
				placement === "right" ? "justify-end" : "flex-wrap",
				className,
			)}
		>
			<TextMetaItems items={items} />
		</span>
	);
}

export function SelectedModelSummary({
	leading,
	meta = [],
	metaPlacement = "below",
	name,
	trailing,
}: SelectedModelSummaryProps) {
	if (metaPlacement === "right") {
		const hasRightRail = meta.length > 0 || Boolean(trailing);
		return (
			<div className="flex min-w-0 flex-1 items-center gap-2">
				{leading}
				<SelectedModelName className="flex-1" parts={name} />
				{hasRightRail ? (
					<span className="ms-auto flex max-w-[58%] shrink-0 items-center justify-end gap-1.5 overflow-hidden">
						<SelectedModelMeta items={meta} placement="right" />
						{trailing}
					</span>
				) : null}
			</div>
		);
	}
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			{leading}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<SelectedModelName parts={name} />
				<SelectedModelMeta items={meta} placement="below" />
			</span>
			{trailing}
		</div>
	);
}
