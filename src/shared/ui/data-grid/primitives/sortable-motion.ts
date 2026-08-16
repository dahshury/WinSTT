import type { Modifier } from "@dnd-kit/core";

/**
 * The feel of a drag-to-reorder: how the grabbed card, the siblings it pushes
 * out of the way, and the drop itself move. Kept out of `sortable.tsx` (which
 * is the dnd-kit plumbing) so the numbers are readable and testable on their
 * own.
 *
 * Three motions, kept from fighting each other:
 *   1. the grabbed card tracks the pointer RAW — dnd-kit gives the drag source
 *      no `transition`, and the lift rides its own custom property so the
 *      offset is never eased (easing between hand and card reads as lag);
 *   2. displaced siblings glide exactly one slot on the moderate tier;
 *   3. the drop is a FLIP — dnd-kit measures, inverts, then glides home.
 *
 * Durations and the curve live in globals.css as `--drag-*`; the ms below is
 * the one value dnd-kit needs as a number, so it mirrors `--drag-dur`.
 */
export const DRAG_MS = 160; // keep in step with --drag-dur

/** Sibling glide + FLIP drop, handed to `useSortable`. */
export const DRAG_TRANSITION = {
	duration: DRAG_MS,
	easing: "var(--drag-ease)",
};

/** The lift's own clock: the scale (via `--drag-lift`), its shadow, and the
 *  ghost fade of a row standing in for an overlay. */
export const LIFT_TRANSITION =
	"--drag-lift var(--drag-dur) var(--drag-ease), box-shadow var(--drag-dur) var(--drag-ease), opacity var(--drag-dur) var(--drag-ease)";

/** Past the ends, the card follows the pointer at 1/4 speed… */
const RUBBER_BAND_RATIO = 4;
/** …up to this much. The cap is not cosmetic: these lists live inside
 *  scrollable popups, and an overshoot taller than the popup's own padding
 *  would grow its scroll area mid-drag and flash a scrollbar. */
const RUBBER_BAND_MAX_PX = 6;

/**
 * Bound `value` to `[min, max]` elastically instead of hard-clamping it (what
 * dnd-kit's `restrictToParentElement` does): pulling past an end still moves
 * the card, just with damped, capped resistance, so the list's end reads as a
 * wall you can lean on rather than a dead stop.
 */
export function rubberBand(value: number, min: number, max: number): number {
	if (min > max) {
		// Item taller than its container — nothing meaningful to bound against.
		return value;
	}
	if (value < min) {
		return (
			min - Math.min(RUBBER_BAND_MAX_PX, (min - value) / RUBBER_BAND_RATIO)
		);
	}
	if (value > max) {
		return (
			max + Math.min(RUBBER_BAND_MAX_PX, (value - max) / RUBBER_BAND_RATIO)
		);
	}
	return value;
}

/** `restrictToParentElement`, but elastic — see `rubberBand`. */
export const rubberBandWithinParent: Modifier = ({
	containerNodeRect,
	draggingNodeRect,
	transform,
}) => {
	if (!(draggingNodeRect && containerNodeRect)) {
		return transform;
	}
	return {
		...transform,
		x: rubberBand(
			transform.x,
			containerNodeRect.left - draggingNodeRect.left,
			containerNodeRect.right - draggingNodeRect.right,
		),
		y: rubberBand(
			transform.y,
			containerNodeRect.top - draggingNodeRect.top,
			containerNodeRect.bottom - draggingNodeRect.bottom,
		),
	};
};
