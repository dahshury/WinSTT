import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { Tooltip } from "@/shared/ui/tooltip";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSubsectionProps {
	/** When true the subsection is mid-transition (e.g. the model is warming into
	 *  VRAM after enabling): the toggle stays visually ON but its interaction is
	 *  blocked, and the body dims + goes non-interactive — exactly like the
	 *  toggle-off state — until the work completes. Distinct from
	 *  `toggleDisabled`, which greys an *unavailable* feature. */
	busy?: boolean;
	/** Help text shown in an info-icon tooltip next to the title. */
	caption?: string;
	children: ReactNode;
	/** Action rendered on the trailing edge of the title row, before any toggle. */
	headerAction?: ReactNode;
	/** Optional leading icon shown before the title. */
	icon?: IconSvgElement;
	onToggle?: (checked: boolean) => void;
	title: string;
	toggleDisabled?: boolean;
	toggleDisabledTooltip?: ReactNode;
	/** When provided, renders a toggle switch on the trailing edge of the title row. */
	toggled?: boolean;
}

/**
 * Subordinate section nested *inside* a {@link SettingSection}. Visually
 * lighter than a section — a hairline divider above (skipped for the first
 * subsection), no card chrome, sentence-case title in the body weight. When
 * its toggle is off the children dim + go non-interactive; when the parent
 * SettingSection's master toggle is off the wrapping pointer-events/opacity
 * cascade already covers the whole subtree.
 */
export function SettingSubsection({
	title,
	caption,
	children,
	headerAction,
	icon,
	toggled,
	onToggle,
	toggleDisabled,
	toggleDisabledTooltip,
	busy = false,
}: SettingSubsectionProps) {
	const hasToggle = onToggle !== undefined;
	// Body is inert when the toggle is off OR while a transition is in flight
	// (`busy`) — the user enabled it, but the controls shouldn't be touched until
	// the model finishes loading.
	const isDisabled = (hasToggle && !toggled) || busy;
	const toggle = hasToggle ? (
		<Toggle
			aria-label={`Toggle ${title}`}
			checked={toggled ?? false}
			disabled={toggleDisabled || busy}
			onCheckedChange={onToggle}
		/>
	) : null;

	return (
		<div className="mt-7 border-divider border-t pt-6 first:mt-0 first:border-t-0 first:pt-0">
			<div className="mb-3 flex items-center gap-2">
				{icon && (
					<span
						aria-hidden="true"
						className="flex size-7 shrink-0 items-center justify-center rounded bg-activity/10 text-activity ring-1 ring-activity/20"
					>
						<HugeiconsIcon icon={icon} size={13} />
					</span>
				)}
				<h4 className="min-w-0 font-medium text-foreground text-subtitle">
					{title}
				</h4>
				{caption ? <InfoTooltip content={caption} /> : null}
				{headerAction || hasToggle ? (
					<div className="ml-auto flex items-center gap-1.5">
						{headerAction}
						{toggleDisabled && toggleDisabledTooltip && toggle ? (
							<Tooltip content={toggleDisabledTooltip}>
								<span className="inline-flex">{toggle}</span>
							</Tooltip>
						) : (
							toggle
						)}
					</div>
				) : null}
			</div>
			<div
				className={cn(
					"transition-opacity duration-200 ease-out",
					isDisabled && "pointer-events-none opacity-40",
				)}
			>
				{children}
			</div>
		</div>
	);
}
