#!/usr/bin/env bun

/**
 * Entrypoint for the CRAP analyzer. Mirrors
 * `examples/crap4java/src/crap4java/Main.java`.
 *
 * Pipeline:
 *   1. Run `bun test --coverage --coverage-reporter=lcov` (refresh LCOV)
 *      unless --skip-coverage is passed.
 *   2. Parse coverage/lcov.info → per-file per-line hit map.
 *   3. Walk every TS/TSX source file under src/ + electron/ (excluding
 *      tests, .d.ts, and the Stryker reports tree), computing per-function
 *      cyclomatic complexity from the TS AST.
 *   4. For each function, derive line coverage from LCOV and compute
 *      CRAP = CC^2 * (1 - cov)^3 + CC.
 *   5. Print a report and exit non-zero if --strict and any function is
 *      at or above the threshold (default 4).
 *
 * Usage:
 *   bun run scripts/crap.ts                      # full analysis, threshold 4
 *   bun run scripts/crap.ts --threshold 8        # CRAP < 8 instead
 *   bun run scripts/crap.ts --top 50             # show 50 worst offenders
 *   bun run scripts/crap.ts --skip-coverage      # reuse existing LCOV
 *   bun run scripts/crap.ts --strict             # exit 1 if any over threshold
 *   bun run scripts/crap.ts --json out.json      # also emit JSON report
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { analyze, type FunctionMetric, readBiomeLinterDisabledPaths } from "./crap/analyzer";
import { formatReport } from "./crap/formatter";
import { parseLcov } from "./crap/lcov-parser";

interface Args {
	jsonOut: string | null;
	skipCoverage: boolean;
	strict: boolean;
	threshold: number;
	topN: number;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		threshold: 4,
		topN: 25,
		skipCoverage: false,
		strict: false,
		jsonOut: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--threshold") args.threshold = Number.parseFloat(argv[++i] ?? "4");
		else if (a === "--top") args.topN = Number.parseInt(argv[++i] ?? "25", 10);
		else if (a === "--skip-coverage") args.skipCoverage = true;
		else if (a === "--strict") args.strict = true;
		else if (a === "--json") args.jsonOut = argv[++i] ?? null;
		else if (a === "--help" || a === "-h") {
			console.log(USAGE);
			process.exit(0);
		}
	}
	return args;
}

const USAGE = `bun run scripts/crap.ts [options]

  --threshold <n>     Threshold for "over CRAP" (default 4)
  --top <n>           Show N worst offenders (default 25)
  --skip-coverage     Reuse existing coverage/lcov.info (don't re-run tests)
  --strict            Exit code 1 if any function ≥ threshold
  --json <path>       Also emit a JSON report
`;

async function main(): Promise<void> {
	const root = resolve(import.meta.dir, "..");
	const args = parseArgs(process.argv.slice(2));

	if (!args.skipCoverage) {
		console.log("Running test suite with coverage…");
		const result = spawnSync("bun", ["test", "--coverage", "--coverage-reporter=lcov"], {
			cwd: root,
			stdio: ["ignore", "ignore", "inherit"],
			shell: process.platform === "win32",
		});
		if (result.status !== 0) {
			console.error(`bun test exited with code ${result.status}`);
			process.exit(1);
		}
	}

	const lcovPath = resolve(root, "coverage/lcov.info");
	const lcov = await parseLcov(lcovPath);

	const biomeDisabled = await readBiomeLinterDisabledPaths(root);
	if (biomeDisabled.length > 0) {
		console.log(
			`Excluding ${biomeDisabled.length} biome-linter-disabled path(s):\n  ${biomeDisabled.join("\n  ")}`
		);
	}

	const metrics: FunctionMetric[] = await analyze(root, lcov, {
		roots: ["src", "electron"],
		include: /\.tsx?$/,
		exclude: /(?:\.test\.|\.spec\.|\.d\.|\.stories\.)tsx?$/,
		excludePaths: biomeDisabled,
	});

	const report = formatReport(metrics, {
		threshold: args.threshold,
		topN: args.topN,
	});
	console.log(report);

	if (args.jsonOut) {
		await Bun.write(resolve(root, args.jsonOut), `${JSON.stringify(metrics, null, 2)}\n`);
	}

	if (args.strict) {
		const overThreshold = metrics.filter((m) => (m.crap ?? 0) >= args.threshold);
		if (overThreshold.length > 0) {
			console.error(`\nFAIL: ${overThreshold.length} functions ≥ CRAP ${args.threshold}`);
			process.exit(1);
		}
	}
}

await main();
