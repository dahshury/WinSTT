/**
 * Report formatter. Mirrors `examples/crap4java/src/crap4java/ReportFormatter.java`.
 * Renders three views:
 *   - per-file summary (max CRAP, function count over threshold)
 *   - top-N worst offenders (sorted by CRAP descending)
 *   - overall histogram + distribution
 */

import type { FunctionMetric } from "./analyzer";

export interface FormatOptions {
	threshold: number;
	topN: number;
}

export function formatReport(metrics: FunctionMetric[], options: FormatOptions): string {
	const lines: string[] = [];
	const total = metrics.length;
	const withCoverage = metrics.filter((m) => m.crap !== null);
	const overThreshold = withCoverage.filter((m) => (m.crap ?? 0) >= options.threshold);

	lines.push(`# CRAP Analysis (threshold ≥ ${options.threshold})`);
	lines.push("");
	lines.push(`Functions analyzed: ${total}`);
	lines.push(`Functions with coverage data: ${withCoverage.length}`);
	lines.push(`Functions over threshold: ${overThreshold.length}`);
	lines.push("");

	lines.push(`## Top ${options.topN} worst CRAP scores`);
	lines.push("");
	const top = withCoverage.toSorted((a, b) => (b.crap ?? 0) - (a.crap ?? 0)).slice(0, options.topN);
	if (top.length === 0) {
		lines.push("(no functions with coverage data)");
	} else {
		const w = {
			crap: 7,
			cc: 4,
			cov: 6,
			loc: 8,
		};
		lines.push(
			`${pad("CRAP", w.crap)}  ${pad("CC", w.cc)}  ${pad("Cov%", w.cov)}  ${pad("Lines", w.loc)}  Function`
		);
		lines.push("-".repeat(80));
		for (const m of top) {
			const cov = m.coverage === null ? "-" : (m.coverage * 100).toFixed(1);
			lines.push(
				[
					pad((m.crap ?? 0).toFixed(2), w.crap),
					pad(String(m.complexity), w.cc),
					pad(cov, w.cov),
					pad(`${m.startLine}-${m.endLine}`, w.loc),
					`${m.file} :: ${m.name}`,
				].join("  ")
			);
		}
	}

	lines.push("");
	lines.push("## Distribution");
	lines.push("");
	const buckets = [
		{ label: "CRAP < 4 (clean)", lo: 0, hi: 4 },
		{ label: "4 ≤ CRAP < 8", lo: 4, hi: 8 },
		{ label: "8 ≤ CRAP < 30", lo: 8, hi: 30 },
		{ label: "CRAP ≥ 30 (crisis)", lo: 30, hi: Number.POSITIVE_INFINITY },
	];
	for (const b of buckets) {
		const count = withCoverage.filter((m) => {
			const c = m.crap ?? 0;
			return c >= b.lo && c < b.hi;
		}).length;
		const pct = withCoverage.length > 0 ? (100 * count) / withCoverage.length : 0;
		lines.push(`  ${pad(b.label, 22)} ${pad(String(count), 5)}  ${pct.toFixed(1)}%`);
	}

	lines.push("");
	lines.push("## Functions without coverage data");
	const uncovered = metrics.filter((m) => m.coverage === null);
	lines.push(
		`  ${uncovered.length} functions (no executable LCOV lines in span — likely type-only or unreachable)`
	);

	return lines.join("\n");
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}
