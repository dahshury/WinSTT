import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, useSurface } from "@/shared/lib/surface";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSectionProps {
	/**
	 * Grouped-card presentation: the title demotes to a small uppercase
	 * micro-label and the body rows sit inside a hairline-ringed, rounded
	 * group with inset row padding. The group's fill is a translucent
	 * `foreground` film (additive light), NOT an absolute `surface-N` paint:
	 * it can only lighten whatever it sits on, so it always reads as a gentle
	 * lift above the panel's bloomed gradient (an absolute surface-4 paint read
	 * DARKER than that gradient) and never climbs above the raised
	 * `surface-5` plate controls inside it. Per fluidfunctionalism each layer
	 * lifts one step; the grouping sits one soft step over the panel, the
	 * plates stay the top of the ladder. The rows become the loudest text on
	 * the page — the section heading only whispers the grouping. Purely
	 * visual: nothing collapses or hides.
	 */
	boxed?: boolean;
	children?: ReactNode;
	/** Optional help text shown in an info-icon tooltip next to the section title. */
	description?: string;
	/**
	 * Wrap the body in the standard settings field column (`flex flex-col`)
	 * with a hairline divider between rows, so a run of bare fields reads as
	 * one calm grouped list.
	 */
	divided?: boolean;
	/** Custom footer content for status, warnings, or actions that must stay visible. */
	footer?: ReactNode;
	/** Action rendered on the trailing edge of the header (e.g. a button). Renders alongside the toggle when both are provided. */
	headerAction?: ReactNode;
	/** Optional leading icon shown before the title. */
	icon?: IconSvgElement;
	onToggle?: (checked: boolean) => void;
	title: string;
	/** Optional help text shown in an info-icon tooltip next to the section title. */
	tooltip?: string;
	toggleDisabled?: boolean;
	/** When provided, renders a toggle switch on the trailing edge of the header. */
	toggled?: boolean;
}

/**
 * Top-level grouping inside a settings panel. Two presentations:
 *
 * Default — a FLAT flowing section: heading row (optional leading icon +
 * title + optional trailing toggle/action), a full-width hairline divider,
 * then the body of form rows flowing directly on the panel surface.
 *
 * `boxed` — a grouped card: the title demotes to a small uppercase
 * micro-label and the rows sit inside a hairline-ringed rounded group with a
 * translucent additive fill (pair with `divided` for in-card row hairlines).
 * See the prop docs for why the fill is additive, not an absolute surface.
 * Everything stays visible; only the chrome changes.
 *
 * Either way the section re-provides a +1 surface step downward WITHOUT
 * painting it, so every nested `ElevatedSurface` control keeps the same
 * elevation and contrast regardless of presentation.
 */
export function SettingSection({
	boxed,
	title,
	description,
	divided,
	footer,
	children,
	headerAction,
	icon,
	toggled,
	onToggle,
	tooltip,
	toggleDisabled,
}: SettingSectionProps) {
	const substrate = useSurface();
	const contentLevel = Math.min(substrate + 1, 8);

	const hasToggle = onToggle !== undefined;
	const isDisabled = hasToggle && !toggled;
	const helpText = tooltip ?? description;
	const renderedFooter = footer ?? null;
	const hasBody =
		children !== undefined && children !== null && children !== false;
	const body = divided ? (
		<div className="flex flex-col divide-y divide-divider">{children}</div>
	) : (
		children
	);

	return (
		<SurfaceProvider value={contentLevel}>
			{/* Uniform top gap on EVERY section — boxed or flat — so spacing
			    reads the same within a panel AND across composed-tab panel
			    boundaries (Processing/Output/Vocabulary stack two panels; a
			    per-panel `first:` reset used to cram the second panel's first
			    section against the first). The page header supplies the gap
			    above the very first section, so no `first:` reset here. */}
			<section className="pt-8">
				<header className={cn("flex items-center", boxed ? "gap-2 ps-1" : "gap-2.5")}>
					{icon && (
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0 text-foreground-muted"
							icon={icon}
							size={boxed ? 13 : 15}
						/>
					)}
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						<h3
							className={
								boxed
									? "min-w-0 font-semibold text-2xs text-foreground-muted uppercase tracking-[0.11em]"
									: "min-w-0 font-semibold text-foreground text-subtitle tracking-[-0.01em]"
							}
						>
							{title}
						</h3>
						{helpText ? <InfoTooltip content={helpText} /> : null}
					</div>
					{headerAction ? <div className="shrink-0">{headerAction}</div> : null}
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
				</header>
				{boxed ? null : (
					<div aria-hidden="true" className="mt-2.5 h-px w-full bg-divider" />
				)}
				{hasBody ? (
					<div
						className={cn(
							"transition-opacity duration-200 ease-out",
							boxed
								? // Row-list bodies self-pad via each row's own py; this
									// small vertical frame is for bare bodies (a table,
									// picker, or gap-stack) so their content never sits flush
									// against the group ring.
									"mt-2.5 rounded-xl bg-foreground/[0.03] px-4 py-1 ring-1 ring-divider"
								: "pt-1",
							isDisabled && "settings-dim pointer-events-none",
						)}
					>
						{body}
					</div>
				) : null}
				{renderedFooter ? (
					<div
						className={cn(
							"pt-2 text-body-sm text-foreground-muted",
							boxed && "ps-1",
						)}
					>
						{renderedFooter}
					</div>
				) : null}
			</section>
		</SurfaceProvider>
	);
}
