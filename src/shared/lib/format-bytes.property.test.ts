import { describe, test } from "bun:test";
import fc from "fast-check";
import { formatBytes } from "./format-bytes";

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

describe("formatBytes property tests", () => {
	test("null / NaN / negative / non-finite => null", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.constant(null),
					fc.constant(undefined),
					fc.constant(Number.NaN),
					fc.constant(Number.POSITIVE_INFINITY),
					fc.constant(Number.NEGATIVE_INFINITY),
					fc.integer({ max: 0 }),
					fc.double({ max: 0, noNaN: false }),
				),
				(value) => formatBytes(value as number | null | undefined) === null,
			),
			{ numRuns: 300 },
		);
	});

	test("deterministic: same input + options always yield same output", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 10 * GIB }), (bytes) => {
				const a = formatBytes(bytes);
				const b = formatBytes(bytes);
				return a === b;
			}),
			{ numRuns: 200 },
		);
	});

	test("positive finite numbers return a non-null string ending with B/KB/MB/GB", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 100 * GIB }),
				fc.constantFrom("B", "KB", "MB", "GB" as const),
				(bytes, minUnit) => {
					const out = formatBytes(bytes, { minUnit });
					if (out === null) {
						return false;
					}
					return /(B|KB|MB|GB)$/.test(out);
				},
			),
			{ numRuns: 300 },
		);
	});

	test("monotonic within the GB tier (a < b ∈ GB-range ⇒ numeric value non-decreasing)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: GIB, max: 100 * GIB }),
				fc.integer({ min: GIB, max: 100 * GIB }),
				(a, b) => {
					fc.pre(a < b);
					const outA = formatBytes(a, { gbDecimals: 3 });
					const outB = formatBytes(b, { gbDecimals: 3 });
					if (outA === null || outB === null) {
						return false;
					}
					const valA = Number.parseFloat(outA);
					const valB = Number.parseFloat(outB);
					return valA <= valB;
				},
			),
			{ numRuns: 200 },
		);
	});

	test("monotonic within the MB tier (sub-GB) — non-decreasing rendered MB value", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: MIB, max: GIB - 1 }),
				fc.integer({ min: MIB, max: GIB - 1 }),
				(a, b) => {
					fc.pre(a < b);
					const outA = formatBytes(a, { mbDecimals: 3 });
					const outB = formatBytes(b, { mbDecimals: 3 });
					if (outA === null || outB === null) {
						return false;
					}
					return Number.parseFloat(outA) <= Number.parseFloat(outB);
				},
			),
			{ numRuns: 200 },
		);
	});
});
