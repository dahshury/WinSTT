import { describe, test } from "bun:test";
import fc from "fast-check";
import { cn } from "./cn";

// Class fragments unlikely to collide with tailwind utility families so we can
// reason about associativity/idempotence without twMerge's conflict resolution
// kicking in and rewriting our input.
const classToken = fc.stringMatching(/^[a-z]{3,8}-token-\d{1,2}$/);

describe("cn property tests", () => {
	test("falsy values are filtered out (equivalent to omitting them)", () => {
		fc.assert(
			fc.property(classToken, classToken, (a, b) => {
				const withFalsy = cn(a, undefined, null, false, "", 0, b);
				const withoutFalsy = cn(a, b);
				return withFalsy === withoutFalsy;
			}),
			{ numRuns: 200 }
		);
	});

	test("associativity on non-conflicting classes: cn(cn(a,b), c) === cn(a, cn(b,c))", () => {
		fc.assert(
			fc.property(
				classToken,
				classToken,
				classToken,
				(a, b, c) => cn(cn(a, b), c) === cn(a, cn(b, c))
			),
			{ numRuns: 200 }
		);
	});

	test("idempotence: cn(cn(x)) === cn(x)", () => {
		fc.assert(
			fc.property(fc.array(classToken, { minLength: 0, maxLength: 8 }), (tokens) => {
				const once = cn(...tokens);
				const twice = cn(once);
				return once === twice;
			}),
			{ numRuns: 200 }
		);
	});

	test("output is a string with no leading/trailing whitespace and single-space delimited", () => {
		fc.assert(
			fc.property(fc.array(classToken, { maxLength: 6 }), (tokens) => {
				const out = cn(...tokens);
				if (out === "") {
					return true;
				}
				return out === out.trim() && !out.includes("  ");
			}),
			{ numRuns: 200 }
		);
	});

	test("conflicting tailwind class — last wins (right-biased merge)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 12 }), (a, b) => {
				fc.pre(a !== b);
				const result = cn(`p-${a}`, `p-${b}`);
				return result === `p-${b}`;
			}),
			{ numRuns: 200 }
		);
	});
});
