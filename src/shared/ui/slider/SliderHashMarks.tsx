import { cn } from "@/shared/lib/cn";

interface SliderHashMarksProps {
	count: number;
	pctFor: (i: number) => number;
}

/**
 * Decorative tick marks rendered behind the track. The count + spacing
 * function come from the parent so coarse sliders (≤10 positions) show
 * one mark per step while continuous sliders show fixed deciles.
 */
export function SliderHashMarks({ count, pctFor }: SliderHashMarksProps) {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0"
			data-slot="elastic-slider-hash-marks"
		>
			{Array.from({ length: count }, (_, i) => {
				const pct = pctFor(i);
				return (
					<div
						className={cn(
							"absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200",
							"bg-transparent group-hover/elastic-slider:bg-foreground/40 group-data-[dragging]/elastic-slider:bg-foreground/40",
						)}
						key={`hash-${pct}`}
						style={{ left: `${pct}%` }}
					/>
				);
			})}
		</div>
	);
}
