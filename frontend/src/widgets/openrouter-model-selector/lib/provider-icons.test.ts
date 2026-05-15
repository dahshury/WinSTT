import { describe, expect, test } from "bun:test";
import {
	__provider_icons_test_helpers__,
	getProviderIcon,
	getProviderIconWithFallback,
	PROVIDER_ICONS,
} from "./provider-icons";

// Full pinned table — every entry asserted against its literal path. Without
// this, StringLiteral mutations to "" on each provider value would survive
// because other tests compare to the (mutated) PROVIDER_ICONS map itself.
const EXPECTED_PROVIDER_PATHS: Record<string, string> = {
	ai21: "/provider-icons/ai21.png",
	"aion-labs": "/provider-icons/aion-labs.png",
	alfredpros: "/provider-icons/alfredpros.png",
	alibaba: "/provider-icons/alibaba.png",
	allenai: "/provider-icons/allenai.png",
	alpindale: "/provider-icons/alpindale.png",
	amazon: "/provider-icons/amazon.png",
	"anthracite-org": "/provider-icons/anthracite-org.png",
	anthropic: "/provider-icons/anthropic.png",
	"arcee-ai": "/provider-icons/arcee-ai.png",
	arliai: "/provider-icons/arliai.png",
	baidu: "/provider-icons/baidu.png",
	bytedance: "/provider-icons/bytedance.png",
	cognitivecomputations: "/provider-icons/cognitivecomputations.png",
	cohere: "/provider-icons/cohere.png",
	deepcogito: "/provider-icons/deepcogito.png",
	deepseek: "/provider-icons/deepseek.png",
	eleutherai: "/provider-icons/eleutherai.png",
	essentialai: "/provider-icons/essentialai.png",
	google: "/provider-icons/google.svg",
	gryphe: "/provider-icons/gryphe.png",
	"ibm-granite": "/provider-icons/ibm-granite.webp",
	inception: "/provider-icons/inception.png",
	inflection: "/provider-icons/inflection.png",
	kwaipilot: "/provider-icons/kwaipilot.png",
	liquid: "/provider-icons/liquid.png",
	mancer: "/provider-icons/mancer.png",
	meituan: "/provider-icons/meituan.png",
	"meta-llama": "/provider-icons/meta-llama.png",
	microsoft: "/provider-icons/microsoft.svg",
	minimax: "/provider-icons/minimax.png",
	mistralai: "/provider-icons/mistralai.png",
	moonshotai: "/provider-icons/moonshotai.png",
	morph: "/provider-icons/morph.png",
	neversleep: "/provider-icons/neversleep.webp",
	"nex-agi": "/provider-icons/nex-agi.png",
	nousresearch: "/provider-icons/nousresearch.png",
	nvidia: "/provider-icons/nvidia.png",
	openai: "/provider-icons/openai.png",
	opengvlab: "/provider-icons/opengvlab.png",
	openrouter: "/provider-icons/openrouter.png",
	perplexity: "/provider-icons/perplexity.svg",
	"prime-intellect": "/provider-icons/prime-intellect.png",
	qwen: "/provider-icons/qwen.png",
	raifle: "/provider-icons/raifle.png",
	relace: "/provider-icons/relace.png",
	sao10k: "/provider-icons/sao10k.png",
	"stepfun-ai": "/provider-icons/stepfun-ai.png",
	switchpoint: "/provider-icons/switchpoint.png",
	tencent: "/provider-icons/tencent.png",
	thedrummer: "/provider-icons/thedrummer.png",
	thudm: "/provider-icons/thudm.webp",
	tngtech: "/provider-icons/tngtech.png",
	undi95: "/provider-icons/undi95.png",
	"x-ai": "/provider-icons/x-ai.png",
	xiaomi: "/provider-icons/xiaomi.webp",
	"z-ai": "/provider-icons/z-ai.png",
};

describe("PROVIDER_ICONS literal values", () => {
	test.each(
		Object.entries(EXPECTED_PROVIDER_PATHS)
	)("PROVIDER_ICONS[%p] === %p", (key, expected) => {
		expect(PROVIDER_ICONS[key]).toBe(expected);
	});

	test("PROVIDER_ICONS exposes exactly the expected provider keys", () => {
		// Detect accidental additions or removals of provider entries.
		expect(Object.keys(PROVIDER_ICONS).sort()).toEqual(Object.keys(EXPECTED_PROVIDER_PATHS).sort());
	});
});

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
