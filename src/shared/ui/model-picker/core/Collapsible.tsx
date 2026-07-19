"use client";

import { cn } from "@/shared/lib/cn";
import type { CollapsibleProps } from "./collapsible.types";
import { useOpenedFlag } from "./use-opened-flag";

/**
 * Pure CSS height-to-auto animation via the grid-template-rows trick
 * (``0fr`` -> ``1fr``). Used by every collapsible row in the model
 * pickers - OpenRouter's hosting-provider grid AND the STT picker's
 * variant bundles - so they share one ease curve, one duration, and
 * one a11y contract (``inert`` + ``data-state``).
 *
 * 12-principles-of-animation applied:
 *
 * - Slow in / slow out: ``ease-out`` (200ms). Expansion accelerates
 *   fast then settles, matching how a real drawer feels when released.
 * - Timing: 200ms is the OpenRouter standard - long enough to register
 *   as motion, short enough to never feel like a wait.
 * - Solid drawing: the grid trick keeps the outer bounds intact during
 *   the transition (no layout-shift jitter on the surrounding cards).
 * - Staging: ``inert`` strips the collapsed content from focus order
 *   and pointer events so keyboard nav doesn't dive into hidden rows;
 *   ``data-state`` is the styling hook for callers that want to drive
 *   their own chevron animation in lockstep.
 * - Anticipation / secondary action: left to the caller. Typical
 *   pattern is to rotate the trigger chevron on the same
 *   ``transition-transform duration-200`` so the two motions resolve
 *   together.
 * - Reduced motion: ``motion-reduce:transition-none`` honors the
 *   user's OS preference; the toggle still works, it just snaps.
 *
 * Children mount lazily on first open via :func:`useOpenedFlag` so a
 * picker with 100 collapsed bundles doesn't pay React-render cost for
 * 100 hidden sibling lists. After the first open, content stays mounted
 * for instant subsequent re-opens (matches OpenRouter's behaviour).
 */
export function Collapsible({
	children,
	className,
	"data-slot": dataSlot = "collapsible",
	isOpen,
}: CollapsibleProps) {
	const hasOpened = useOpenedFlag(isOpen);
	return (
		<div
			className={cn(
				"grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
				className,
			)}
			data-slot={dataSlot}
			data-state={isOpen ? "open" : "closed"}
			inert={!isOpen}
			style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
		>
			<div className="min-h-0 overflow-hidden">
				{hasOpened ? children : null}
			</div>
		</div>
	);
}
