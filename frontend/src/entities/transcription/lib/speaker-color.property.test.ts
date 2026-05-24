import { describe, test } from "bun:test";
import fc from "fast-check";
import { colorForSpeaker } from "./speaker-color";

const PALETTE_SIZE = 8;
const MUTED_SENTINEL = "currentColor";

describe("colorForSpeaker (property-based)", () => {
	test("negative ids always map to the muted sentinel ('currentColor')", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -1_000_000, max: -1 }),
				(id) => colorForSpeaker(id) === MUTED_SENTINEL
			),
			{ numRuns: 300 }
		);
	});

	test("periodicity: speaker N and N + palette_size map to the same color", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				(n) => colorForSpeaker(n) === colorForSpeaker(n + PALETTE_SIZE)
			),
			{ numRuns: 300 }
		);
	});

	test("periodicity (k-fold): N and N + k * palette_size map to the same color", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000 }),
				fc.integer({ min: 1, max: 50 }),
				(n, k) => colorForSpeaker(n) === colorForSpeaker(n + k * PALETTE_SIZE)
			),
			{ numRuns: 300 }
		);
	});

	test("deterministic: same id always returns same color", () => {
		fc.assert(
			fc.property(fc.integer({ min: -1000, max: 1000 }), (id) => {
				const a = colorForSpeaker(id);
				const b = colorForSpeaker(id);
				return a === b;
			}),
			{ numRuns: 300 }
		);
	});

	test("non-negative ids never return the muted sentinel", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				(id) => colorForSpeaker(id) !== MUTED_SENTINEL
			),
			{ numRuns: 300 }
		);
	});
});
