import { describe, test } from "bun:test";
import fc from "fast-check";
import type { OpenRouterModel } from "@/shared/api/models";
import {
	computeModelExclusionConfig,
	filterModelsForFallback,
	isAutoModel,
	isEndpointExcluded,
	isFallbackExcluded,
	OPENROUTER_AUTO_MODEL_ID,
} from "./model-exclusion";

// Model-id arbitrary that won't be confused with auto and won't contain "@".
const modelIdArb = fc
	.string({ minLength: 1, maxLength: 30 })
	.filter((s) => !s.includes("@") && s !== OPENROUTER_AUTO_MODEL_ID && s.trim() !== "");
const providerSlugArb = fc.string({ minLength: 1, maxLength: 15 }).filter((s) => !s.includes("@"));

// Build a sample OpenRouterModel; only `id` and `name` are checked downstream.
function makeModel(id: string): OpenRouterModel {
	return { id, name: id, endpoints: [] } as unknown as OpenRouterModel;
}

const modelListArb = fc
	.uniqueArray(modelIdArb, { minLength: 1, maxLength: 8 })
	.map((ids) => ids.map(makeModel));

describe("filterModelsForFallback property tests", () => {
	test("output is always a subset of input (no synthesised entries)", () => {
		fc.assert(
			fc.property(modelListArb, fc.option(modelIdArb, { nil: undefined }), (models, excludeId) => {
				const cfg = computeModelExclusionConfig(excludeId);
				const out = filterModelsForFallback(models, cfg);
				return out.every((m) => models.some((src) => src.id === m.id));
			}),
			{ numRuns: 250 }
		);
	});

	test("idempotent: filter(filter(x)) deep-equals filter(x)", () => {
		fc.assert(
			fc.property(modelListArb, fc.option(modelIdArb, { nil: undefined }), (models, excludeId) => {
				const cfg = computeModelExclusionConfig(excludeId);
				const once = filterModelsForFallback(models, cfg);
				const twice = filterModelsForFallback(once, cfg);
				return once.length === twice.length && once.every((m, i) => m.id === twice[i]?.id);
			}),
			{ numRuns: 250 }
		);
	});

	test("preserves input order (no re-sorting)", () => {
		fc.assert(
			fc.property(modelListArb, fc.option(modelIdArb, { nil: undefined }), (models, excludeId) => {
				const cfg = computeModelExclusionConfig(excludeId);
				const out = filterModelsForFallback(models, cfg);
				const inputOrder = models.map((m) => m.id);
				const outputOrder = out.map((m) => m.id);
				// Output order must be a subsequence of input order.
				let i = 0;
				for (const id of outputOrder) {
					while (i < inputOrder.length && inputOrder[i] !== id) {
						i++;
					}
					if (i >= inputOrder.length) {
						return false;
					}
					i++;
				}
				return true;
			}),
			{ numRuns: 250 }
		);
	});

	test("when primary is auto/empty, filter is identity (same reference)", () => {
		fc.assert(
			fc.property(
				modelListArb,
				fc.constantFrom("", null, undefined, OPENROUTER_AUTO_MODEL_ID, "   "),
				(models, primary) => {
					const cfg = computeModelExclusionConfig(primary as string | null | undefined);
					return filterModelsForFallback(models, cfg) === models;
				}
			),
			{ numRuns: 200 }
		);
	});
});

describe("isAutoModel property tests", () => {
	test("returns true for empty/whitespace/null/undefined", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.constant(""),
					fc.constant(null),
					fc.constant(undefined),
					fc.stringMatching(/^[\s]*$/)
				),
				(value) => isAutoModel(value as string | null | undefined) === true
			),
			{ numRuns: 200 }
		);
	});

	test("returns false for any non-auto model id", () => {
		fc.assert(
			fc.property(modelIdArb, fc.option(providerSlugArb, { nil: undefined }), (id, slug) => {
				const value = slug ? `${id}@${slug}` : id;
				return isAutoModel(value) === false;
			}),
			{ numRuns: 250 }
		);
	});
});

describe("isFallbackExcluded / isEndpointExcluded property tests", () => {
	test("when no exclusion configured, both functions return false for ANY input", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("", null, undefined, OPENROUTER_AUTO_MODEL_ID),
				modelIdArb,
				fc.option(providerSlugArb, { nil: undefined }),
				(primary, fbId, fbSlug) => {
					const cfg = computeModelExclusionConfig(primary as string | null | undefined);
					const fbValue = fbSlug ? `${fbId}@${fbSlug}` : fbId;
					return (
						isFallbackExcluded(fbValue, cfg) === false &&
						isEndpointExcluded(fbId, fbSlug, cfg) === false
					);
				}
			),
			{ numRuns: 200 }
		);
	});

	test("deterministic: same args → same answer", () => {
		fc.assert(
			fc.property(
				modelIdArb,
				fc.option(providerSlugArb, { nil: undefined }),
				modelIdArb,
				fc.option(providerSlugArb, { nil: undefined }),
				(primaryId, primarySlug, fbId, fbSlug) => {
					const primary = primarySlug ? `${primaryId}@${primarySlug}` : primaryId;
					const cfg = computeModelExclusionConfig(primary);
					const fbValue = fbSlug ? `${fbId}@${fbSlug}` : fbId;
					const fbA = isFallbackExcluded(fbValue, cfg);
					const fbB = isFallbackExcluded(fbValue, cfg);
					const epA = isEndpointExcluded(fbId, fbSlug, cfg);
					const epB = isEndpointExcluded(fbId, fbSlug, cfg);
					return fbA === fbB && epA === epB;
				}
			),
			{ numRuns: 200 }
		);
	});

	test("isFallbackExcluded ⇔ isEndpointExcluded(parsed parts)", () => {
		fc.assert(
			fc.property(
				modelIdArb,
				fc.option(providerSlugArb, { nil: undefined }),
				modelIdArb,
				fc.option(providerSlugArb, { nil: undefined }),
				(primaryId, primarySlug, fbId, fbSlug) => {
					const primary = primarySlug ? `${primaryId}@${primarySlug}` : primaryId;
					const cfg = computeModelExclusionConfig(primary);
					const fbValue = fbSlug ? `${fbId}@${fbSlug}` : fbId;
					return isFallbackExcluded(fbValue, cfg) === isEndpointExcluded(fbId, fbSlug, cfg);
				}
			),
			{ numRuns: 250 }
		);
	});
});
