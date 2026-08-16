"use client";

import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m as motion,
	useIsPresent,
	useReducedMotion,
} from "motion/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { springs } from "@/shared/lib/springs";
import type { NavDirection } from "./use-view-stack";

/** Travel of the enter/exit slide. Short on purpose — the panel is small, and
 *  the point is spatial continuity, not distance. */
const SLIDE_PX = 18;

const INSTANT = { duration: 0 } as const;

/** Exit only. It has to be a variant because the direction that matters is the
 *  current one, which `AnimatePresence` forwards to the exiting child through
 *  `custom`; the child's own props still describe the move that put it there.
 *  Enter/animate stay plain objects so motion knows the starting opacity — a
 *  bare `exit` label with no resolved current value warns and skips the fade.
 *  Reduced motion passes `0`, flattening the slide to a fade. */
const SLIDE_VARIANTS = {
	exit: (direction: number) => ({
		opacity: 0,
		transition: springs.moderate.exit,
		x: -direction * SLIDE_PX,
	}),
};

/**
 * One view inside the stage. The present view sits in normal flow, so the
 * frame's natural height always equals the live view; the leaving one is lifted
 * out of flow so it can slide away without pushing the frame around.
 * `useIsPresent` is what lets a single component play both roles.
 */
function StageView({
	children,
	direction,
	onHeight,
	reduced,
}: {
	children: ReactNode;
	direction: number;
	onHeight: (height: number) => void;
	reduced: boolean;
}) {
	const isPresent = useIsPresent();
	const ref = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const node = ref.current;
		if (!isPresent || node === null) {
			return;
		}
		const sync = () => onHeight(node.offsetHeight);
		sync();
		// Absent under happy-dom; the frame just keeps `height: auto` there.
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(sync);
		observer.observe(node);
		return () => observer.disconnect();
	}, [isPresent, onHeight]);

	const slide = reduced ? 0 : SLIDE_PX;
	return (
		<motion.div
			animate={{ opacity: 1, x: 0 }}
			// The view on its way out is a decorative snapshot: hidden from the
			// accessibility tree and untouchable, so a half-finished slide can
			// never be read out, tabbed into, or clicked by mistake.
			aria-hidden={isPresent ? undefined : true}
			className={cn(
				"inset-x-0 top-0",
				isPresent ? "relative" : "pointer-events-none absolute",
			)}
			exit="exit"
			inert={!isPresent}
			initial={{ opacity: 0, x: direction * slide }}
			transition={reduced ? INSTANT : springs.moderate}
			variants={SLIDE_VARIANTS}
		>
			<div ref={ref}>{children}</div>
		</motion.div>
	);
}

/**
 * The animated frame every drill-down popover shares: it holds exactly one view
 * at a time, eases its own height between them, and cross-slides the outgoing
 * and incoming views so a push reads as "forward" and a pop as "back".
 *
 * Height is *measured* and tweened as a CSS property rather than projected with
 * Framer `layout` — FLIP scales the box, which visibly stretches the text
 * inside (see the dynamic-island fix). Width is declared per view (`widthPx`)
 * rather than measured, so a view that needs more room (a long author list) can
 * ask for it deterministically instead of racing a second observer.
 */
export function NavPopoverStage({
	activeKey,
	children,
	className,
	direction,
	widthPx,
}: {
	/** Identity of the view on screen — changing it triggers the slide. */
	activeKey: string;
	children: ReactNode;
	className?: string | undefined;
	direction: NavDirection;
	/** Omit when the host already fixes the width (the tray menu's OS window):
	 *  the frame then eases height only and leaves width to CSS. */
	widthPx?: number | undefined;
}) {
	const reduced = useReducedMotion() ?? false;
	const [height, setHeight] = useState<number | null>(null);
	const width = widthPx === undefined ? {} : { width: widthPx };

	return (
		<LazyMotion features={domAnimation}>
			<motion.div
				animate={height === null ? width : { ...width, height }}
				className={cn("relative overflow-hidden", className)}
				initial={false}
				// Before the first measurement the live view is still in normal
				// flow, so `auto` is already the right height and nothing jumps.
				style={height === null ? { height: "auto" } : {}}
				transition={reduced ? INSTANT : springs.moderate}
			>
				<AnimatePresence custom={reduced ? 0 : direction} initial={false}>
					<StageView
						direction={reduced ? 0 : direction}
						key={activeKey}
						onHeight={setHeight}
						reduced={reduced}
					>
						{children}
					</StageView>
				</AnimatePresence>
			</motion.div>
		</LazyMotion>
	);
}
