#!/usr/bin/env bun

/**
 * Per-domain Stryker driver. Each invocation overrides the `mutate` array
 * with a single source file (or a small batch) and the `command` with a
 * narrowed `bun test` invocation that only runs that file's companion test.
 *
 * Usage:
 *   bun run scripts/stryker-batch.ts <source-file>
 *
 * Stryker config is composed in-memory and emitted as a temp JSON file passed
 * via --configFile so we don't disturb the canonical stryker.conf.json.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function run(): void {
	const sourceFile = process.argv[2];
	if (!sourceFile) {
		console.error("Usage: bun run scripts/stryker-batch.ts <source-file>");
		process.exit(2);
	}
	const projectRoot = resolve(import.meta.dir, "..");
	const testFile = sourceFile.replace(/\.ts$/, ".test.ts");
	const reportSlug = sourceFile.replace(/[\\/]/g, "_").replace(/\.ts$/, "");

	const config = {
		$schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
		packageManager: "npm",
		reporters: ["progress", "clear-text", "json"],
		jsonReporter: { fileName: `reports/mutation/per-file/${reportSlug}.json` },
		testRunner: "command",
		commandRunner: { command: `bun test ${testFile}` },
		coverageAnalysis: "off",
		mutate: [sourceFile],
		thresholds: { high: 90, low: 70, break: 0 },
		timeoutMS: 30_000,
		concurrency: 1,
		tempDirName: `.stryker-tmp/${reportSlug}`,
		// Exclude heavy build output and prior sandbox leftovers from the copy.
		// Without this, the sandbox copies the 731MB Next.js build dir AND any
		// leftover .stryker-tmp/<slug> from previous batch runs, leading to
		// path-too-long ENOENT errors on Windows.
		ignorePatterns: [
			"out",
			".next",
			"dist",
			".stryker-tmp",
			"reports",
			"playwright-report",
			"test-results",
			"node_modules/.cache",
		],
	};

	mkdirSync(resolve(projectRoot, "reports/mutation/per-file"), { recursive: true });
	mkdirSync(resolve(projectRoot, "reports/mutation/per-file/configs"), { recursive: true });
	const cfgPath = resolve(projectRoot, `reports/mutation/per-file/configs/${reportSlug}.json`);
	writeFileSync(cfgPath, JSON.stringify(config, null, 2));

	const result = spawnSync("bunx", ["stryker", "run", cfgPath], {
		cwd: projectRoot,
		stdio: "inherit",
		shell: true,
	});
	process.exit(result.status ?? 1);
}

run();
