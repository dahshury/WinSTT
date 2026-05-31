import { describe, test } from "bun:test";
import fc from "fast-check";
import { jaroWinkler } from "./fuzzy-match";

// Plain ASCII strings keep the JW reference-implementation comparison clean;
// the algorithm itself is unicode-agnostic but the test invariants are easier
// to reason about over a small alphabet.
const asciiString = fc.string({ minLength: 0, maxLength: 12 });
const nonEmptyAsciiString = fc.string({ minLength: 1, maxLength: 12 });

describe("jaroWinkler property tests", () => {
	test("symmetry: jw(a, b) === jw(b, a)", () => {
		fc.assert(
			fc.property(asciiString, asciiString, (a, b) => jaroWinkler(a, b) === jaroWinkler(b, a)),
			{ numRuns: 300 }
		);
	});

	test("bounded in [0, 1] for all inputs", () => {
		fc.assert(
			fc.property(asciiString, asciiString, (a, b) => {
				const score = jaroWinkler(a, b);
				return score >= 0 && score <= 1;
			}),
			{ numRuns: 300 }
		);
	});

	test("self-similarity: jw(a, a) === 1 for any string (including empty)", () => {
		fc.assert(
			fc.property(asciiString, (a) => jaroWinkler(a, a) === 1),
			{ numRuns: 200 }
		);
	});

	test("disjoint character sets yield JW = 0", () => {
		// Two strings with no overlapping characters: Jaro = 0, no prefix boost.
		fc.assert(
			fc.property(
				fc.stringMatching(/^[a-m]{1,6}$/),
				fc.stringMatching(/^[n-z]{1,6}$/),
				(a, b) => jaroWinkler(a, b) === 0
			),
			{ numRuns: 200 }
		);
	});

	test("empty paired with non-empty: jw = 0 (one-sided emptiness)", () => {
		fc.assert(
			fc.property(nonEmptyAsciiString, (a) => jaroWinkler("", a) === 0 && jaroWinkler(a, "") === 0),
			{ numRuns: 200 }
		);
	});
});
