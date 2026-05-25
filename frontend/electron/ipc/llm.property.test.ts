/**
 * Property tests for the pure helpers exported via `__llm_test_helpers__`.
 *
 * Companion to llm.test.ts. The example-based suite hits each branch once;
 * this file pins down invariants across the whole input space for the pure,
 * IO-free helpers:
 *
 *   - classifyEllipsisPair: total, deterministic, exhaustive enum mapping.
 *   - isAcceptableNounString / isAcceptableUniqueNoun: monotonic bounds.
 *   - cleanupRawNouns / cleanOpenRouterNouns: length-bounded, trim-stable,
 *     uniqueness preserved (cleanOpenRouterNouns variant).
 *   - endsWithEllipsis: total predicate.
 *   - pickLongerDescription: idempotent with self / undefined.
 *
 * llm.ts imports `electron` and `node:child_process` at module load, so we
 * mock those out exactly like llm.test.ts does.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import fc from "fast-check";
import { electronMock } from "../../test/mocks/electron";
import { storeMock } from "../../test/mocks/store";

mock.module("electron", () => electronMock());
// Don't mock debug-log here: `mock.module` is process-global, so a partial
// stub (only `dbg`/`dbgVerbose`) leaks across files and breaks tests that
// rely on `getLogger` (sentry-main, relay's transitive imports). The real
// module is harmless under bun:test because preload.ts silences electron-log
// IPC/console transports — see test/preload.ts.
mock.module("../lib/store", () => {
	const base = storeMock();
	return {
		...base,
		getStoreValue: (key: string) => {
			if (key === "llm.endpoint") {
				return "http://localhost:65535";
			}
			if (key === "llm.timeout") {
				return 5000;
			}
			return base.getStoreValue(key);
		},
	};
});

const { __llm_test_helpers__: helpers } = await import("./llm");

// Property generators -------------------------------------------------------

// Strings that may or may not be ASCII-ellipsis terminated, plus the unicode
// horizontal ellipsis. Stays small so the lookup-table classification gets
// exhaustive coverage of the four corner pairs.
const maybeEllipsisStringArb = fc.oneof(
	fc.string({ maxLength: 30 }),
	fc.string({ maxLength: 30 }).map((s) => `${s}...`),
	fc.string({ maxLength: 30 }).map((s) => `${s}…`)
);

// Restored after the suite finishes so coverage-mode runs don't leak the
// captured fetch reference between files.
const originalFetch = globalThis.fetch;
beforeAll(() => {
	globalThis.fetch = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
});
afterAll(() => {
	globalThis.fetch = originalFetch;
});

// classifyEllipsisPair ------------------------------------------------------

describe("classifyEllipsisPair (property)", () => {
	test("output is always one of the four enum values", () => {
		fc.assert(
			fc.property(maybeEllipsisStringArb, maybeEllipsisStringArb, (a, b) => {
				const out = helpers.classifyEllipsisPair(a, b);
				return out === "both" || out === "neither" || out === "a-only" || out === "b-only";
			}),
			{ numRuns: 400 }
		);
	});

	test("classification mirrors endsWithEllipsis on each input independently", () => {
		// Round-trip invariant: the classifier is a Cartesian product of the
		// two predicates. If `classifyEllipsisPair(a, b)` says "a-only", then
		// `endsWithEllipsis(a) && !endsWithEllipsis(b)` MUST hold — and vice
		// versa. Catches any future "optimization" that drops a column from
		// the lookup table.
		fc.assert(
			fc.property(maybeEllipsisStringArb, maybeEllipsisStringArb, (a, b) => {
				const out = helpers.classifyEllipsisPair(a, b);
				const aE = helpers.endsWithEllipsis(a);
				const bE = helpers.endsWithEllipsis(b);
				let expected: "both" | "neither" | "a-only" | "b-only" = "neither";
				if (aE && bE) {
					expected = "both";
				} else if (aE) {
					expected = "a-only";
				} else if (bE) {
					expected = "b-only";
				}
				return out === expected;
			}),
			{ numRuns: 400 }
		);
	});

	test("symmetry: swapping a/b swaps 'a-only' ↔ 'b-only' and preserves 'both'/'neither'", () => {
		fc.assert(
			fc.property(maybeEllipsisStringArb, maybeEllipsisStringArb, (a, b) => {
				const ab = helpers.classifyEllipsisPair(a, b);
				const ba = helpers.classifyEllipsisPair(b, a);
				if (ab === "both" || ab === "neither") {
					return ba === ab;
				}
				if (ab === "a-only") {
					return ba === "b-only";
				}
				return ba === "a-only";
			}),
			{ numRuns: 400 }
		);
	});

	test("deterministic: same inputs → same output across N calls", () => {
		// Anchor against a snapshot of the first call so we're not literally
		// `f(x) === f(x)` (which a clever optimiser could fold). This pins
		// down referential transparency over a sequence of calls.
		fc.assert(
			fc.property(
				maybeEllipsisStringArb,
				maybeEllipsisStringArb,
				fc.integer({ min: 2, max: 5 }),
				(a, b, n) => {
					const first = helpers.classifyEllipsisPair(a, b);
					for (let i = 0; i < n; i++) {
						if (helpers.classifyEllipsisPair(a, b) !== first) {
							return false;
						}
					}
					return true;
				}
			),
			{ numRuns: 200 }
		);
	});
});

// endsWithEllipsis ----------------------------------------------------------

describe("endsWithEllipsis (property)", () => {
	test("returns boolean for every string", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 100 }),
				(s) => typeof helpers.endsWithEllipsis(s) === "boolean"
			),
			{ numRuns: 200 }
		);
	});

	test("appending '...' always makes it true", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 100 }),
				(s) => helpers.endsWithEllipsis(`${s}...`) === true
			),
			{ numRuns: 200 }
		);
	});

	test("appending the unicode horizontal ellipsis '…' always makes it true", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), (s) => helpers.endsWithEllipsis(`${s}…`) === true),
			{ numRuns: 200 }
		);
	});
});

// isAcceptableNounString ----------------------------------------------------

describe("isAcceptableNounString (property)", () => {
	test("returns boolean for every JS value (total predicate)", () => {
		fc.assert(
			fc.property(fc.anything(), (v) => typeof helpers.isAcceptableNounString(v) === "boolean"),
			{ numRuns: 300 }
		);
	});

	test("false for any non-string (numbers, booleans, null, undefined, objects)", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.integer(),
					fc.boolean(),
					fc.constant(null),
					fc.constant(undefined),
					fc.array(fc.integer())
				),
				(v) => helpers.isAcceptableNounString(v) === false
			),
			{ numRuns: 200 }
		);
	});

	test("accepts any non-whitespace string with 1..60 trimmed chars", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0),
				(s) => helpers.isAcceptableNounString(s) === true
			),
			{ numRuns: 300 }
		);
	});

	test("rejects strings whose TRIMMED length exceeds 60", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 61, maxLength: 200 }).filter((s) => s.trim().length > 60),
				(s) => helpers.isAcceptableNounString(s) === false
			),
			{ numRuns: 100 }
		);
	});
});

// isAcceptableUniqueNoun ----------------------------------------------------

describe("isAcceptableUniqueNoun (property)", () => {
	test("rejects empty string regardless of seen-set", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string(), { maxLength: 10 }),
				(seen) => helpers.isAcceptableUniqueNoun("", new Set(seen)) === false
			),
			{ numRuns: 100 }
		);
	});

	test("rejects strings longer than 60 chars regardless of seen-set", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 61, maxLength: 200 }),
				fc.array(fc.string(), { maxLength: 10 }),
				(s, seen) => helpers.isAcceptableUniqueNoun(s, new Set(seen)) === false
			),
			{ numRuns: 100 }
		);
	});

	test("rejects values already in the seen-set", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 50 }),
				(s) => helpers.isAcceptableUniqueNoun(s, new Set([s])) === false
			),
			{ numRuns: 200 }
		);
	});

	test("accepts a fresh non-empty string ≤60 chars", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 60 }),
				(s) => helpers.isAcceptableUniqueNoun(s, new Set()) === true
			),
			{ numRuns: 200 }
		);
	});
});

// cleanupRawNouns -----------------------------------------------------------

describe("cleanupRawNouns (property)", () => {
	const MAX_LEARNED_NOUNS = 10;

	test("output length never exceeds 10 (early-exit bound)", () => {
		fc.assert(
			fc.property(
				fc.array(fc.anything(), { maxLength: 50 }),
				(raw) => helpers.cleanupRawNouns(raw).length <= MAX_LEARNED_NOUNS
			),
			{ numRuns: 200 }
		);
	});

	test("every output element is a trimmed non-empty string ≤60 chars", () => {
		fc.assert(
			fc.property(fc.array(fc.anything(), { maxLength: 50 }), (raw) => {
				const out = helpers.cleanupRawNouns(raw);
				return out.every(
					(s) => typeof s === "string" && s.trim() === s && s.length > 0 && s.length <= 60
				);
			}),
			{ numRuns: 200 }
		);
	});

	test("ignoring all non-acceptable items yields []", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.integer(),
						fc.boolean(),
						fc.constant(null),
						fc.constant(undefined),
						fc.constant("")
					),
					{ maxLength: 20 }
				),
				(raw) => helpers.cleanupRawNouns(raw).length === 0
			),
			{ numRuns: 100 }
		);
	});
});

// cleanOpenRouterNouns ------------------------------------------------------

describe("cleanOpenRouterNouns (property)", () => {
	const MAX_LEARNED_NOUNS = 10;

	test("output length never exceeds 10", () => {
		fc.assert(
			fc.property(
				fc.array(fc.anything(), { maxLength: 50 }),
				(raw) => helpers.cleanOpenRouterNouns(raw).length <= MAX_LEARNED_NOUNS
			),
			{ numRuns: 200 }
		);
	});

	test("output contains no duplicates", () => {
		fc.assert(
			fc.property(fc.array(fc.anything(), { maxLength: 50 }), (raw) => {
				const out = helpers.cleanOpenRouterNouns(raw);
				return new Set(out).size === out.length;
			}),
			{ numRuns: 200 }
		);
	});

	test("every element is a trimmed non-empty string ≤60 chars", () => {
		fc.assert(
			fc.property(fc.array(fc.anything(), { maxLength: 50 }), (raw) => {
				const out = helpers.cleanOpenRouterNouns(raw);
				return out.every(
					(s) => typeof s === "string" && s.trim() === s && s.length > 0 && s.length <= 60
				);
			}),
			{ numRuns: 200 }
		);
	});

	test("duplicate non-whitespace strings collapse to one", () => {
		// Restrict to strings whose trimmed form is non-empty AND ≤60 chars
		// so each individual entry is acceptable per isAcceptableUniqueNoun.
		// All-whitespace strings collapse to length-0 (filtered out), and
		// >60-char trimmed strings are also rejected — neither makes the
		// "collapses to one" claim meaningful.
		fc.assert(
			fc.property(
				fc
					.string({ minLength: 1, maxLength: 30 })
					.filter((s) => s.trim().length > 0 && s.trim().length <= 60),
				fc.integer({ min: 2, max: 8 }),
				(s, n) => {
					const raw = Array.from({ length: n }, () => s);
					const out = helpers.cleanOpenRouterNouns(raw);
					return out.length === 1 && out[0] === s.trim();
				}
			),
			{ numRuns: 100 }
		);
	});
});

// pickLongerDescription -----------------------------------------------------

describe("pickLongerDescription (property)", () => {
	test("identity when one side is undefined: returns the defined value (non-empty input)", () => {
		// Note: the source treats falsy listing as "missing" (`if (!listing)`),
		// so an empty string short-circuits to `detail` instead of preserving
		// the empty string. We don't ship empty descriptions in practice, so
		// the test scopes the property to the realistic non-empty domain.
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 200 }),
				(s) =>
					helpers.pickLongerDescription(undefined, s) === s &&
					helpers.pickLongerDescription(s, undefined) === s
			),
			{ numRuns: 200 }
		);
	});

	test("FINDING: empty string is treated as 'missing' (falsy-listing branch)", () => {
		// Document the falsy-string short-circuit so a future tightening
		// (`listing === undefined` vs `!listing`) doesn't silently change
		// behaviour. The source uses `!listing`/`!detail`, deliberate per
		// the doc comment ("prefer the longer one — and if both look
		// truncated, prefer the one without a trailing ellipsis").
		expect(helpers.pickLongerDescription("", undefined)).toBeUndefined();
		expect(helpers.pickLongerDescription(undefined, "")).toBe("");
	});

	test("when both undefined, returns undefined", () => {
		expect(helpers.pickLongerDescription(undefined, undefined)).toBeUndefined();
	});

	test("output is always one of the two inputs (when both present)", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 200 }),
				fc.string({ minLength: 1, maxLength: 200 }),
				(a, b) => {
					const out = helpers.pickLongerDescription(a, b);
					return out === a || out === b;
				}
			),
			{ numRuns: 300 }
		);
	});
});
