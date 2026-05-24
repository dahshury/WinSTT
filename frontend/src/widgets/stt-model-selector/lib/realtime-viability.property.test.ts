import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ModelInfo } from "@/entities/model-catalog";
import { isRealtimeViable, parseSizeLabel } from "./realtime-viability";

// Property tests for the size-label parser and realtime-viability threshold.
// Invariants:
//   - parseSizeLabel("<n>M") = n * 1_000_000
//   - parseSizeLabel("<n>B") = n * 1_000_000_000 (case-insensitive)
//   - unparseable labels fall back to the catalog flag
//   - the realtime threshold is monotone non-increasing in size

const REALTIME_MAX_PARAMS = 700_000_000;

function makeModel(sizeLabel: string, supportsRealtime: boolean): ModelInfo {
	return {
		id: "m",
		displayName: "M",
		family: "whisper",
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel,
		supportsRealtime,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
	} as ModelInfo;
}

// Finite, sensible numerics for size labels (avoid NaN / Infinity input).
const positiveNumArb = fc.double({
	min: 0.01,
	max: 9999,
	noNaN: true,
	noDefaultInfinity: true,
});

describe("parseSizeLabel properties", () => {
	test("M-suffixed labels equal num * 1e6", () => {
		fc.assert(
			fc.property(positiveNumArb, (n) => {
				const label = `${n}M`;
				const expected = n * 1_000_000;
				const got = parseSizeLabel(label);
				// Skip if our generated string happens not to match the
				// `^([\d.]+)([MB])$` regex (e.g. scientific notation like "1e-5M").
				if (!/^[\d.]+M$/.test(label)) {
					expect(got).toBeNull();
					return;
				}
				expect(got).not.toBeNull();
				if (got !== null) {
					expect(Math.abs(got - expected)).toBeLessThan(1e-3);
				}
			}),
			{ numRuns: 300 }
		);
	});

	test("B-suffixed labels equal num * 1e9, case-insensitive", () => {
		fc.assert(
			fc.property(positiveNumArb, fc.boolean(), (n, upper) => {
				const label = `${n}${upper ? "B" : "b"}`;
				if (!/^[\d.]+[Bb]$/.test(label)) {
					expect(parseSizeLabel(label)).toBeNull();
					return;
				}
				const expected = n * 1_000_000_000;
				const got = parseSizeLabel(label);
				expect(got).not.toBeNull();
				if (got !== null) {
					expect(Math.abs(got - expected) / expected).toBeLessThan(1e-9);
				}
			}),
			{ numRuns: 300 }
		);
	});

	test("unparseable labels return null", () => {
		const garbageArb = fc
			.string({ minLength: 0, maxLength: 8 })
			.filter((s) => !/^[\d.]+[MBmb]$/.test(s));
		fc.assert(
			fc.property(garbageArb, (s) => {
				expect(parseSizeLabel(s)).toBeNull();
			}),
			{ numRuns: 300 }
		);
	});
});

describe("isRealtimeViable properties", () => {
	test("supportsRealtime=false always returns false (catalog gate is necessary)", () => {
		const sizeArb = fc.oneof(
			fc.constantFrom("39M", "244M", "769M", "1.5B"),
			fc.constantFrom("", "garbage")
		);
		fc.assert(
			fc.property(sizeArb, (s) => {
				expect(isRealtimeViable(makeModel(s, false))).toBe(false);
			}),
			{ numRuns: 200 }
		);
	});

	test("unparseable label falls back to the catalog flag", () => {
		const unparseableArb = fc
			.string({ minLength: 0, maxLength: 8 })
			.filter((s) => !/^[\d.]+[MBmb]$/.test(s));
		fc.assert(
			fc.property(unparseableArb, fc.boolean(), (label, flag) => {
				expect(isRealtimeViable(makeModel(label, flag))).toBe(flag);
			}),
			{ numRuns: 300 }
		);
	});

	test("monotone non-increasing in size: smaller → still realtime if larger was", () => {
		fc.assert(
			fc.property(positiveNumArb, positiveNumArb, (a, b) => {
				const small = Math.min(a, b);
				const large = Math.max(a, b);
				const smallLabel = `${small}M`;
				const largeLabel = `${large}M`;
				if (!(/^[\d.]+M$/.test(smallLabel) && /^[\d.]+M$/.test(largeLabel))) {
					return;
				}
				const largeViable = isRealtimeViable(makeModel(largeLabel, true));
				const smallViable = isRealtimeViable(makeModel(smallLabel, true));
				// Monotonicity: if large was viable, small must be too.
				if (largeViable) {
					expect(smallViable).toBe(true);
				}
			}),
			{ numRuns: 300 }
		);
	});

	test("threshold matches REALTIME_MAX_PARAMS: viable ↔ params ≤ 700M when parseable", () => {
		const parseableSizeArb = positiveNumArb.map((n) => `${n}M`).filter((s) => /^[\d.]+M$/.test(s));
		fc.assert(
			fc.property(parseableSizeArb, (label) => {
				const params = parseSizeLabel(label);
				expect(params).not.toBeNull();
				if (params === null) {
					return;
				}
				const viable = isRealtimeViable(makeModel(label, true));
				expect(viable).toBe(params <= REALTIME_MAX_PARAMS);
			}),
			{ numRuns: 300 }
		);
	});
});
