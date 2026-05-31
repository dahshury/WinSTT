#!/usr/bin/env bun

/**
 * CRAP regression gate. Compares two crap.json reports and fails if any
 * function's CRAP score regressed beyond MAX_INCREASE (default 0).
 *
 *   bun run scripts/crap-gate.ts <baseline.json> <current.json>
 *   bun run scripts/crap-gate.ts <baseline.json> <current.json> --max-increase 0.5
 *   bun run scripts/crap-gate.ts <current.json> --summary-only
 *
 * Exit 0 = clean (or baseline missing on first run); 1 = regression; 2 = bad args.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface CrapEntry {
	complexity: number;
	coverage: number;
	crap: number;
	endLine: number;
	file: string;
	name: string;
	startLine: number;
}

interface Args {
	baseline: string | null;
	current: string | null;
	maxIncrease: number;
	summaryOnly: boolean;
}

interface Regression {
	baselineCrap: number;
	currentCrap: number;
	delta: number;
	file: string;
	name: string;
	startLine: number;
}

const USAGE = `bun run scripts/crap-gate.ts <baseline.json> <current.json> [options]

  --max-increase <n>   Tolerated CRAP delta per function (default 0)
  --summary-only       Print totals only; do not gate (single file arg ok)
  -h, --help           Show this help
`;

function parseArgs(argv: string[]): Args {
	const args: Args = {
		baseline: null,
		current: null,
		maxIncrease: 0,
		summaryOnly: false,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--max-increase") {
			args.maxIncrease = Number.parseFloat(argv[++i] ?? "0");
		} else if (a === "--summary-only") {
			args.summaryOnly = true;
		} else if (a === "--help" || a === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else if (a !== undefined && !a.startsWith("--")) {
			positional.push(a);
		}
	}
	if (args.summaryOnly && positional.length === 1) {
		args.current = positional[0] ?? null;
	} else {
		args.baseline = positional[0] ?? null;
		args.current = positional[1] ?? null;
	}
	return args;
}

function readReport(path: string): CrapEntry[] {
	const raw = readFileSync(path, "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error(`Expected array in ${path}`);
	}
	return parsed as CrapEntry[];
}

function keyOf(entry: CrapEntry): string {
	return `${entry.file}::${entry.name}::${entry.startLine}`;
}

function indexBy(entries: CrapEntry[]): Map<string, CrapEntry> {
	const map = new Map<string, CrapEntry>();
	for (const e of entries) map.set(keyOf(e), e);
	return map;
}

function pad(v: string, w: number): string {
	return v.length >= w ? v : v + " ".repeat(w - v.length);
}

function fmtNum(n: number | null | undefined): string {
	// CRAP can be null for "no coverage data" functions (type-only / unreachable
	// spans). Guard so the regression table never crashes on `null.toFixed`.
	if (typeof n !== "number" || !Number.isFinite(n)) {
		return "n/a";
	}
	return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function printRegressionTable(rows: Regression[]): void {
	const headers = ["file", "name", "line", "baseline", "current", "delta"];
	const data = rows.map((r) => [
		r.file,
		r.name,
		String(r.startLine),
		fmtNum(r.baselineCrap),
		fmtNum(r.currentCrap),
		`+${fmtNum(r.delta)}`,
	]);
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...data.map((row) => (row[i] ?? "").length))
	);
	console.log(headers.map((h, i) => pad(h, widths[i] ?? 0)).join(" | "));
	console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
	for (const row of data) console.log(row.map((c, i) => pad(c, widths[i] ?? 0)).join(" | "));
}

function printSummary(entries: CrapEntry[]): void {
	const total = entries.length;
	const sum = entries.reduce((acc, e) => acc + e.crap, 0);
	console.log("CRAP summary");
	console.log(`  total functions:    ${total}`);
	console.log(`  crap > 30:          ${entries.filter((e) => e.crap > 30).length}`);
	console.log(`  crap > 10:          ${entries.filter((e) => e.crap > 10).length}`);
	console.log(`  crap > 5:           ${entries.filter((e) => e.crap > 5).length}`);
	console.log(`  coverage == 0:      ${entries.filter((e) => e.coverage === 0).length}`);
	console.log(`  mean crap:          ${total > 0 ? fmtNum(sum / total) : "0"}`);
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const root = resolve(import.meta.dir, "..");

	if (args.summaryOnly) {
		if (!args.current) {
			console.error(`--summary-only requires one positional file arg\n${USAGE}`);
			process.exit(2);
		}
		const path = resolve(root, args.current);
		if (!existsSync(path)) {
			console.error(`File not found: ${path}`);
			process.exit(2);
		}
		printSummary(readReport(path));
		process.exit(0);
	}

	if (!(args.baseline && args.current)) {
		console.error(`Missing arguments. Need <baseline.json> <current.json>.\n${USAGE}`);
		process.exit(2);
	}

	const baselinePath = resolve(root, args.baseline);
	const currentPath = resolve(root, args.current);

	if (!existsSync(currentPath)) {
		console.error(`Current report not found: ${currentPath}`);
		process.exit(2);
	}
	if (!existsSync(baselinePath)) {
		console.log(`Baseline not found at ${baselinePath} — skipping gate (first run).`);
		process.exit(0);
	}

	const baseline = readReport(baselinePath);
	const current = readReport(currentPath);
	const baselineIdx = indexBy(baseline);

	const regressions: Regression[] = [];
	const newRisky: CrapEntry[] = [];
	for (const e of current) {
		const prev = baselineIdx.get(keyOf(e));
		if (!prev) {
			if (Number.isFinite(e.crap) && e.crap > 5) newRisky.push(e);
			continue;
		}
		// A null/NaN CRAP means "no coverage data" (type-only / unreachable span)
		// — not comparable for regression. Skip rather than treat null as 0,
		// which previously fabricated bogus regressions and crashed fmtNum.
		if (!(Number.isFinite(e.crap) && Number.isFinite(prev.crap))) {
			continue;
		}
		const delta = e.crap - prev.crap;
		if (delta > args.maxIncrease) {
			regressions.push({
				baselineCrap: prev.crap,
				currentCrap: e.crap,
				delta,
				file: e.file,
				name: e.name,
				startLine: e.startLine,
			});
		}
	}
	regressions.sort((a, b) => b.delta - a.delta);

	if (newRisky.length > 0) {
		console.log(`Note: ${newRisky.length} new function(s) with crap > 5 (informational):`);
		for (const e of newRisky.slice(0, 10))
			console.log(`  ${e.file}::${e.name} (crap ${fmtNum(e.crap)})`);
		if (newRisky.length > 10) console.log(`  ... and ${newRisky.length - 10} more`);
		console.log("");
	}

	if (regressions.length === 0) {
		console.log(`OK — no CRAP regressions (tolerance +${fmtNum(args.maxIncrease)}).`);
		process.exit(0);
	}

	console.log(`FAIL — ${regressions.length} CRAP regression(s):\n`);
	printRegressionTable(regressions);
	process.exit(1);
}

main();
