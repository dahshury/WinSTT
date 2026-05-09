import { describe, expect, test } from "bun:test";
import {
	FILTERABLE_PARAMETERS,
	formatProviderName,
	isKnownProvider,
	OPENROUTER_PROVIDERS,
	PARAMETER_INFO,
	PROVIDER_INFO,
	PROVIDER_SORT_OPTIONS,
} from "./openrouter-provider-utils";

describe("OPENROUTER_PROVIDERS", () => {
	test("contains expected canonical providers", () => {
		expect(OPENROUTER_PROVIDERS).toContain("anthropic");
		expect(OPENROUTER_PROVIDERS).toContain("openai");
		expect(OPENROUTER_PROVIDERS).toContain("deepinfra");
	});

	test("entries are unique", () => {
		expect(new Set(OPENROUTER_PROVIDERS).size).toBe(OPENROUTER_PROVIDERS.length);
	});
});

describe("PROVIDER_INFO", () => {
	test("has an entry for every provider", () => {
		for (const p of OPENROUTER_PROVIDERS) {
			expect(PROVIDER_INFO[p]).toBeDefined();
			expect(PROVIDER_INFO[p].name.length).toBeGreaterThan(0);
		}
	});
});

describe("isKnownProvider", () => {
	test("returns true for every advertised provider", () => {
		for (const p of OPENROUTER_PROVIDERS) {
			expect(isKnownProvider(p)).toBe(true);
		}
	});

	test("returns false for unknown providers", () => {
		expect(isKnownProvider("unknown-provider")).toBe(false);
		expect(isKnownProvider("")).toBe(false);
	});
});

describe("formatProviderName", () => {
	test("returns the canonical display name for a known provider", () => {
		expect(formatProviderName("anthropic")).toBe("Anthropic");
		expect(formatProviderName("xai")).toBe("xAI");
	});

	test("title-cases hyphenated unknown slugs", () => {
		expect(formatProviderName("acme-corp")).toBe("Acme Corp");
	});

	test("title-cases a single-word unknown slug", () => {
		expect(formatProviderName("foo")).toBe("Foo");
	});
});

describe("PROVIDER_SORT_OPTIONS", () => {
	test("includes the default (load-balanced) option with undefined value", () => {
		const def = PROVIDER_SORT_OPTIONS.find((o) => o.value === undefined);
		expect(def).toBeDefined();
	});

	test("price/throughput/latency options are present", () => {
		const values = PROVIDER_SORT_OPTIONS.map((o) => o.value);
		expect(values).toContain("price");
		expect(values).toContain("throughput");
		expect(values).toContain("latency");
	});
});

describe("FILTERABLE_PARAMETERS / PARAMETER_INFO", () => {
	test("every filterable parameter has a matching info entry", () => {
		for (const p of FILTERABLE_PARAMETERS) {
			expect(PARAMETER_INFO[p]).toBeDefined();
			expect(PARAMETER_INFO[p].label.length).toBeGreaterThan(0);
		}
	});
});
