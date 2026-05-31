import { type MotionValue, m as motion } from "motion/react";
import { cn } from "@/shared/lib/cn";

interface SliderFillBarProps {
	fillWidth: MotionValue<string>;
}

/**
 * The "elapsed" fill behind the handle. Width is driven by a motion value so
 * pointer drags and spring animations both flow through the same imperative
 * path without re-rendering the parent.
 */
export function SliderFillBar({ fillWidth }: SliderFillBarProps) {
	return (
		<motion.div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-y-0 left-0 transition-colors",
				"bg-foreground/15 group-data-[active=true]/elastic-slider:bg-foreground/25"
			)}
			data-slot="elastic-slider-fill"
			style={{ width: fillWidth }}
		/>
	);
}
