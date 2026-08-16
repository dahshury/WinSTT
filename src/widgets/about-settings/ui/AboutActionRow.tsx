import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { AboutActionButton } from "./AboutActionButton";

interface AboutRowProps {
	/** Trailing slot — normally an {@link AboutActionButton}. Rows that carry no
	 *  action pass a `ABOUT_ACTION_WIDTH` spacer so the action column stays
	 *  aligned all the way down the list. */
	action?: ReactNode;
	/** Names the row as a group for assistive tech. Set it on rows whose action
	 *  label repeats ("Remove") so a single row is still addressable by name. */
	ariaLabel?: string | undefined;
	/** Optional block under the title/summary — e.g. a usage meter. */
	children?: ReactNode;
	/** Optional leading glyph (storage category, file kind, …). */
	leadingIcon?: IconSvgElement | undefined;
	/** Optional secondary line under the title (omitted for label-only rows). */
	summary?: string | undefined;
	title: string;
	/** Optional trailing value on the title line — e.g. a size + share. */
	value?: ReactNode;
}

/**
 * The single row shape of the About tab: optional leading glyph, a text column
 * (title, optional trailing value, optional summary, optional block such as a
 * meter), and one trailing action slot. Both the plain action rows and the
 * application-data usage rows render through it, so "what this costs" and
 * "remove it" share one container, one type scale and one affordance instead of
 * the card-vs-row split they used to have. Mirrors the FormControl "row" rhythm
 * (`gap-4 py-3`) so rows divide cleanly.
 */
export function AboutRow({
	action,
	ariaLabel,
	children,
	leadingIcon,
	summary,
	title,
	value,
}: AboutRowProps): ReactNode {
	return (
		<div
			className="flex items-center gap-4 py-3"
			{...(ariaLabel === undefined
				? {}
				: { "aria-label": ariaLabel, role: "group" })}
		>
			{leadingIcon === undefined ? null : (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-muted"
					disableSecondaryOpacity={true}
					icon={leadingIcon}
					size={16}
				/>
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				{/* The title only shares its line when there IS a trailing value —
				    otherwise it stays a bare span so plain rows keep wrapping long
				    titles exactly as before. */}
				{value === undefined ? (
					<span className="font-medium text-body text-foreground leading-tight">
						{title}
					</span>
				) : (
					<div className="flex items-baseline justify-between gap-2">
						<span className="min-w-0 truncate font-medium text-body text-foreground leading-tight">
							{title}
						</span>
						{value}
					</div>
				)}
				{summary === undefined ? null : (
					<span className="text-body-sm text-foreground-muted leading-snug">
						{summary}
					</span>
				)}
				{children}
			</div>
			{action}
		</div>
	);
}

interface AboutActionRowProps {
	buttonLabel: string;
	/** Render the trailing button with the dim-error destructive treatment. */
	destructive?: boolean;
	disabled?: boolean | undefined;
	icon: IconSvgElement;
	iconClassName?: string | undefined;
	onClick: () => void;
	/** Optional secondary line under the title (omitted for label-only rows). */
	summary?: string | undefined;
	title: string;
}

/** One flat row in an About settings section — title (+ optional summary) on
 *  the left, a compact fixed-width action button on the right. */
export function AboutActionRow({
	buttonLabel,
	destructive = false,
	disabled,
	icon,
	iconClassName,
	onClick,
	summary,
	title,
}: AboutActionRowProps): ReactNode {
	return (
		<AboutRow
			action={
				<AboutActionButton
					icon={icon}
					onClick={onClick}
					variant={destructive ? "danger" : "neutral"}
					{...(disabled === undefined ? {} : { disabled })}
					{...(iconClassName === undefined ? {} : { iconClassName })}
				>
					{buttonLabel}
				</AboutActionButton>
			}
			title={title}
			{...(summary === undefined ? {} : { summary })}
		/>
	);
}
