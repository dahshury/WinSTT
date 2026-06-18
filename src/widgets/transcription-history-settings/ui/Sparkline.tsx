interface SparklineProps {
	/** Chronological values (oldest → newest). */
	values: number[];
	className?: string;
}

/**
 * A tiny line chart of a recent trend (e.g. words dictated per day). Scales to
 * the data's own max so a quiet period still reads. Renders nothing when there
 * aren't at least two points or every value is zero. Decorative — `aria-hidden`.
 */
export function Sparkline({ values, className }: SparklineProps) {
	const max = Math.max(...values, 0);
	if (values.length < 2 || max <= 0) {
		return null;
	}

	const stepX = 100 / (values.length - 1);
	const points = values
		.map((value, i) => {
			const x = (i * stepX).toFixed(2);
			// Leave 2px of headroom top and bottom inside the 28-tall viewBox.
			const y = (26 - (value / max) * 24).toFixed(2);
			return `${x},${y}`;
		})
		.join(" ");

	return (
		<svg
			aria-hidden="true"
			className={className}
			preserveAspectRatio="none"
			viewBox="0 0 100 28"
		>
			<polyline
				fill="none"
				points={points}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				style={{
					stroke: "var(--color-activity)",
					vectorEffect: "non-scaling-stroke",
				}}
			/>
		</svg>
	);
}
