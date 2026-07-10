import { describe, expect, test } from "bun:test";
import {
	formatContextTokens,
	formatLanguageSummary,
	formatSpecDate,
	priceTierFromPricing,
	specStat,
} from "./model-spec-format";

describe("formatSpecDate", () => {
	test("formats YYYY-MM and YYYY-MM-DD to 'Mon YYYY'", () => {
		expect(formatSpecDate("2025-09")).toBe("Sep 2025");
		expect(formatSpecDate("2025-09-05")).toBe("Sep 2025");
		expect(formatSpecDate("2024-01-31")).toBe("Jan 2024");
	});

	test("passes through unexpected shapes and null-empties", () => {
		expect(formatSpecDate("early 2025")).toBe("early 2025");
		expect(formatSpecDate(undefined)).toBeNull();
		expect(formatSpecDate("")).toBeNull();
	});
});

describe("formatContextTokens", () => {
	test("compacts thousands and millions", () => {
		expect(formatContextTokens(256_000)).toBe("256K");
		expect(formatContextTokens(1_048_576)).toBe("1M");
		expect(formatContextTokens(2_000_000)).toBe("2M");
		expect(formatContextTokens(512)).toBe("512");
	});

	test("rejects non-positive / non-finite", () => {
		expect(formatContextTokens(0)).toBeNull();
		expect(formatContextTokens(-5)).toBeNull();
		expect(formatContextTokens(undefined)).toBeNull();
		expect(formatContextTokens(Number.NaN)).toBeNull();
	});
});

describe("formatLanguageSummary", () => {
	test("names for few, count for many", () => {
		expect(formatLanguageSummary([])).toBeNull();
		expect(formatLanguageSummary(["English"])).toBe("English");
		expect(formatLanguageSummary(["English", "Arabic"])).toBe(
			"English, Arabic",
		);
		expect(
			formatLanguageSummary(["English", "Arabic", "French", "German"]),
		).toBe("4 languages");
	});
});

describe("specStat", () => {
	test("drops the 0.5 unknown sentinel and non-positive scores", () => {
		expect(specStat("a", "Accuracy", 0.5)).toBeNull();
		expect(specStat("a", "Accuracy", 0)).toBeNull();
		expect(specStat("a", "Accuracy", Number.NaN)).toBeNull();
	});

	test("keeps real scores", () => {
		expect(specStat("a", "Accuracy", 0.82)).toEqual({
			key: "a",
			label: "Accuracy",
			score: 0.82,
		});
	});
});

describe("priceTierFromPricing", () => {
	test("free model → no chip", () => {
		expect(priceTierFromPricing({ prompt: "0", completion: "0" })).toBeNull();
		expect(priceTierFromPricing({})).toBeNull();
	});

	test("tiers off the worst of input/output per-million cost", () => {
		// $0.30 in, $0.30 out per token*1e6 → worst 0.3 ≤ 1 → tier 1
		expect(
			priceTierFromPricing({
				prompt: "0.0000003",
				completion: "0.0000003",
			})?.tier,
		).toBe(1);
		// $3 in, $15 out → worst 15 → tier 3
		expect(
			priceTierFromPricing({ prompt: "0.000003", completion: "0.000015" })
				?.tier,
		).toBe(3);
		// $2 in, $6 out → worst 6 ≤ 10 → tier 2
		expect(
			priceTierFromPricing({ prompt: "0.000002", completion: "0.000006" })
				?.tier,
		).toBe(2);
	});

	test("label reports both legs per million tokens", () => {
		const info = priceTierFromPricing({
			prompt: "0.000003",
			completion: "0.000015",
		});
		expect(info?.label).toContain("in");
		expect(info?.label).toContain("out");
	});
});
