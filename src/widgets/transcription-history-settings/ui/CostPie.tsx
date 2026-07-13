import type { CostSlice } from "../lib/cost-analytics";
import { formatUsd } from "../lib/word-stats";

interface CostPieProps {
	slices: CostSlice[];
	/** Big value in the donut hole (e.g. the total spend). */
	centerValue: string;
	/** Muted caption under the center value. */
	centerLabel: string;
	/** Accessible name for the chart. */
	ariaLabel: string;
}

const SIZE = 132;
const CENTER = SIZE / 2;
const RADIUS = 46;
const STROKE = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// A hair of track shows between wedges so adjacent same-family teal fades stay
// distinguishable; a lone full-ring slice skips it (no seam on a single wedge).
const GAP = 2;

/**
 * A donut breakdown of spend — one wedge per {@link CostSlice}, sized to its
 * exact share (rounded percentages only label the legend, never the geometry),
 * with the total in the hole and a value/percent legend below. Bespoke SVG on
 * the design tokens, matching the dashboard's other hand-rolled charts. Renders
 * nothing when there's no spend, so the caller can hide the surrounding card.
 */
export function CostPie({
	slices,
	centerValue,
	centerLabel,
	ariaLabel,
}: CostPieProps) {
	const total = slices.reduce((sum, s) => sum + s.cost, 0);
	if (total <= 0 || slices.length === 0) {
		return null;
	}

	const single = slices.length === 1;
	// Each wedge's start offset is the cumulative circumference of the slices
	// before it. Computed as a pure prefix-sum per slice (no closure `let`
	// reassigned across the render) — the slice count is a handful, so the
	// nested sum is negligible.
	const arcs = slices.map((slice, index) => {
		const fraction = slice.cost / total;
		const gap = single ? 0 : GAP;
		const startFraction =
			slices.slice(0, index).reduce((sum, s) => sum + s.cost, 0) / total;
		return {
			slice,
			dash: Math.max(0, fraction * CIRCUMFERENCE - gap),
			// Circles start at 3 o'clock; rotate -90° (via the group) to start at 12.
			dashOffset: -startFraction * CIRCUMFERENCE,
		};
	});

	return (
		<div className="flex flex-col items-center gap-3">
			<svg
				aria-label={ariaLabel}
				height={SIZE}
				role="img"
				viewBox={`0 0 ${SIZE} ${SIZE}`}
				width={SIZE}
			>
				{/* Track ring under the wedges keeps the donut whole at tiny shares. */}
				<circle
					cx={CENTER}
					cy={CENTER}
					fill="none"
					r={RADIUS}
					stroke="var(--color-surface-5)"
					strokeWidth={STROKE}
				/>
				<g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
					{arcs.map(({ slice, dash, dashOffset }) => (
						<circle
							cx={CENTER}
							cy={CENTER}
							fill="none"
							key={slice.key}
							r={RADIUS}
							stroke={slice.color}
							strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
							strokeDashoffset={dashOffset}
							strokeWidth={STROKE}
						>
							<title>{`${slice.label} · ${slice.estimate ? "~" : ""}${formatUsd(slice.cost) ?? ""} (${slice.pct}%)`}</title>
						</circle>
					))}
				</g>
				<text
					className="font-mono font-semibold tabular-nums"
					style={{ fill: "var(--color-foreground)", fontSize: "16px" }}
					textAnchor="middle"
					x={CENTER}
					y={CENTER - 1}
				>
					{centerValue}
				</text>
				<text
					className="font-mono uppercase tracking-wide"
					style={{
						fill: "var(--color-foreground-muted)",
						fontSize: "var(--text-body-sm)",
					}}
					textAnchor="middle"
					x={CENTER}
					y={CENTER + 12}
				>
					{centerLabel}
				</text>
			</svg>
			<ul className="flex w-full flex-col gap-1.5">
				{slices.map((slice) => (
					<li className="flex items-center gap-2 text-xs-tight" key={slice.key}>
						<span
							aria-hidden
							className="size-2.5 shrink-0 rounded-[3px]"
							style={{ backgroundColor: slice.color }}
						/>
						<span className="min-w-0 flex-1 truncate text-foreground-secondary">
							{slice.label}
						</span>
						<span className="shrink-0 font-mono text-foreground tabular-nums">
							{slice.estimate ? "~" : ""}
							{formatUsd(slice.cost)}
						</span>
						<span className="w-9 shrink-0 text-end font-mono text-2xs text-foreground-muted tabular-nums">
							{slice.pct}%
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}
