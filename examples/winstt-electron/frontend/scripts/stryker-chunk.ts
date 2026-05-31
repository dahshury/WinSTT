#!/usr/bin/env bun

/**
 * Sequentially mutation-tests a chunk of source files via stryker-batch.ts.
 * Aggregates surviving mutants per file into a single JSON summary and a
 * human-readable text summary.
 *
 * Usage:
 *   bun run scripts/stryker-chunk.ts <chunk-name> <source-file-1> [source-file-2 ...]
 *
 * Outputs:
 *   reports/mutation/chunks/<chunk-name>.summary.json
 *   reports/mutation/chunks/<chunk-name>.summary.txt
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface MutantResult {
	id: string;
	location: { start: { line: number; column: number } };
	mutatorName: string;
	replacement?: string;
	status: string;
}

interface FileResult {
	mutants: MutantResult[];
	source: string;
}

interface StrykerJson {
	files: Record<string, FileResult>;
}

interface FileSummary {
	file: string;
	killed: number;
	noCoverage: number;
	score: number;
	survived: number;
	survivors: { line: number; mutator: string; replacement: string }[];
	timedOut: number;
}

function loadFileReport(reportPath: string): StrykerJson | null {
	try {
		return JSON.parse(readFileSync(reportPath, "utf-8")) as StrykerJson;
	} catch {
		return null;
	}
}

function summarize(file: string, report: StrykerJson | null): FileSummary {
	const summary: FileSummary = {
		file,
		killed: 0,
		survived: 0,
		timedOut: 0,
		noCoverage: 0,
		score: 0,
		survivors: [],
	};
	if (!report) return summary;
	for (const fr of Object.values(report.files)) {
		for (const m of fr.mutants) {
			if (m.status === "Killed") summary.killed += 1;
			else if (m.status === "Survived") {
				summary.survived += 1;
				summary.survivors.push({
					line: m.location.start.line,
					mutator: m.mutatorName,
					replacement: (m.replacement ?? "").slice(0, 80),
				});
			} else if (m.status === "Timeout") summary.timedOut += 1;
			else if (m.status === "NoCoverage") summary.noCoverage += 1;
		}
	}
	const total = summary.killed + summary.survived + summary.timedOut;
	summary.score = total === 0 ? 100 : (100 * (summary.killed + summary.timedOut)) / total;
	return summary;
}

function run(): void {
	const [, , chunkName, ...sourceFiles] = process.argv;
	if (!chunkName || sourceFiles.length === 0) {
		console.error(
			"Usage: bun run scripts/stryker-chunk.ts <chunk-name> <source-file-1> [source-file-2 ...]"
		);
		process.exit(2);
	}
	const projectRoot = resolve(import.meta.dir, "..");
	mkdirSync(resolve(projectRoot, "reports/mutation/chunks"), { recursive: true });

	const summaries: FileSummary[] = [];
	for (let i = 0; i < sourceFiles.length; i++) {
		const f = sourceFiles[i] ?? "";
		console.log(`\n[${i + 1}/${sourceFiles.length}] ${f}`);
		const result = spawnSync("bun", ["run", "scripts/stryker-batch.ts", f], {
			cwd: projectRoot,
			stdio: "inherit",
			shell: true,
		});
		const reportPath = resolve(
			projectRoot,
			"reports/mutation/per-file",
			`${f.replace(/[\\/]/g, "_").replace(/\.ts$/, "")}.json`
		);
		const report = loadFileReport(reportPath);
		const s = summarize(f, report);
		summaries.push(s);
		if (result.status !== 0 && !report) {
			console.warn(`  ⚠ stryker exit ${result.status} and no report — skipping`);
		}
	}

	summaries.sort((a, b) => a.score - b.score);

	const summaryJson = resolve(projectRoot, `reports/mutation/chunks/${chunkName}.summary.json`);
	writeFileSync(summaryJson, JSON.stringify(summaries, null, 2));

	const lines: string[] = [];
	lines.push(`# Mutation summary: ${chunkName}`);
	lines.push("");
	lines.push("score%   killed survived timeout file");
	lines.push("---------------------------------------------------------------");
	for (const s of summaries) {
		lines.push(
			`${s.score.toFixed(1).padStart(6)}   ${String(s.killed).padStart(6)} ${String(s.survived).padStart(8)} ${String(s.timedOut).padStart(7)} ${s.file}`
		);
	}
	lines.push("");
	lines.push("## Surviving mutants (per file, ordered worst → best)");
	for (const s of summaries) {
		if (s.survivors.length === 0) continue;
		lines.push("");
		lines.push(`### ${s.file}  (score ${s.score.toFixed(1)}%, ${s.survived} survivors)`);
		for (const v of s.survivors) {
			lines.push(`  L${v.line} [${v.mutator}] -> ${v.replacement}`);
		}
	}

	const summaryTxt = resolve(projectRoot, `reports/mutation/chunks/${chunkName}.summary.txt`);
	writeFileSync(summaryTxt, lines.join("\n"));
	console.log(`\n✓ Chunk ${chunkName} done. Summary at ${summaryTxt}`);
}

run();
