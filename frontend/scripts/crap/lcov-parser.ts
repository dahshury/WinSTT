/**
 * LCOV → per-file per-line hit map.
 *
 * Mirrors `examples/crap4java/src/crap4java/JacocoCoverageParser.java`,
 * adapted for the LCOV format Bun emits. Only the records we need:
 *
 *   SF:<path>
 *   DA:<line>,<hits>
 *   LF:<total>     (ignored — derived from DA: entries)
 *   LH:<hit>       (ignored — derived from DA: entries)
 *   end_of_record
 */

export interface FileCoverage {
	/** Per-line hit count (1-indexed). 0 means executable but never hit. */
	lineHits: Map<number, number>;
}

export type LcovCoverage = Map<string, FileCoverage>;

export async function parseLcov(lcovPath: string): Promise<LcovCoverage> {
	const text = await Bun.file(lcovPath).text();
	const result: LcovCoverage = new Map();
	let current: FileCoverage | null = null;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("SF:")) {
			const file = normalizePath(line.slice(3));
			// Bun emits one record per (test file, source file) pair, so the
			// same source can appear many times. Merge by accumulating hits
			// into the existing FileCoverage instead of overwriting.
			let cov = result.get(file);
			if (!cov) {
				cov = { lineHits: new Map() };
				result.set(file, cov);
			}
			current = cov;
			continue;
		}
		if (line.startsWith("DA:") && current !== null) {
			const [lineNum, hits] = line
				.slice(3)
				.split(",")
				.map((s) => Number.parseInt(s, 10));
			if (Number.isFinite(lineNum) && Number.isFinite(hits)) {
				const ln = lineNum as number;
				const h = hits as number;
				const prev = current.lineHits.get(ln) ?? 0;
				// Sum hits across duplicate SF blocks so a line counts as
				// "covered" when any test exercises it.
				current.lineHits.set(ln, prev + h);
			}
			continue;
		}
		if (line === "end_of_record") {
			current = null;
		}
	}
	return result;
}

/**
 * Bun emits Windows-style backslashes in `SF:` lines; normalize to forward
 * slashes so they match the paths we walk via Glob.
 */
function normalizePath(p: string): string {
	return p.replace(/\\/g, "/");
}
