import { AnimatePresence, domAnimation, LazyMotion, m as motion } from "motion/react";
import { type RefObject, useEffect, useState } from "react";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

/**
 * A single spring-animated **selected** pill that glides between sound rows.
 *
 * This is the fluidfunctionalism radio-group treatment, kept strictly grayscale:
 * selection reads from a neutral pill that slides to the active row (and the
 * row's own dot/weight on top), NOT from an accent tint or glow. The only color
 * anywhere in the section is the keyboard focus ring on the row itself.
 *
 * Hover is intentionally left to per-row CSS (`hover:bg-foreground/[…]`) — it's
 * instant, needs no measurement, and there's only ever one selected row to
 * track here, so a JS hover pill would add churn for no visible gain.
 *
 * ## Positioning contract
 * Mount as the first child of `containerRef`'s element, which MUST be
 * `position: relative`. Each row carries `data-sound-row="<id>"` and lifts itself
 * with `z-raised` so its text sits above this pill. Rects are measured relative
 * to the container with a live ancestor-scale correction so the pill tracks rows
 * exactly even mid open-animation (same trick as `Switcher` / `MenuHighlightLayer`).
 */

interface Rect {
	height: number;
	left: number;
	top: number;
	width: number;
}

function rectsEqual(a: Rect | null, b: Rect | null): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

function measureRect(el: HTMLElement, container: HTMLElement): Rect {
	const c = container.getBoundingClientRect();
	// Live ancestor scale = visual size (rect) ÷ layout size (offset). 1 when
	// untransformed; <1 mid open-animation. Guard the hidden (offset 0) case.
	const scaleX = container.offsetWidth ? c.width / container.offsetWidth : 1;
	const scaleY = container.offsetHeight ? c.height / container.offsetHeight : 1;
	const r = el.getBoundingClientRect();
	return {
		top: (r.top - c.top) / scaleY + container.scrollTop,
		left: (r.left - c.left) / scaleX + container.scrollLeft,
		width: r.width / scaleX,
		height: r.height / scaleY,
	};
}

function findRow(container: HTMLElement, id: string): HTMLElement | null {
	if (id === "") {
		return null;
	}
	// Scan rather than querySelector so arbitrary ids never need CSS.escape.
	const rows = container.querySelectorAll<HTMLElement>("[data-sound-row]");
	for (const row of rows) {
		if (row.dataset.soundRow === id) {
			return row;
		}
	}
	return null;
}

export interface SoundLibraryHighlightProps {
	containerRef: RefObject<HTMLElement | null>;
	/** Stable key over the current row id set — re-arms the observers on add/remove. */
	rowsKey: string;
	/** The active sound's row id (`""` for none). */
	selectedId: string;
}

export function SoundLibraryHighlight({
	containerRef,
	selectedId,
	rowsKey,
}: SoundLibraryHighlightProps) {
	const [rect, setRect] = useState<Rect | null>(null);
	// Same neutral lift the Switcher uses for its active segment: a solid surface
	// step above the row substrate reads clearly as "selected" while staying 100%
	// grayscale. Lift +2 above the elevated panel the list sits on.
	const pillLevel = Math.min(useSurface() + 2, 8);

	// Re-find + re-measure the selected row whenever selection changes or the row
	// set changes (rename/add/remove reflow). A ResizeObserver on the container
	// and each row covers the open-animation scale settling and any reflow.
	// biome-ignore lint/correctness/useExhaustiveDependencies: rowsKey is the intentional re-arm key — biome can't see the queried [data-sound-row] rows change when it changes
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const measure = () => {
			const el = findRow(container, selectedId);
			const next = el ? measureRect(el, container) : null;
			setRect((prev) => (rectsEqual(prev, next) ? prev : next));
		};
		measure();
		// One more after layout so the settled-scale geometry wins on first paint.
		const raf = requestAnimationFrame(measure);
		const ro = new ResizeObserver(measure);
		ro.observe(container);
		for (const row of container.querySelectorAll<HTMLElement>("[data-sound-row]")) {
			ro.observe(row);
		}
		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
		};
	}, [containerRef, selectedId, rowsKey]);

	return (
		<LazyMotion features={domAnimation} strict={true}>
			<AnimatePresence>
				{rect ? (
					<motion.div
						animate={{
							top: rect.top,
							left: rect.left,
							width: rect.width,
							height: rect.height,
							opacity: 1,
						}}
						aria-hidden="true"
						className={`pointer-events-none absolute rounded-lg ring-1 ring-foreground/[0.06] ring-inset ${surfaceBg(pillLevel)}`}
						exit={{ opacity: 0, transition: { duration: 0.12 } }}
						initial={false}
						key="sound-selected"
						transition={{ ...springs.moderate, opacity: { duration: 0.08 } }}
					/>
				) : null}
			</AnimatePresence>
		</LazyMotion>
	);
}
