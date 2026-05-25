#!/usr/bin/env bun

/**
 * Coverage regression gate. Parses `coverage/lcov.info` (produced by
 * `bun test --coverage`) and fails if overall line- or function-coverage
 * drops below a configured floor.
 *
 * Why a separate script instead of Bun's native `coverageThreshold`?
 * `bun test` shares one exit code between test-pass status and coverage
 * status. A single flaky test would mask a coverage regression and vice-
 * versa. Running this gate as its own step gives us a clean signal.
 *
 *   bun run scripts/coverage-gate.ts
 *   bun run scripts/coverage-gate.ts --lcov coverage/lcov.info
 *   bun run scripts/coverage-gate.ts --min-lines 0.85 --min-functions 0.80
 *
 * Exit 0 = at or above floor; 1 = below floor; 2 = bad args / missing file.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseLcov } from "./crap/lcov-parser";

// Floors. Pinned slightly below the current overall coverage so transient
// flake in a single file doesn't trip the gate; raise these as coverage
// climbs. Last measured (2026-05-25): 91.65% lines / 86.96% functions.
const DEFAULT_MIN_LINES = 0.85;
const DEFAULT_MIN_FUNCTIONS = 0.8;
const DEFAULT_LCOV = "coverage/lcov.info";

interface Args {
	lcov: string;
	minFunctions: number;
	minLines: number;
}

function parseArgs(argv: string[]): Args {
	let lcov = DEFAULT_LCOV;
	let minLines = DEFAULT_MIN_LINES;
	let minFunctions = DEFAULT_MIN_FUNCTIONS;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--lcov" && argv[i + 1]) {
			lcov = argv[i + 1] as string;
			i++;
			continue;
		}
		if (arg === "--min-lines" && argv[i + 1]) {
			minLines = Number.parseFloat(argv[i + 1] as string);
			i++;
			continue;
		}
		if (arg === "--min-functions" && argv[i + 1]) {
			minFunctions = Number.parseFloat(argv[i + 1] as string);
			i++;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			console.log(
				"Usage: bun run scripts/coverage-gate.ts [--lcov <path>] [--min-lines <0..1>] [--min-functions <0..1>]"
			);
			process.exit(0);
		}
	}

	if (!Number.isFinite(minLines) || minLines < 0 || minLines > 1) {
		console.error(`Invalid --min-lines: ${minLines} (expected 0..1)`);
		process.exit(2);
	}
	if (!Number.isFinite(minFunctions) || minFunctions < 0 || minFunctions > 1) {
		console.error(`Invalid --min-functions: ${minFunctions} (expected 0..1)`);
		process.exit(2);
	}

	return { lcov, minLines, minFunctions };
}

/**
 * Pull FNF/FNH totals straight from the lcov file. The shared lcov-parser
 * only tracks line hits (it powers the CRAP report), so we do a second pass
 * here rather than expanding the parser's surface for a one-off summary.
 */
async function readFunctionTotals(lcovPath: string): Promise<{ found: number; hit: number }> {
	const text = await Bun.file(lcovPath).text();
	let found = 0;
	let hit = 0;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("FNF:")) {
			const n = Number.parseInt(line.slice(4), 10);
			if (Number.isFinite(n)) {
				found += n;
			}
			continue;
		}
		if (line.startsWith("FNH:")) {
			const n = Number.parseInt(line.slice(4), 10);
			if (Number.isFinite(n)) {
				hit += n;
			}
		}
	}
	return { found, hit };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const lcovPath = resolve(args.lcov);

	if (!existsSync(lcovPath)) {
		console.error(`Coverage gate: lcov file not found at ${lcovPath}`);
		console.error("Run `bun test --coverage` first.");
		process.exit(2);
	}

	const coverage = await parseLcov(lcovPath);

	let totalLines = 0;
	let hitLines = 0;
	for (const file of coverage.values()) {
		for (const hits of file.lineHits.values()) {
			totalLines++;
			if (hits > 0) {
				hitLines++;
			}
		}
	}

	const fnTotals = await readFunctionTotals(lcovPath);

	if (totalLines === 0) {
		console.error("Coverage gate: lcov reports zero executable lines.");
		process.exit(2);
	}
	if (fnTotals.found === 0) {
		console.error("Coverage gate: lcov reports zero functions.");
		process.exit(2);
	}

	const lineRatio = hitLines / totalLines;
	const fnRatio = fnTotals.hit / fnTotals.found;

	const linePct = (lineRatio * 100).toFixed(2);
	const fnPct = (fnRatio * 100).toFixed(2);
	const minLinePct = (args.minLines * 100).toFixed(2);
	const minFnPct = (args.minFunctions * 100).toFixed(2);

	console.log("Coverage gate");
	console.log(`  source     : ${lcovPath}`);
	console.log(`  lines      : ${hitLines}/${totalLines} = ${linePct}% (floor ${minLinePct}%)`);
	console.log(`  functions  : ${fnTotals.hit}/${fnTotals.found} = ${fnPct}% (floor ${minFnPct}%)`);

	const failures: string[] = [];
	if (lineRatio < args.minLines) {
		failures.push(`line coverage ${linePct}% < floor ${minLinePct}%`);
	}
	if (fnRatio < args.minFunctions) {
		failures.push(`function coverage ${fnPct}% < floor ${minFnPct}%`);
	}

	if (failures.length > 0) {
		console.error("");
		console.error("Coverage gate FAILED:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}

	console.log("Coverage gate OK.");
}

main().catch((err) => {
	console.error("Coverage gate crashed:", err);
	process.exit(2);
});
