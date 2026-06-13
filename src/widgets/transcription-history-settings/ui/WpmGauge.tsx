import { formatWpm } from "../lib/word-stats";

interface WpmGaugeProps {
	/** Words-per-minute value; `0` (or less) renders an empty gauge with a dash. */
	value: number;
	/** Value that fills the arc completely. 160 wpm is a brisk dictation pace. */
	max?: number;
}

// Semicircle from (12,56)→(100,56), radius 44, centered at (56,56). pathLength
// is normalized to 100 so the dash array is just the fill percentage.
const ARC = "M 12 56 A 44 44 0 0 1 100 56";

/**
 * A semicircular gauge for the "Overall WPM" hero card. The teal arc fills in
 * proportion to `value / max`; the value sits in the center. Purely
 * presentational — the surrounding card supplies the label.
 */
export function WpmGauge({ value, max = 160 }: WpmGaugeProps) {
	const filled = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
	const display = value > 0 ? formatWpm(value) : "—";

	return (
		<svg
			aria-label={`${display} words per minute`}
			className="w-full max-w-[160px]"
			role="img"
			viewBox="0 0 112 64"
		>
			<path
				d={ARC}
				fill="none"
				strokeLinecap="round"
				strokeWidth={8}
				style={{ stroke: "var(--color-surface-5)" }}
			/>
			<path
				d={ARC}
				fill="none"
				pathLength={100}
				strokeDasharray={`${filled} 100`}
				strokeLinecap="round"
				strokeWidth={8}
				style={{ stroke: "var(--color-teal)" }}
			/>
			<text
				className="font-mono font-semibold tabular-nums"
				style={{ fill: "var(--color-foreground)", fontSize: "22px" }}
				textAnchor="middle"
				x={56}
				y={50}
			>
				{display}
			</text>
		</svg>
	);
}
