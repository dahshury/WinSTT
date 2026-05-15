import { describe, expect, test } from "bun:test";
import {
	filterByVariant,
	getAvailableVariants,
	getBaseModelId,
	getModelVariant,
	hasAnyVariant,
	hasVariant,
	MODEL_VARIANT_INFO,
	MODEL_VARIANTS,
	type ModelVariant,
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

// ─── MODEL_VARIANT_INFO data contract ────────────────────────────────
// MODEL_VARIANT_INFO is a giant `Record<ModelVariant, ModelVariantInfo>`
// where every entry contains a label, description and four CSS class
// strings. Stryker generates a StringLiteral mutant for each such literal
// and an ObjectLiteral mutant for each entry. Today none of those strings
// is asserted by any test, so all 57 mutants survive. We pin down the
// canonical shape (each entry has the right id, a non-empty label /
// description, and class strings that actually reference the entry's
// Tailwind color family). That's enough to kill every literal mutant.
describe("MODEL_VARIANT_INFO entries", () => {
	test("has an entry for every advertised variant", () => {
		for (const variant of MODEL_VARIANTS) {
			expect(MODEL_VARIANT_INFO[variant]).toBeDefined();
		}
	});

	// Per-variant Tailwind color family. If Stryker mutates one of the
	// `bg-emerald-...` strings to "", `bg-blue-...` to "", etc., the
	// expectation that the bgClass CONTAINS the family name will fire.
	const COLOR_FAMILY: Record<ModelVariant, string> = {
		free: "emerald",
		extended: "blue",
		exacto: "rose",
		nitro: "amber",
		floor: "cyan",
		thinking: "violet",
		online: "sky",
	};

	for (const variant of MODEL_VARIANTS) {
		const info = MODEL_VARIANT_INFO[variant];
		const family = COLOR_FAMILY[variant];

		test(`${variant}.id matches its key (locks in the L39/48/57/66/75/84/93 'id' literals)`, () => {
			expect(info.id).toBe(variant);
		});

		test(`${variant}.label is non-empty (locks in the L40/49/... 'label' literals)`, () => {
			expect(info.label).toBeDefined();
			expect(typeof info.label).toBe("string");
			expect(info.label.length).toBeGreaterThan(0);
		});

		test(`${variant}.description is non-empty (locks in the L41/50/... 'description' literals)`, () => {
			expect(info.description).toBeDefined();
			expect(typeof info.description).toBe("string");
			expect(info.description.length).toBeGreaterThan(0);
		});

		test(`${variant}.bgClass references the ${family} color family (locks in the L42/51/... 'bgClass' literals)`, () => {
			expect(info.bgClass).toContain(family);
			expect(info.bgClass).toContain("bg-");
			expect(info.bgClass).toContain("dark:");
		});

		test(`${variant}.textClass references the ${family} color family (locks in the L43/52/... 'textClass' literals)`, () => {
			expect(info.textClass).toContain(family);
			expect(info.textClass).toContain("text-");
		});

		test(`${variant}.borderClass references the ${family} color family (locks in the L44/53/... 'borderClass' literals)`, () => {
			expect(info.borderClass).toContain(family);
			expect(info.borderClass).toContain("border-");
		});

		test(`${variant}.gradientClass references the ${family} color family (locks in the L45/54/... 'gradientClass' literals)`, () => {
			expect(info.gradientClass).toContain(family);
			expect(info.gradientClass).toContain("from-");
		});
	}

	// Specific label/description literals — pin down ONE deterministic
	// string per entry so the StringLiteral mutator that swaps the label
	// to "" is killed by an exact-equality assertion (the .length>0 check
	// above already does this, but a precise expectation is more robust).
	const EXPECTED_LABELS: Record<ModelVariant, string> = {
		free: "Free",
		extended: "Extended",
		exacto: "Exacto",
		nitro: "Nitro",
		floor: "Floor",
		thinking: "Thinking",
		online: "Online",
	};

	for (const variant of MODEL_VARIANTS) {
		test(`${variant}.label is exactly '${EXPECTED_LABELS[variant]}'`, () => {
			expect(MODEL_VARIANT_INFO[variant].label).toBe(EXPECTED_LABELS[variant]);
		});
	}
});

// ─── getAvailableVariants edge: input contains an unknown suffix ─────
// Locks in the L144 ConditionalExpression `if (variant)` — the mutant
// turning it into `if (true)` would push `undefined` into the variants
// Set, so the resulting array would contain `undefined`. We validate
// that the output contains ONLY valid ModelVariant strings.
describe("getAvailableVariants — undefined-variant guard", () => {
	test("ignores model ids that have no recognized variant suffix", () => {
		// 'a' has no suffix; 'b:foo' has an unknown suffix; 'c:nitro' is valid.
		const result = getAvailableVariants(["a", "b:foo", "c:nitro"]);
		// Output must contain ONLY 'nitro' — no `undefined`, no 'foo'.
		expect(result).toEqual(["nitro"]);
		// No undefined leaked through (the L144 mutant `if (true)` would
		// push the undefined `getModelVariant("a")` into the Set).
		for (const item of result) {
			expect(item).toBeDefined();
			expect((MODEL_VARIANTS as readonly string[]).includes(item)).toBe(true);
		}
	});

	test("an input list of ONLY no-variant ids yields an empty array", () => {
		// Pure no-variant input. The `if (variant)` guard's job is to
		// prevent the empty case from accidentally containing undefined.
		const result = getAvailableVariants(["a", "b", "c"]);
		expect(result).toEqual([]);
		expect(result.length).toBe(0);
	});
});
