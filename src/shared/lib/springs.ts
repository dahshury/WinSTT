import type { ValueAnimationTransition } from "motion/react";

/**
 * Spring presets matching the Base UI component family our CheckboxGroup,
 * Switcher and Table are built from. These use motion's perceptual spring
 * (duration + bounce) rather than a physics spring (stiffness / damping / mass),
 * so the hover / merge motion lands with the exact snap of those components
 * instead of a slightly different physically-tuned feel.
 *
 * - fast — no overshoot; for the hover indicator gliding row-to-row.
 * - moderate — a touch of bounce; for the selected-background merge.
 * - slow — same easing as moderate, longer; available for larger moves.
 */
export const springs = {
	fast: { type: "spring", duration: 0.08, bounce: 0 },
	moderate: { type: "spring", duration: 0.16, bounce: 0.15 },
	slow: { type: "spring", duration: 0.24, bounce: 0.15 },
} as const satisfies Record<string, ValueAnimationTransition>;
