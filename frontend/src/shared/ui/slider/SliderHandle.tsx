import { type MotionValue, m as motion } from "motion/react";

interface SliderHandleProps {
	handleLeft: MotionValue<string>;
	isActive: boolean;
	isDragging: boolean;
	opacity: number;
	shouldReduceMotion: boolean | null;
	valueDodge: boolean;
}

/**
 * Animated indicator marking the current value. Opacity/scale animate via
 * Framer; X position is read from a shared motion value so drag, click-jump,
 * and keyboard nudges all flow through one channel.
 */
export function SliderHandle({
	handleLeft,
	isActive,
	isDragging: _isDragging,
	opacity,
	shouldReduceMotion,
	valueDodge,
}: SliderHandleProps) {
	return (
		<motion.div
			animate={{
				opacity,
				scaleX: isActive ? 1 : 0.25,
				scaleY: isActive && valueDodge ? 0.75 : 1,
			}}
			aria-hidden="true"
			className="pointer-events-none absolute top-1/2 h-5 w-1 rounded-full bg-foreground"
			data-slot="elastic-slider-handle"
			style={{ left: handleLeft, y: "-50%" }}
			transition={
				shouldReduceMotion
					? { duration: 0 }
					: {
							scaleX: { type: "spring", visualDuration: 0.25, bounce: 0.15 },
							scaleY: { type: "spring", visualDuration: 0.2, bounce: 0.1 },
							opacity: { duration: 0.15 },
						}
			}
		/>
	);
}
