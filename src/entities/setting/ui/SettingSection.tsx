import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, useSurface } from "@/shared/lib/surface";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSectionProps {
	children?: ReactNode;
	/** Optional help text shown in an info-icon tooltip next to the section title. */
	description?: string;
	/**
	 * Wrap the body in the standard hairline-divided column
	 * (`flex flex-col divide-y divide-surface-1`) so each child row is
	 * separated by a divider. The common case for a stack of `SettingField`
	 * rows — saves repeating the wrapper at every call site.
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
 * Top-level grouping inside a settings panel. Rendered as a FLAT flowing
 * section — a heading row (optional leading icon + title + optional trailing
 * toggle/action), a full-width hairline divider, then the body of form rows
 * flowing directly on the panel surface. No card box, no ring: adjacent
 * sections read as one continuous page rather than stacked rectangles.
 *
 * Crucially it still re-provides a +1 surface step downward (matching the old
 * card body level) WITHOUT painting that surface, so every nested
 * `ElevatedSurface` control keeps the exact elevation it had inside the card
 * (surface-5 on a surface-2 panel) and its contrast is unchanged — only the
 * surrounding container chrome is gone.
 */
export function SettingSection({
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
		<div className="flex flex-col divide-y divide-surface-1">{children}</div>
	) : (
		children
	);

	return (
		<SurfaceProvider value={contentLevel}>
			<section className="pt-6 first:pt-1">
				<header className="flex items-center gap-2.5">
					{icon && (
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0 text-foreground-muted"
							icon={icon}
							size={15}
						/>
					)}
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						<h3 className="min-w-0 font-semibold text-foreground text-subtitle tracking-[-0.01em]">
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
				<div
					aria-hidden="true"
					className="mt-2.5 h-px w-full bg-[var(--color-divider-strong)]"
				/>
				{hasBody ? (
					<div
						className={cn(
							"pt-1 transition-opacity duration-200 ease-out",
							isDisabled && "pointer-events-none opacity-40",
						)}
					>
						{body}
					</div>
				) : null}
				{renderedFooter ? (
					<div className="pt-2 text-body-sm text-foreground-muted">
						{renderedFooter}
					</div>
				) : null}
			</section>
		</SurfaceProvider>
	);
}
