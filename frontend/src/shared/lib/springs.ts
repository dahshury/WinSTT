import type { ValueAnimationTransition } from "motion/react";

export const springs = {
	fast: { type: "spring", stiffness: 500, damping: 32, mass: 1 },
	moderate: { type: "spring", stiffness: 300, damping: 28, mass: 1 },
} as const satisfies Record<string, ValueAnimationTransition>;
