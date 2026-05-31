#!/usr/bin/env bun

/**
 * Aggregates ALL per-file Stryker reports under reports/mutation/per-file/
 * into one unified summary. Treats the JSON reports as ground truth and is
 * insensitive to which chunk produced them.
 *
 * Usage:
 *   bun run scripts/stryker-summary.ts [<expected-source-files-list-file>]
 *
 * If a list file is given, the summary also includes a "Missing reports"
 * section for any expected file with no per-file JSON.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface MutantResult {
	id: string;
	location: { start: { line: number; column: number } };
	mutatorName: string;
	replacement?: string;
	status: string;
}

interface StrykerJson {
	files: Record<string, { mutants: MutantResult[] }>;
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

function slugToFile(slug: string): string {
	// Best-effort reverse: e.g. src_shared_lib_format-time -> src/shared/lib/format-time.ts
	return `${slug.replace(/_/g, "/")}.ts`;
}

function summarize(file: string, report: StrykerJson): FileSummary {
	const summary: FileSummary = {
		file,
		killed: 0,
		survived: 0,
		timedOut: 0,
		noCoverage: 0,
		score: 0,
		survivors: [],
	};
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
	summary.score = total === 0 ? 0 : (100 * (summary.killed + summary.timedOut)) / total;
	return summary;
}

function run(): void {
	const projectRoot = resolve(import.meta.dir, "..");
	const perFileDir = resolve(projectRoot, "reports/mutation/per-file");
	const expectedListFile = process.argv[2];

	const files = readdirSync(perFileDir).filter((f) => f.endsWith(".json"));
	const summaries: FileSummary[] = [];
	const fileToSummary = new Map<string, FileSummary>();
	for (const fname of files) {
		const slug = fname.replace(/\.json$/, "");
		const sourceFile = slugToFile(slug);
		try {
			const json = JSON.parse(readFileSync(resolve(perFileDir, fname), "utf-8")) as StrykerJson;
			const s = summarize(sourceFile, json);
			summaries.push(s);
			fileToSummary.set(sourceFile, s);
		} catch (err) {
			console.warn(`  ⚠ failed to parse ${fname}:`, (err as Error).message);
		}
	}

	let missing: string[] = [];
	if (expectedListFile) {
		const expected = readFileSync(expectedListFile, "utf-8")
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => s.endsWith(".ts"));
		missing = expected.filter((f) => !fileToSummary.has(f));
	}

	summaries.sort((a, b) => a.score - b.score);

	const out: string[] = [];
	out.push("# Unified mutation summary");
	out.push("");
	out.push(`Files with reports: ${summaries.length}`);
	if (missing.length > 0) {
		out.push(`Files without reports: ${missing.length}`);
	}
	out.push("");
	out.push("score%   killed survived timeout noCov file");
	out.push("---------------------------------------------------------------");
	for (const s of summaries) {
		out.push(
			`${s.score.toFixed(1).padStart(6)}   ${String(s.killed).padStart(6)} ${String(s.survived).padStart(8)} ${String(s.timedOut).padStart(7)} ${String(s.noCoverage).padStart(5)} ${s.file}`
		);
	}

	if (missing.length > 0) {
		out.push("");
		out.push("## Missing reports");
		for (const f of missing) out.push(`  ${f}`);
	}

	out.push("");
	out.push("## Surviving mutants (per file, ordered worst → best)");
	for (const s of summaries) {
		if (s.survivors.length === 0) continue;
		out.push("");
		out.push(`### ${s.file}  (score ${s.score.toFixed(1)}%, ${s.survived} survivors)`);
		for (const v of s.survivors) {
			out.push(`  L${v.line} [${v.mutator}] -> ${v.replacement}`);
		}
	}

	const summaryTxt = resolve(projectRoot, "reports/mutation/unified-summary.txt");
	writeFileSync(summaryTxt, out.join("\n"));
	console.log(`✓ Wrote ${summaryTxt}`);
	console.log(`  ${summaries.length} files have reports, ${missing.length} missing`);
}

run();
