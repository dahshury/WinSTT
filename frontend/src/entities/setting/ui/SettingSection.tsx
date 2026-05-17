"use client";

import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import {
	TextureCard,
	TextureCardBody,
	TextureCardFooter,
	TextureCardHeader,
	TextureSeparator,
} from "@/shared/ui/texture-card";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSectionProps {
	children: ReactNode;
	/**
	 * Optional one-line description rendered in the *footer* of the card —
	 * the brighter strip at the bottom — providing the contrast band the
	 * texture-card aesthetic depends on. Falls back to omitting the footer
	 * entirely if neither this nor `footer` is provided.
	 */
	description?: string;
	/** Custom footer content (e.g. status, hint, action). Overrides `description`. */
	footer?: ReactNode;
	/** Optional leading icon shown before the title. */
	icon?: IconSvgElement;
	onToggle?: (checked: boolean) => void;
	title: string;
	toggleDisabled?: boolean;
	/** When provided, renders a toggle switch on the trailing edge of the header. */
	toggled?: boolean;
}

/**
 * Top-level grouping inside a settings panel. Now rendered as a texture-card:
 * an outer-ringed, surface-lifted container with a header (icon badge +
 * title + optional toggle), an embossed separator, the body of form rows,
 * and an optional brighter footer strip for description/status.
 *
 * Layered substrate: the page is surface-1, the panel viewport lifts to
 * surface-2, this card body lifts again to surface-3, and any
 * `ElevatedSurface` control inside lifts further to surface-5. The
 * separators are deliberately darker than the body so they read as etched
 * grooves rather than thin gray lines.
 */
export function SettingSection({
	title,
	description,
	footer,
	children,
	icon,
	toggled,
	onToggle,
	toggleDisabled,
}: SettingSectionProps) {
	const hasToggle = onToggle !== undefined;
	const isDisabled = hasToggle && !toggled;
	const renderedFooter = footer ?? (description ? <span>{description}</span> : null);

	return (
		<TextureCard offset={1}>
			<TextureCardHeader>
				{icon && (
					<span
						aria-hidden="true"
						className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent ring-1 ring-accent/30"
					>
						<HugeiconsIcon icon={icon} size={17} />
					</span>
				)}
				<h3 className="min-w-0 flex-1 font-semibold text-foreground text-title">{title}</h3>
				{hasToggle && (
					<div className="shrink-0">
						<Toggle
							aria-label={`Toggle ${title}`}
							checked={toggled ?? false}
							disabled={toggleDisabled}
							onCheckedChange={onToggle}
						/>
					</div>
				)}
			</TextureCardHeader>
			<TextureSeparator />
			<TextureCardBody
				className={cn(
					"transition-opacity duration-200 ease-out",
					isDisabled && "pointer-events-none opacity-40"
				)}
			>
				{children}
			</TextureCardBody>
			{renderedFooter ? (
				<>
					<TextureSeparator />
					<TextureCardFooter>{renderedFooter}</TextureCardFooter>
				</>
			) : null}
		</TextureCard>
	);
}
