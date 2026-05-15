import type { Transition } from "motion/react";

export const springs = {
	fast: { type: "spring", stiffness: 700, damping: 50, mass: 0.7 },
	moderate: { type: "spring", stiffness: 400, damping: 35, mass: 0.9 },
	slow: { type: "spring", stiffness: 220, damping: 28, mass: 1 },
} as const satisfies Record<"fast" | "moderate" | "slow", Transition>;
