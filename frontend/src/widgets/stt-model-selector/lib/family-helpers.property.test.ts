import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ModelInfo } from "@/entities/model-catalog";
import { type FamilyKey, groupByFamily, groupModelsByAuthor } from "./family-helpers";

// Property tests for the family grouping helpers. The grouping must preserve
// every input model exactly once, be idempotent on flatten/regroup, and
// always emit families in the canonical FAMILY_ORDER (whisper → t-one).

const CANONICAL_ORDER: FamilyKey[] = [
	"whisper",
	"lite-whisper",
	"nemo",
	"gigaam",
	"kaldi",
	"t-one",
];

const familyArb: fc.Arbitrary<FamilyKey> = fc.constantFrom<FamilyKey>(...CANONICAL_ORDER);

function makeModel(id: string, family: FamilyKey): ModelInfo {
	return {
		id,
		displayName: id,
		family,
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
	} as ModelInfo;
}

// Generate a list of distinct-id models with random families.
const modelsArb: fc.Arbitrary<ModelInfo[]> = fc
	.array(familyArb, { maxLength: 25 })
	.map((families) => families.map((fam, idx) => makeModel(`id-${idx}`, fam)));

describe("groupByFamily properties", () => {
	test("total preservation: every input model appears exactly once in output", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				const grouped = groupByFamily(models);
				const flat = grouped.flatMap(([, list]) => list);
				expect(flat.length).toBe(models.length);
				expect(flat.map((m) => m.id).sort()).toEqual(models.map((m) => m.id).sort());
			}),
			{ numRuns: 300 }
		);
	});

	test("canonical ordering: families appear in FAMILY_ORDER, no empty groups", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				const grouped = groupByFamily(models);
				const familiesOut = grouped.map(([fam]) => fam);
				// Each family in output is in canonical order (subsequence).
				let cursor = 0;
				for (const fam of familiesOut) {
					const idx = CANONICAL_ORDER.indexOf(fam, cursor);
					expect(idx).toBeGreaterThanOrEqual(0);
					cursor = idx + 1;
				}
				// No empty groups.
				for (const [, list] of grouped) {
					expect(list.length).toBeGreaterThan(0);
				}
			}),
			{ numRuns: 300 }
		);
	});

	test("idempotent flatten/regroup: regrouping the flattened output yields the same grouping", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				const first = groupByFamily(models);
				const flat = first.flatMap(([, list]) => list);
				const second = groupByFamily(flat);
				expect(second.map(([fam, list]) => [fam, list.map((m) => m.id)])).toEqual(
					first.map(([fam, list]) => [fam, list.map((m) => m.id)])
				);
			}),
			{ numRuns: 300 }
		);
	});

	test("within-family order is the original arrival order", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				const grouped = groupByFamily(models);
				for (const [fam, list] of grouped) {
					const expected = models.filter((m) => m.family === fam).map((m) => m.id);
					expect(list.map((m) => m.id)).toEqual(expected);
				}
			}),
			{ numRuns: 300 }
		);
	});

	test("groupModelsByAuthor mirrors groupByFamily one-to-one", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				const authors = groupModelsByAuthor(models);
				const families = groupByFamily(models);
				expect(authors.length).toBe(families.length);
				for (let i = 0; i < authors.length; i++) {
					expect(authors[i]?.value).toBe(families[i]?.[0] as FamilyKey);
					expect(authors[i]?.items.map((m) => m.id)).toEqual(
						families[i]?.[1].map((m) => m.id) ?? []
					);
				}
			}),
			{ numRuns: 200 }
		);
	});
});
