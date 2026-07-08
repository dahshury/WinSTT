// Motion tokens (Fluid Functionalism springs registry,
// https://www.fluidfunctionalism.com/r/springs.json). Each tier's value is the
// ENTER transition — a critically damped spring, except the largest tier which
// keeps a little bounce. Its `.exit` is the matching EXIT transition — a plain
// tween, no bounce, one tier quicker — so a dismissal reads as crisp and final
// rather than replaying the entrance in reverse.
//
//   transition={springs.fast}                              // enter
//   exit={{ opacity: 0, transition: springs.fast.exit }}   // leave
//
// Tier mapping: fast — hover indicators, checkboxes, tooltips, inputs;
// moderate — dropdowns, tabs, switches, panels/sheets that must settle
// precisely; slow — dialogs, drawers, island morphs. The bigger the thing that
// moves, the slower the spring. Never hand-write a duration — always reach for
// a tier.
export const springs = {
	fast: {
		type: "spring" as const,
		duration: 0.08,
		bounce: 0,
		exit: { duration: 0.06 },
	},
	// Critically damped: same perceived speed as a bouncier tier, but lands
	// exactly with no overshoot — for short travel and panels/sheets that must
	// settle precisely (dropdowns, tabs, merged selection backgrounds).
	moderate: {
		type: "spring" as const,
		duration: 0.16,
		bounce: 0,
		exit: { duration: 0.12 },
	},
	slow: {
		type: "spring" as const,
		duration: 0.24,
		bounce: 0.12,
		exit: { duration: 0.16 },
	},
} as const;

// Fallback delay (ms) for deferred-unmount timers that guard an exit tween:
// popups keep their portal mounted until onAnimationComplete fires, but a
// throttled/background tab can stall the animation, so a timer force-unmounts
// after the tier's exit duration plus a safety buffer. Deriving it here keeps
// the timers in step with the tokens above.
export const exitFallbackMs = (tier: { exit: { duration: number } }) =>
	Math.round(tier.exit.duration * 1000) + 100;
