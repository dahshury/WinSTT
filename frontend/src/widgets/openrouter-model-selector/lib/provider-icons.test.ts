import { describe, expect, test } from "bun:test";
import {
	__provider_icons_test_helpers__,
	getProviderIcon,
	getProviderIconWithFallback,
	PROVIDER_ICONS,
} from "./provider-icons";

describe("getProviderIcon", () => {
	test("returns the icon for a known provider", () => {
		expect(getProviderIcon("openai")).toBe(PROVIDER_ICONS.openai ?? null);
		expect(getProviderIcon("google")).toBe(PROVIDER_ICONS.google ?? null);
	});

	test("returns null for null / undefined input", () => {
		expect(getProviderIcon(null)).toBeNull();
		expect(getProviderIcon(undefined)).toBeNull();
		expect(getProviderIcon("")).toBeNull();
	});

	test("normalizes case and whitespace", () => {
		expect(getProviderIcon(" OpenAI ")).toBe(PROVIDER_ICONS.openai ?? null);
	});

	test("maps known short aliases (meta → meta-llama, xai → x-ai, mistral → mistralai)", () => {
		expect(getProviderIcon("meta")).toBe(PROVIDER_ICONS["meta-llama"] ?? null);
		expect(getProviderIcon("xai")).toBe(PROVIDER_ICONS["x-ai"] ?? null);
		expect(getProviderIcon("mistral")).toBe(PROVIDER_ICONS.mistralai ?? null);
	});

	test("returns null for fully-unknown providers", () => {
		expect(getProviderIcon("zzzz-unknown")).toBeNull();
	});
});

describe("getProviderIconWithFallback", () => {
	test("returns the resolved icon when known", () => {
		expect(getProviderIconWithFallback("openai")).toBe(PROVIDER_ICONS.openai ?? "");
	});

	test("falls back to openrouter icon when unknown and no fallback supplied", () => {
		expect(getProviderIconWithFallback("zzzz-unknown")).toBe("/provider-icons/openrouter.png");
	});

	test("uses provided fallback when unknown", () => {
		expect(getProviderIconWithFallback("zzzz", "/custom.png")).toBe("/custom.png");
	});

	test("uses provided fallback when input is null", () => {
		expect(getProviderIconWithFallback(null, "/custom.png")).toBe("/custom.png");
	});
});

const {
	PROVIDER_NAME_ALIASES,
	findExactProviderKey,
	findAliasProviderKey,
	findFuzzyProviderKey,
	isFuzzyMatch,
	normalizeProviderName,
} = __provider_icons_test_helpers__;

describe("PROVIDER_NAME_ALIASES", () => {
	test.each([
		["meta", "meta-llama"],
		["mistral", "mistralai"],
		["xai", "x-ai"],
	])("alias %s → %s", (alias, target) => {
		expect(PROVIDER_NAME_ALIASES[alias]).toBe(target);
	});

	test("unknown alias returns undefined", () => {
		expect(PROVIDER_NAME_ALIASES.unknownalias).toBeUndefined();
	});
});

describe("findExactProviderKey", () => {
	test.each([
		["openai", "openai"],
		["anthropic", "anthropic"],
		["google", "google"],
		["nope-zzz", null],
	])("findExactProviderKey(%p) → %p", (input, expected) => {
		expect(findExactProviderKey(input)).toBe(expected);
	});
});

describe("findAliasProviderKey", () => {
	test("returns the alias target for known short alias", () => {
		expect(findAliasProviderKey("meta")).toBe("meta-llama");
		expect(findAliasProviderKey("mistral")).toBe("mistralai");
	});

	test("returns null for unknown alias", () => {
		expect(findAliasProviderKey("openai")).toBeNull();
		expect(findAliasProviderKey("nothing")).toBeNull();
	});
});

describe("isFuzzyMatch", () => {
	test.each([
		["openai", "openai", true], // exact (startsWith)
		["openai", "open", true], // key starts with normalized
		["open", "openai", true], // normalized starts with key
		["openai", "nai", true], // includes
		["abc", "xyz", false],
	])("isFuzzyMatch(%p, %p) → %p", (key, normalized, expected) => {
		expect(isFuzzyMatch(key, normalized)).toBe(expected);
	});
});

describe("findFuzzyProviderKey", () => {
	test("returns first matching key for a partial provider name", () => {
		const out = findFuzzyProviderKey("openai");
		expect(typeof out).toBe("string");
	});

	test("returns null when no key fuzzy-matches", () => {
		expect(findFuzzyProviderKey("xx-no-such-provider-yy")).toBeNull();
	});
});

describe("normalizeProviderName", () => {
	test("returns canonical key for an exact match", () => {
		expect(normalizeProviderName("openai")).toBe("openai");
	});

	test("resolves an alias to its canonical key", () => {
		expect(normalizeProviderName("meta")).toBe("meta-llama");
	});

	test("falls through fuzzy resolver", () => {
		// 'openrouter-extra' fuzzy-matches 'openrouter' via key.startsWith
		expect(normalizeProviderName("openrouter-extra")).toBe("openrouter");
	});

	test("returns the lowercased input when nothing resolves", () => {
		expect(normalizeProviderName("xx-no-such-provider-yy")).toBe("xx-no-such-provider-yy");
	});
});
