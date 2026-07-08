import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m as motion,
} from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Spinner } from "@/shared/ui/spinner";
import { usePending } from "./usePending";

/**
 * Wraps an interactive control and floats a small spinner badge over one corner
 * while `pending` is true — the *visible* companion to {@link usePending}.
 *
 * Built for custom controls (`Toggle`, `Switcher`) that a `Slot`/`useRender`
 * merge can't reach: the badge is absolutely positioned so it never reflows the
 * control (no layout shift), and it reuses the same corner-badge geometry as
 * `SwitcherBadge` for a consistent look. The wrapper carries `aria-busy` and
 * swallows interaction while pending (via {@link usePending}); the spinner
 * itself is decorative — the wrapped control keeps its own accessible name.
 */

export type PendingBadgePlacement =
	| "top-start"
	| "top-end"
	| "bottom-start"
	| "bottom-end";

export interface PendingBadgeProps {
	/** The control to badge. */
	children: ReactNode;
	/** Extra classes for the wrapper (e.g. layout tweaks at the call site). */
	className?: string | undefined;
	/** Corner the badge floats over. Logical (RTL-aware). Default `top-end`. */
	placement?: PendingBadgePlacement;
	/** Whether the spinner badge is shown. */
	pending: boolean;
}

const PLACEMENT_CLASS: Record<PendingBadgePlacement, string> = {
	"top-start": "-top-1.5 -start-1.5",
	"top-end": "-top-1.5 -end-1.5",
	"bottom-start": "-bottom-1.5 -start-1.5",
	"bottom-end": "-bottom-1.5 -end-1.5",
};

export function PendingBadge({
	children,
	className,
	placement = "top-end",
	pending,
}: PendingBadgeProps) {
	const { pendingProps } = usePending({ isPending: pending });
	// Lift the badge disc one level above the host surface so it reads as a
	// raised chip on any panel, mirroring SwitcherBadge.
	const badgeLevel = Math.min(useSurface() + 1, 8);

	return (
		<span className={cn("relative inline-flex", className)} {...pendingProps}>
			{children}
			<LazyMotion features={domAnimation} strict={true}>
				<AnimatePresence>
					{pending ? (
						<motion.span
							animate={{ opacity: 1, scale: 1 }}
							aria-hidden="true"
							className={cn(
								"pointer-events-none absolute z-overlay inline-flex size-4 items-center justify-center rounded-full ring-1 ring-divider shadow-sm",
								surfaceBg(badgeLevel),
								PLACEMENT_CLASS[placement],
							)}
							data-slot="pending-badge"
							exit={{ opacity: 0, scale: 0.6, transition: springs.fast.exit }}
							initial={{ opacity: 0, scale: 0.6 }}
							transition={springs.fast}
						>
							<Spinner className="size-2.5 border-2 text-accent" />
						</motion.span>
					) : null}
				</AnimatePresence>
			</LazyMotion>
		</span>
	);
}
