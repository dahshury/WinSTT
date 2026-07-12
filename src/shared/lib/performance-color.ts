/**
 * Map a 0..1 performance score to the shared red→amber→green health-bar color.
 * Higher is better, so a fast-but-sloppy model shows a high speed bar over a low
 * accuracy bar. The single source of truth for BOTH the model-picker card perf
 * bars (`CardPerf`) and the hover spec card's perf bars (`ModelSpecCard`) so the
 * two read identically — accuracy/speed look the same wherever they appear.
 */
export function performanceScoreColor(score: number): string {
	const t = Math.max(0, Math.min(1, score));
	if (t < 0.5) {
		const lowPct = Math.round((1 - t * 2) * 100);
		return `color-mix(in oklch, var(--color-performance-low) ${lowPct}%, var(--color-performance-mid))`;
	}
	const midPct = Math.round((1 - (t - 0.5) * 2) * 100);
	return `color-mix(in oklch, var(--color-performance-mid) ${midPct}%, var(--color-performance-high))`;
}
