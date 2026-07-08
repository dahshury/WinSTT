import type { AuthorSlice } from "../lib/author-usage";

interface ModelAuthorRadarProps {
	slices: AuthorSlice[];
	/** Accessible name for the whole chart. Defaults to the usage-by-maker label. */
	ariaLabel?: string;
	/**
	 * Renders each axis's hover title. Defaults to `label · count (pct%)` for the
	 * usage radar; the cost radar passes a `$`-formatting variant. `count` carries
	 * the axis magnitude (a run count for usage, a USD amount for cost).
	 */
	formatTitle?: (slice: AuthorSlice) => string;
}

function defaultTitle(slice: AuthorSlice): string {
	return `${slice.label} · ${slice.count} (${slice.pct}%)`;
}

const SIZE = 190;
const CENTER = SIZE / 2;
// Outer grid radius; logos ride a ring just outside it so they never depend on a
// maker's share to be placed — the whole point of switching off the pie.
const RADIUS = 60;
const LOGO_RING = 78;
const LOGO = 20;
const GRID_LEVELS = 3;
const DOT_R = 3;
// A radar needs a polygon: below three makers it degenerates to a dot/line, so
// we render nothing and let the model bars carry those cases.
const MIN_AXES = 3;

function polar(radius: number, angleDeg: number): [number, number] {
	const a = ((angleDeg - 90) * Math.PI) / 180;
	return [CENTER + radius * Math.cos(a), CENTER + radius * Math.sin(a)];
}

function ringPoints(axes: { angle: number }[], radius: number): string {
	return axes
		.map(({ angle }) => {
			const [x, y] = polar(radius, angle);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
}

/**
 * A compact radar of transcription usage by model maker — one axis per maker,
 * evenly spaced, labelled with the maker's brand logo at the rim. Because axis
 * positions are fixed, a dominant maker just stretches its spoke while every
 * logo stays visible (unlike the pie, whose slivers couldn't hold a mark).
 * Renders nothing below {@link MIN_AXES} makers or when no maker carries a logo.
 */
export function ModelAuthorRadar({
	slices,
	ariaLabel = "Transcription usage by model maker",
	formatTitle = defaultTitle,
}: ModelAuthorRadarProps) {
	if (slices.length < MIN_AXES || slices.every((s) => !s.logoSrc)) {
		return null;
	}
	const maxCount = Math.max(...slices.map((s) => s.count));
	if (maxCount === 0) {
		return null;
	}

	const axes = slices.map((slice, i) => {
		const angle = i * (360 / slices.length);
		const [vx, vy] = polar((slice.count / maxCount) * RADIUS, angle);
		const [lx, ly] = polar(LOGO_RING, angle);
		return { slice, angle, vx, vy, lx, ly };
	});
	const dataPoints = axes
		.map(({ vx, vy }) => `${vx.toFixed(1)},${vy.toFixed(1)}`)
		.join(" ");

	return (
		<svg
			aria-label={ariaLabel}
			className="shrink-0"
			height={SIZE}
			role="img"
			viewBox={`0 0 ${SIZE} ${SIZE}`}
			width={SIZE}
		>
			{Array.from({ length: GRID_LEVELS }, (_, level) => (
				<polygon
					fill="none"
					key={level}
					points={ringPoints(axes, (RADIUS * (level + 1)) / GRID_LEVELS)}
					stroke="var(--color-divider)"
					strokeWidth={1}
				/>
			))}
			{axes.map(({ slice, angle }) => {
				const [gx, gy] = polar(RADIUS, angle);
				return (
					<line
						key={`spoke-${slice.key}`}
						stroke="var(--color-divider)"
						strokeWidth={1}
						x1={CENTER}
						x2={gx}
						y1={CENTER}
						y2={gy}
					/>
				);
			})}
			<polygon
				fill="var(--color-activity)"
				fillOpacity={0.16}
				points={dataPoints}
				stroke="var(--color-activity)"
				strokeWidth={2}
			/>
			{axes.map(({ slice, vx, vy, lx, ly }) => (
				<g key={slice.key}>
					<title>{formatTitle(slice)}</title>
					<circle cx={vx} cy={vy} fill="var(--color-activity)" r={DOT_R} />
					{slice.logoSrc ? (
						// White-silhouette the mixed-fill provider marks so they read
						// on the dark panel — matches the app's monochrome convention.
						<image
							height={LOGO}
							href={slice.logoSrc}
							preserveAspectRatio="xMidYMid meet"
							style={{ filter: "brightness(0) invert(1)" }}
							width={LOGO}
							x={lx - LOGO / 2}
							y={ly - LOGO / 2}
						/>
					) : (
						<circle
							cx={lx}
							cy={ly}
							fill="none"
							r={3.5}
							stroke="var(--color-foreground-muted)"
							strokeWidth={1.5}
						/>
					)}
				</g>
			))}
		</svg>
	);
}
