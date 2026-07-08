// Bespoke SVG charts for the benchmark results, matching the app's no-chart-lib
// convention. Model series use a categorical, non-green palette; the heatmap is
// monochrome teal intensity (value is never encoded as green=good/red=bad).

export const SERIES = [
	"var(--color-activity)",
	"#f59e0b",
	"#a78bfa",
	"#ec4899",
	"#22d3ee",
	"#f472b6",
	"#facc15",
	"#818cf8",
];

export function seriesColor(i: number): string {
	return SERIES[i % SERIES.length]!;
}

function niceCeil(v: number): number {
	if (v <= 0) return 1;
	const mag = 10 ** Math.floor(Math.log10(v));
	const n = v / mag;
	const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
	return step * mag;
}

// ── matrix heatmap: rows (modifiers) × cols (models) ────────────────────────

export function Heatmap(props: {
	rows: string[];
	cols: string[];
	value: (row: string, col: string) => number | null;
	max?: number;
}) {
	const { rows, cols } = props;
	const max = props.max ?? 100;
	const cellW = 96;
	const cellH = 30;
	const labelW = 140;
	const headerH = 26;
	const w = labelW + cols.length * cellW + 8;
	const h = headerH + rows.length * cellH + 6;
	return (
		<svg
			viewBox={`0 0 ${w} ${h}`}
			width="100%"
			style={{ maxWidth: w }}
			className="font-mono"
		>
			{cols.map((c, i) => (
				<text
					key={c}
					x={labelW + i * cellW + cellW / 2}
					y={17}
					textAnchor="middle"
					fill="var(--color-foreground-muted)"
					fontSize={11}
				>
					{shorten(c, 16)}
				</text>
			))}
			{rows.map((r, ri) =>
				cols.map((c, ci) => {
					const v = props.value(r, c);
					const alpha = v === null ? 0 : 0.12 + (v / max) * 0.78;
					const y = headerH + ri * cellH;
					return (
						<g key={`${r}:${c}`}>
							{ci === 0 && (
								<text
									x={labelW - 8}
									y={y + cellH / 2 + 4}
									textAnchor="end"
									fill="var(--color-foreground)"
									fontSize={11.5}
								>
									{r}
								</text>
							)}
							<rect
								x={labelW + ci * cellW + 2}
								y={y + 2}
								width={cellW - 4}
								height={cellH - 4}
								rx={4}
								fill={
									v === null
										? "var(--color-surface-elevated)"
										: "var(--color-activity)"
								}
								fillOpacity={v === null ? 1 : alpha}
							/>
							<text
								x={labelW + ci * cellW + cellW / 2}
								y={y + cellH / 2 + 4}
								textAnchor="middle"
								fontSize={11.5}
								fill={
									v !== null && alpha > 0.55
										? "#08131a"
										: "var(--color-foreground)"
								}
							>
								{v === null ? "·" : v.toFixed(0)}
							</text>
						</g>
					);
				}),
			)}
		</svg>
	);
}

// ── vertical grouped bars: groups (modifiers), series (models) ──────────────

export function GroupedBars(props: {
	groups: string[];
	series: string[];
	value: (group: string, series: string) => number | null;
	max?: number;
	unit?: string;
}) {
	const { groups, series } = props;
	const rawMax =
		props.max ??
		Math.max(
			1,
			...groups.flatMap((g) => series.map((s) => props.value(g, s) ?? 0)),
		);
	const max = niceCeil(rawMax);
	const padL = 40;
	const padB = 76;
	const padT = 10;
	const groupW = Math.max(64, series.length * 18 + 22);
	const w = padL + groups.length * groupW + 10;
	const h = 232;
	const plotH = h - padB - padT;
	const barW = (groupW - 18) / series.length;
	return (
		<svg
			viewBox={`0 0 ${w} ${h}`}
			width="100%"
			style={{ maxWidth: w }}
			className="font-mono"
		>
			{[0, 1, 2, 3, 4].map((g) => {
				const v = (max / 4) * g;
				const y = padT + plotH - (v / max) * plotH;
				return (
					<g key={g}>
						<line
							x1={padL}
							y1={y}
							x2={w - 6}
							y2={y}
							stroke="var(--color-surface-5)"
							strokeWidth={1}
						/>
						<text
							x={padL - 5}
							y={y + 3}
							textAnchor="end"
							fill="var(--color-foreground-muted)"
							fontSize={9.5}
						>
							{v.toFixed(0)}
						</text>
					</g>
				);
			})}
			{groups.map((group, gi) => {
				const gx = padL + gi * groupW + 9;
				return (
					<g key={group}>
						<text
							x={gx + (groupW - 18) / 2}
							y={h - padB + 13}
							textAnchor="start"
							fill="var(--color-foreground)"
							fontSize={10}
							transform={`rotate(35 ${gx + (groupW - 18) / 2} ${h - padB + 13})`}
						>
							{group}
						</text>
						{series.map((s, si) => {
							const v = props.value(group, s);
							if (v === null) return null;
							const bh = Math.max(1, (v / max) * plotH);
							const x = gx + si * barW;
							const y = padT + plotH - bh;
							return (
								<rect
									key={s}
									x={x}
									y={y}
									width={barW - 2}
									height={bh}
									rx={2}
									fill={seriesColor(si)}
								>
									<title>{`${group} · ${s}: ${v.toFixed(1)}${props.unit ?? ""}`}</title>
								</rect>
							);
						})}
					</g>
				);
			})}
		</svg>
	);
}

// ── scatter: surface Δ (x) vs semantic Δ (y) ────────────────────────────────

export interface ScatterPoint {
	x: number;
	y: number;
	label: string;
	seriesIndex: number;
}

export function Scatter(props: {
	points: ScatterPoint[];
	xThreshold?: number;
	yThreshold?: number;
}) {
	const { points } = props;
	const padL = 44;
	const padB = 38;
	const padT = 10;
	const w = 640;
	const h = 360;
	const plotW = w - padL - 14;
	const plotH = h - padB - padT;
	const yMax = niceCeil(Math.max(0.3, ...points.map((p) => p.y)) * 1.1);
	const xT = props.xThreshold ?? 0.15;
	const yT = props.yThreshold ?? 0.12;
	const sx = (v: number) => padL + Math.min(1, v) * plotW;
	const sy = (v: number) => padT + plotH - (v / yMax) * plotH;
	return (
		<svg
			viewBox={`0 0 ${w} ${h}`}
			width="100%"
			style={{ maxWidth: w }}
			className="font-mono"
		>
			<line
				x1={sx(xT)}
				y1={padT}
				x2={sx(xT)}
				y2={padT + plotH}
				stroke="var(--color-surface-5)"
				strokeDasharray="4 4"
			/>
			<line
				x1={padL}
				y1={sy(yT)}
				x2={padL + plotW}
				y2={sy(yT)}
				stroke="var(--color-surface-5)"
				strokeDasharray="4 4"
			/>
			<text
				x={sx(xT) + 6}
				y={padT + 11}
				fill="var(--color-foreground-muted)"
				fontSize={9.5}
			>
				clean restyle →
			</text>
			<text
				x={sx(xT) + 6}
				y={sy(yT) - 5}
				fill="var(--color-foreground-muted)"
				fontSize={9.5}
			>
				meaning drift ↑
			</text>
			<text
				x={padL + 3}
				y={padT + plotH - 4}
				fill="var(--color-foreground-muted)"
				fontSize={9.5}
			>
				← no-op
			</text>
			{[0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => (
				<text
					key={v}
					x={sx(v)}
					y={h - padB + 15}
					textAnchor="middle"
					fill="var(--color-foreground-muted)"
					fontSize={9.5}
				>
					{v.toFixed(1)}
				</text>
			))}
			{[0, 1, 2, 3, 4].map((g) => {
				const v = (yMax / 4) * g;
				return (
					<text
						key={g}
						x={padL - 5}
						y={sy(v) + 3}
						textAnchor="end"
						fill="var(--color-foreground-muted)"
						fontSize={9.5}
					>
						{v.toFixed(2)}
					</text>
				);
			})}
			<text
				x={padL + plotW / 2}
				y={h - 5}
				textAnchor="middle"
				fill="var(--color-foreground-muted)"
				fontSize={10.5}
			>
				surface Δ (wording changed)
			</text>
			<text
				transform={`translate(11 ${padT + plotH / 2}) rotate(-90)`}
				textAnchor="middle"
				fill="var(--color-foreground-muted)"
				fontSize={10.5}
			>
				semantic Δ (meaning moved)
			</text>
			{points.map((p, i) => (
				<circle
					key={`${p.label}:${i}`}
					cx={sx(p.x)}
					cy={sy(p.y)}
					r={5}
					fill={seriesColor(p.seriesIndex)}
					fillOpacity={0.85}
					stroke="#08131a"
					strokeWidth={0.5}
				>
					<title>{`${p.label}\nΔs ${p.x.toFixed(2)} · Δm ${p.y.toFixed(2)}`}</title>
				</circle>
			))}
		</svg>
	);
}

// ── radar: N axes (rubric criteria), one polygon per model ──────────────────

export function RubricRadar(props: {
	axes: string[];
	series: { label: string; values: number[]; seriesIndex: number }[];
	max?: number;
}) {
	const { axes, series } = props;
	const max = props.max ?? 100;
	const size = 260;
	const cx = size / 2;
	const cy = size / 2 + 6;
	const radius = 86;
	const angleFor = (i: number) => (Math.PI * 2 * i) / axes.length - Math.PI / 2;
	const point = (i: number, r: number) =>
		[cx + Math.cos(angleFor(i)) * r, cy + Math.sin(angleFor(i)) * r] as const;
	return (
		<svg
			viewBox={`0 0 ${size} ${size + 18}`}
			width="100%"
			style={{ maxWidth: size }}
			className="font-mono"
		>
			{[0.33, 0.66, 1].map((ring) => (
				<polygon
					key={ring}
					points={axes
						.map((_, i) => point(i, radius * ring).join(","))
						.join(" ")}
					fill="none"
					stroke="var(--color-surface-5)"
					strokeWidth={1}
				/>
			))}
			{axes.map((axis, i) => {
				const [x, y] = point(i, radius);
				const [lx, ly] = point(i, radius + 16);
				return (
					<g key={axis}>
						<line
							x1={cx}
							y1={cy}
							x2={x}
							y2={y}
							stroke="var(--color-surface-5)"
							strokeWidth={1}
						/>
						<text
							x={lx}
							y={ly}
							textAnchor="middle"
							fill="var(--color-foreground-muted)"
							fontSize={9}
						>
							{axis}
						</text>
					</g>
				);
			})}
			{series.map((s) => {
				const pts = s.values
					.map((v, i) =>
						point(i, (Math.max(0, Math.min(max, v)) / max) * radius).join(","),
					)
					.join(" ");
				const color = seriesColor(s.seriesIndex);
				return (
					<polygon
						key={s.label}
						points={pts}
						fill={color}
						fillOpacity={0.14}
						stroke={color}
						strokeWidth={1.5}
					/>
				);
			})}
		</svg>
	);
}

function shorten(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
