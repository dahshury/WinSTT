import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ModelInfo } from "@/entities/model-catalog";
import { parseSizeLabel } from "./realtime-viability";
import { isEnglishOnly, isMultilingual, summarizeFamily, variantMeta } from "./variant-helpers";

// Property tests for the per-variant classifier and family summary. The
// invariants we care about:
//   - englishOnly and multilingual are mutually exclusive
//   - summarizeFamily.variantCount equals the input length
//   - parsed size range satisfies min ≤ max for any non-empty parseable set
//   - realtimeCount is bounded by variantCount

// Language code list — deliberately small so we sometimes generate `["en"]`
// (English-only) and sometimes a multilingual `[]`.
const langArb: fc.Arbitrary<string[]> = fc.oneof(
	fc.constant<string[]>([]), // multilingual
	fc.constant<string[]>(["en"]), // english-only via sole-en
	fc.constant<string[]>(["ru"]),
	fc.constant<string[]>(["de", "ru"]),
	fc.constant<string[]>(["fr"])
);

// Size labels — mix parseable and unparseable.
const sizeLabelArb: fc.Arbitrary<string> = fc.oneof(
	fc.constantFrom("39M", "244M", "600M", "769M", "1.5B", "0.6M", "150M"),
	fc.constantFrom("", "unknown", "39MB", "abc")
);

const idArb: fc.Arbitrary<string> = fc.oneof(
	fc.string({ minLength: 1, maxLength: 8 }),
	fc.string({ minLength: 1, maxLength: 8 }).map((s) => `${s}.en`)
);

function makeModel(
	id: string,
	languages: string[],
	sizeLabel: string,
	supportsRealtime: boolean
): ModelInfo {
	return {
		id,
		displayName: id,
		family: "whisper",
		backend: "onnx_asr",
		languages,
		supportsLanguageDetection: true,
		sizeLabel,
		supportsRealtime,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
	} as ModelInfo;
}

const modelArb: fc.Arbitrary<ModelInfo> = fc
	.tuple(idArb, langArb, sizeLabelArb, fc.boolean())
	.map(([id, langs, size, rt]) => makeModel(id, langs, size, rt));

const modelsArb: fc.Arbitrary<ModelInfo[]> = fc.array(modelArb, {
	minLength: 1,
	maxLength: 15,
});

describe("variant classification properties", () => {
	test("englishOnly and multilingual are mutually exclusive for non-.en ids", () => {
		// .en-suffixed ids are *always* englishOnly even with languages=[], so
		// the disjointness only holds outside that override.
		const nonDotEnModelArb = modelArb.filter((m) => !m.id.endsWith(".en"));
		fc.assert(
			fc.property(nonDotEnModelArb, (m) => {
				const en = isEnglishOnly(m);
				const multi = isMultilingual(m);
				expect(en && multi).toBe(false);
			}),
			{ numRuns: 300 }
		);
	});

	test("variantMeta booleans match the individual predicates", () => {
		fc.assert(
			fc.property(modelArb, (m) => {
				const meta = variantMeta(m);
				expect(meta.englishOnly).toBe(isEnglishOnly(m));
				expect(meta.multilingual).toBe(isMultilingual(m));
				// realtime is a boolean (no exceptions on garbage size labels).
				expect(typeof meta.realtime).toBe("boolean");
			}),
			{ numRuns: 300 }
		);
	});
});

describe("summarizeFamily properties", () => {
	test("variantCount equals the input length for any non-empty input", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				expect(summarizeFamily(models).variantCount).toBe(models.length);
			}),
			{ numRuns: 300 }
		);
	});

	test("realtimeCount is bounded by variantCount and non-negative", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				const s = summarizeFamily(models);
				expect(s.realtimeCount).toBeGreaterThanOrEqual(0);
				expect(s.realtimeCount).toBeLessThanOrEqual(s.variantCount);
			}),
			{ numRuns: 300 }
		);
	});

	test("size range parses to min ≤ max whenever any size is parseable", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				const s = summarizeFamily(models);
				if (s.sizeRange === "") {
					// All sizes unparseable — nothing to verify.
					return;
				}
				// sizeRange is either "X" (single size) or "X – Y" (range).
				const parts = s.sizeRange.split(" – ");
				if (parts.length === 1) {
					expect(parseSizeLabel(parts[0] ?? "")).not.toBeNull();
					return;
				}
				const minParams = parseSizeLabel(parts[0] ?? "");
				const maxParams = parseSizeLabel(parts[1] ?? "");
				expect(minParams).not.toBeNull();
				expect(maxParams).not.toBeNull();
				if (minParams !== null && maxParams !== null) {
					expect(minParams).toBeLessThanOrEqual(maxParams);
				}
			}),
			{ numRuns: 300 }
		);
	});

	test("hasMultilingual / hasEnglishOnly mirror per-model predicates", () => {
		fc.assert(
			fc.property(modelsArb, (models) => {
				const s = summarizeFamily(models);
				expect(s.hasMultilingual).toBe(models.some(isMultilingual));
				expect(s.hasEnglishOnly).toBe(models.some(isEnglishOnly));
			}),
			{ numRuns: 300 }
		);
	});
});
