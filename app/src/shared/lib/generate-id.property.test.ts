import { describe, test } from "bun:test";
import fc from "fast-check";
import { generateId } from "./generate-id";

// Standard RFC 4122 v4 layout (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx), y ∈ {8,9,a,b}.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_LEN = 36;

describe("generateId property tests", () => {
	test("every generated id matches the RFC 4122 v4 regex", () => {
		fc.assert(
			fc.property(fc.constant(null), () => UUID_V4.test(generateId())),
			{ numRuns: 500 }
		);
	});

	test("length is invariant at 36 chars on every call", () => {
		fc.assert(
			fc.property(fc.constant(null), () => generateId().length === UUID_LEN),
			{ numRuns: 500 }
		);
	});

	test("100 successive calls all unique (probabilistic — astronomical collision odds)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 100, max: 500 }), (n) => {
				const seen = new Set<string>();
				for (let i = 0; i < n; i++) {
					seen.add(generateId());
				}
				return seen.size === n;
			}),
			{ numRuns: 50 }
		);
	});

	test("output is always a string and version nibble is '4'", () => {
		fc.assert(
			fc.property(fc.constant(null), () => {
				const id = generateId();
				return typeof id === "string" && id[14] === "4";
			}),
			{ numRuns: 500 }
		);
	});
});
