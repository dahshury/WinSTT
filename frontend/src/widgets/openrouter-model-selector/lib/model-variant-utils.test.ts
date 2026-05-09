import { describe, expect, test } from "bun:test";
import {
	filterByVariant,
	getAvailableVariants,
	getBaseModelId,
	getModelVariant,
	hasAnyVariant,
	hasVariant,
	MODEL_VARIANTS,
	parseModelVariant,
	setModelVariant,
} from "./model-variant-utils";

describe("MODEL_VARIANTS", () => {
	test("contains the canonical 7 variants", () => {
		expect(MODEL_VARIANTS).toContain("free");
		expect(MODEL_VARIANTS).toContain("nitro");
		expect(MODEL_VARIANTS).toHaveLength(7);
	});
});

describe("parseModelVariant", () => {
	test("strips known variant suffix", () => {
		expect(parseModelVariant("openai/gpt-4o:nitro")).toEqual({
			baseModelId: "openai/gpt-4o",
			variant: "nitro",
		});
	});

	test("returns undefined variant when none present", () => {
		expect(parseModelVariant("openai/gpt-4o")).toEqual({
			baseModelId: "openai/gpt-4o",
			variant: undefined,
		});
	});

	test("does not split unknown suffixes", () => {
		expect(parseModelVariant("openai/gpt-4o:custom")).toEqual({
			baseModelId: "openai/gpt-4o:custom",
			variant: undefined,
		});
	});
});

describe("getModelVariant / getBaseModelId / hasVariant / hasAnyVariant", () => {
	test("getModelVariant", () => {
		expect(getModelVariant("openai/gpt-4o:thinking")).toBe("thinking");
		expect(getModelVariant("openai/gpt-4o")).toBeUndefined();
	});

	test("getBaseModelId", () => {
		expect(getBaseModelId("openai/gpt-4o:nitro")).toBe("openai/gpt-4o");
		expect(getBaseModelId("openai/gpt-4o")).toBe("openai/gpt-4o");
	});

	test("hasVariant", () => {
		expect(hasVariant("openai/gpt-4o:free", "free")).toBe(true);
		expect(hasVariant("openai/gpt-4o:free", "nitro")).toBe(false);
	});

	test("hasAnyVariant", () => {
		expect(hasAnyVariant("openai/gpt-4o:nitro")).toBe(true);
		expect(hasAnyVariant("openai/gpt-4o")).toBe(false);
		expect(hasAnyVariant("openai/gpt-4o:custom")).toBe(false);
	});
});

describe("setModelVariant", () => {
	test("appends a variant if absent", () => {
		expect(setModelVariant("openai/gpt-4o", "nitro")).toBe("openai/gpt-4o:nitro");
	});

	test("replaces an existing variant", () => {
		expect(setModelVariant("openai/gpt-4o:nitro", "free")).toBe("openai/gpt-4o:free");
	});

	test("removes the variant when set to undefined", () => {
		expect(setModelVariant("openai/gpt-4o:nitro", undefined)).toBe("openai/gpt-4o");
	});
});

describe("getAvailableVariants", () => {
	test("returns the unique set of variants present in the input list, in canonical order", () => {
		const result = getAvailableVariants([
			"a:nitro",
			"b:free",
			"c:nitro",
			"d", // no variant
			"e:thinking",
		]);
		expect(result).toEqual(["free", "nitro", "thinking"]);
	});

	test("empty input → empty output", () => {
		expect(getAvailableVariants([])).toEqual([]);
	});
});

describe("filterByVariant", () => {
	test("undefined variant → returns models with no variant suffix", () => {
		expect(filterByVariant(["a", "b:free", "c", "d:nitro"], undefined)).toEqual(["a", "c"]);
	});

	test("specific variant → returns only that variant's models", () => {
		expect(filterByVariant(["a", "b:free", "c", "d:free"], "free")).toEqual(["b:free", "d:free"]);
	});
});
