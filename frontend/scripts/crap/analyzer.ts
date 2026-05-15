/**
 * Orchestrator. Mirrors `examples/crap4java/src/crap4java/CrapAnalyzer.java`.
 * Walks every source file, derives per-function complexity + coverage, then
 * combines them into a CRAP score.
 */

import { resolve } from "node:path";
import { Glob } from "bun";
import type { LcovCoverage } from "./lcov-parser";
import { parseFunctions } from "./method-parser";
import { calculateCrapScore } from "./score";

export interface FunctionMetric {
	complexity: number;
	coverage: number | null; // fraction in [0, 1]
	crap: number | null;
	endLine: number;
	file: string;
	name: string;
	startLine: number;
}

export interface AnalyzeOptions {
	exclude: RegExp; // e.g. /\.(test|spec|d)\.tsx?$/
	/** Extra path patterns (forward-slashed) to skip — used for biome-disabled
	 * files and other principled exclusions. */
	excludePaths?: string[];
	include: RegExp; // e.g. /\.tsx?$/
	roots: string[]; // e.g. ["src", "electron"]
}

/**
 * Parse biome.jsonc and return the list of file paths that have linter.enabled = false.
 * These files are explicitly accepted as outside the quality bar (third-party
 * adapted code, generated scripts) and are therefore also excluded from CRAP.
 */
export async function readBiomeLinterDisabledPaths(projectRoot: string): Promise<string[]> {
	const biomePath = resolve(projectRoot, "biome.jsonc");
	const file = Bun.file(biomePath);
	if (!(await file.exists())) return [];
	const raw = await file.text();
	// biome.jsonc allows comments — strip them before JSON.parse. We only
	// strip line comments; the file does not currently use block comments.
	const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
	const config = JSON.parse(stripped) as {
		overrides?: { includes?: string[]; linter?: { enabled?: boolean } }[];
	};
	const out: string[] = [];
	for (const override of config.overrides ?? []) {
		if (override.linter?.enabled === false) {
			for (const p of override.includes ?? []) out.push(p);
		}
	}
	return out;
}

/**
 * Read `crap.ignore.json` and return its `ignore` array. This list decouples
 * the CRAP gate from lint enforcement — pure-UI React files (which we still
 * lint) can be excluded from CRAP scoring without disabling biome on them.
 * Returns an empty array if the file is missing.
 */
export async function readCrapIgnorePaths(projectRoot: string): Promise<string[]> {
	const ignorePath = resolve(projectRoot, "crap.ignore.json");
	const file = Bun.file(ignorePath);
	if (!(await file.exists())) return [];
	const raw = await file.text();
	const config = JSON.parse(raw) as { ignore?: string[] };
	return config.ignore ?? [];
}

/**
 * Convert a glob-ish pattern into an anchored RegExp. We handle:
 *   - `**`  → `.*`        (any number of path segments, including slashes)
 *   - `*`   → `[^/]*`     (anything within a single segment)
 *   - everything else escaped as a literal
 * The pattern is anchored with `^…$`.
 */
function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
		} else if (ch !== undefined && /[.+?^${}()|[\]\\]/.test(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	return new RegExp(`^${out}$`);
}

function pathMatchesAnyPattern(path: string, patterns: string[]): boolean {
	for (const p of patterns) {
		if (p === path) return true;
		// Fast path: trailing /** matches any descendant.
		if (p.endsWith("/**") && !p.slice(0, -3).includes("*")) {
			const prefix = p.slice(0, -3);
			if (path.startsWith(`${prefix}/`)) return true;
			continue;
		}
		// General glob — `*` segments may appear in the middle, e.g.
		// `src/entities/*/ui/**` → `src/entities/audio-device/ui/Foo.tsx`.
		if (p.includes("*")) {
			if (globToRegExp(p).test(path)) return true;
		}
	}
	return false;
}

/**
 * Returns the set of 1-indexed line numbers whose nearest preceding non-blank
 * line carries a `@crap-exclude` annotation. We scan up to 5 lines preceding
 * the target line for the marker — enough to clear a typical comment block
 * and a single dependency-array closing bracket, but tight enough not to
 * leak across unrelated declarations.
 */
function collectCrapExcludeLines(text: string): Set<number> {
	const lines = text.split(/\r?\n/);
	const out = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i]?.includes("@crap-exclude")) continue;
		// Mark this line and the next 6 lines (1-indexed) as exclusion-bearing.
		for (let j = 0; j <= 6; j++) out.add(i + 1 + j);
	}
	return out;
}

export async function analyze(
	projectRoot: string,
	coverage: LcovCoverage,
	options: AnalyzeOptions
): Promise<FunctionMetric[]> {
	const out: FunctionMetric[] = [];
	const sourceGlob = new Glob("**/*.{ts,tsx}");
	const excludePaths = options.excludePaths ?? [];

	for (const root of options.roots) {
		const cwd = resolve(projectRoot, root);
		for await (const rel of sourceGlob.scan({ cwd, absolute: false })) {
			if (!options.include.test(rel) || options.exclude.test(rel)) continue;
			const fullRel = `${root}/${rel}`.replace(/\\/g, "/");
			if (pathMatchesAnyPattern(fullRel, excludePaths)) continue;
			const text = await Bun.file(resolve(projectRoot, fullRel)).text();
			const excludedLines = collectCrapExcludeLines(text);
			const fns = parseFunctions(fullRel, text);
			const fileCoverage = coverage.get(fullRel) ?? coverage.get(fullRel.replace(/\//g, "\\"));
			for (const fn of fns) {
				if (excludedLines.has(fn.startLine)) continue;
				const cov = fileCoverage
					? functionCoverageFraction(fileCoverage.lineHits, fn.startLine, fn.endLine)
					: null;
				out.push({
					file: fullRel,
					name: fn.name,
					startLine: fn.startLine,
					endLine: fn.endLine,
					complexity: fn.complexity,
					coverage: cov,
					crap: calculateCrapScore(fn.complexity, cov),
				});
			}
		}
	}
	return out;
}

/**
 * Coverage fraction = hit lines / executable lines within the function span.
 * "Executable lines" are any lines mentioned in the LCOV DA: records that
 * fall within [startLine, endLine]. Lines outside the LCOV record set are
 * treated as non-executable (comments, declarations, type-only code).
 */
function functionCoverageFraction(
	lineHits: Map<number, number>,
	startLine: number,
	endLine: number
): number | null {
	let executable = 0;
	let hit = 0;
	for (const [line, hits] of lineHits) {
		if (line < startLine || line > endLine) continue;
		executable++;
		if (hits > 0) hit++;
	}
	if (executable === 0) return null;
	return hit / executable;
}
