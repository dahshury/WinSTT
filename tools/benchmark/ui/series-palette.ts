// Categorical, non-green palette shared across the benchmark charts. Model
// series map to a stable color by index (wraps around when there are more
// series than colors).

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
