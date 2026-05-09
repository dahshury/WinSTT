/**
 * CRAP score formula. Mirrors `examples/crap4java/src/crap4java/CrapScore.java`.
 *
 *   CRAP = CC^2 * (1 - coverage)^3 + CC
 *
 *   - `CC` is cyclomatic complexity (the function body's branch count)
 *   - `coverage` is line coverage as a fraction in [0, 1]
 *
 * Returns null when coverage is unknown (function not in the LCOV report).
 */
export function calculateCrapScore(
	complexity: number,
	coverageFraction: number | null
): number | null {
	if (coverageFraction === null) return null;
	const cc = complexity;
	const uncovered = 1 - coverageFraction;
	return cc * cc * (uncovered * uncovered * uncovered) + cc;
}
