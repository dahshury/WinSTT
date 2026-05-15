import { describe, expect, test } from "bun:test";
import type { OpenRouterEndpoint, OpenRouterPricing } from "@/shared/api/models";
import {
	__classifyAvgCost,
	__variantIconMap,
	formatContextLength,
	formatPricing,
	getPricingTier,
	getUniqueEndpoints,
	getVariantClasses,
	getVariantIcon,
} from "./model-selector-display-utils";

describe("formatContextLength", () => {
	test("formats million-scale lengths with one decimal", () => {
		expect(formatContextLength(1_000_000)).toBe("1.0M");
		expect(formatContextLength(1_500_000)).toBe("1.5M");
	});

	test("formats thousand-scale lengths rounded to integer K", () => {
		expect(formatContextLength(1000)).toBe("1K");
		expect(formatContextLength(128_000)).toBe("128K");
	});

	test("formats sub-thousand as plain integer", () => {
		expect(formatContextLength(512)).toBe("512");
	});
});

describe("getPricingTier", () => {
	test("free pricing returns 'Free' tier", () => {
		expect(getPricingTier({ prompt: 0, completion: 0 } as unknown as OpenRouterPricing).tier).toBe(
			"free"
		);
	});

	test("string prices are parsed and feed the same tiering logic", () => {
		// avg of $1 + $2 per 1M = $1.5 → medium
		expect(
			getPricingTier({
				prompt: "0.000001",
				completion: "0.000002",
			} as unknown as OpenRouterPricing).tier
		).toBe("medium");
	});

	test("avg < $1/M → low tier", () => {
		expect(
			getPricingTier({
				prompt: 0.000_000_5,
				completion: 0.000_000_5,
			} as unknown as OpenRouterPricing).tier
		).toBe("low");
	});

	test("avg in [$1, $10)/M → medium tier", () => {
		expect(
			getPricingTier({ prompt: 0.000_003, completion: 0.000_005 } as unknown as OpenRouterPricing)
				.tier
		).toBe("medium");
	});

	test("avg >= $10/M → high tier", () => {
		expect(
			getPricingTier({ prompt: 0.0001, completion: 0.0001 } as unknown as OpenRouterPricing).tier
		).toBe("high");
	});

	test("undefined pricing → 'Free'", () => {
		expect(getPricingTier(undefined).tier).toBe("free");
	});

	test("non-numeric string price treated as 0", () => {
		expect(
			getPricingTier({ prompt: "not a number", completion: "0" } as unknown as OpenRouterPricing)
				.tier
		).toBe("free");
	});
});

describe("formatPricing", () => {
	test("returns 'Free' for zero pricing", () => {
		expect(formatPricing({ prompt: 0, completion: 0 } as unknown as OpenRouterPricing)).toBe(
			"Free"
		);
	});

	test("formats per-1M USD pricing string", () => {
		const out = formatPricing({
			prompt: 0.000_001,
			completion: 0.000_002,
		} as unknown as OpenRouterPricing);
		expect(out).toContain("$1.00");
		expect(out).toContain("$2.00");
		expect(out).toContain("per 1M");
	});
});

describe("getUniqueEndpoints", () => {
	test("dedupes endpoints by provider_name keeping first occurrence", () => {
		const eps: OpenRouterEndpoint[] = [
			{ provider_name: "openai" } as OpenRouterEndpoint,
			{ provider_name: "deepinfra" } as OpenRouterEndpoint,
			{ provider_name: "openai" } as OpenRouterEndpoint,
		];
		const unique = getUniqueEndpoints(eps);
		expect(unique.map((e) => e.provider_name)).toEqual(["openai", "deepinfra"]);
	});

	test("empty input returns empty array", () => {
		expect(getUniqueEndpoints([])).toEqual([]);
	});
});

describe("getVariantIcon and getVariantClasses", () => {
	test("getVariantIcon returns a node for every known variant", () => {
		for (const variant of [
			"free",
			"nitro",
			"extended",
			"exacto",
			"thinking",
			"online",
			"floor",
		] as const) {
			expect(getVariantIcon(variant)).not.toBeNull();
		}
	});

	test("getVariantClasses returns the styling object for a variant", () => {
		const classes = getVariantClasses("nitro");
		expect(classes.bg).toBeDefined();
		expect(classes.text).toBeDefined();
		expect(classes.border).toBeDefined();
		expect(classes.gradient).toBeDefined();
	});
});

describe("classifyAvgCost (extracted from getPricingTier)", () => {
	test("avgCost < 1 → low tier", () => {
		expect(__classifyAvgCost(0.5).tier).toBe("low");
	});

	test("avgCost in [1, 10) → medium tier", () => {
		expect(__classifyAvgCost(5).tier).toBe("medium");
		expect(__classifyAvgCost(1).tier).toBe("medium");
	});

	test("avgCost >= 10 → high tier", () => {
		expect(__classifyAvgCost(10).tier).toBe("high");
		expect(__classifyAvgCost(100).tier).toBe("high");
	});

	test("low tier has green class", () => {
		expect(__classifyAvgCost(0.1).className).toContain("green");
	});

	test("medium tier has amber class", () => {
		expect(__classifyAvgCost(5).className).toContain("amber");
	});

	test("high tier has rose class", () => {
		expect(__classifyAvgCost(50).className).toContain("rose");
	});
});

describe("VARIANT_ICON_MAP", () => {
	test("maps every known variant to an icon", () => {
		for (const variant of [
			"free",
			"nitro",
			"extended",
			"exacto",
			"thinking",
			"online",
			"floor",
		] as const) {
			expect(__variantIconMap[variant]).toBeDefined();
		}
	});
});
