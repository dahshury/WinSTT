import { describe, expect, test } from "bun:test";
import {
	__model_selector_utils_test_helpers__,
	capitalize,
	formatMaker,
	formatModelName,
	formatProvider,
	getUniqueValues,
} from "./model-selector-utils";

describe("capitalize", () => {
	test("uppercases the first character", () => {
		expect(capitalize("foo")).toBe("Foo");
		expect(capitalize("bar baz")).toBe("Bar baz");
	});

	test("returns empty string for empty input", () => {
		expect(capitalize("")).toBe("");
	});
});

describe("formatProvider", () => {
	test("returns 'OpenRouter' for empty/undefined", () => {
		expect(formatProvider()).toBe("OpenRouter");
		expect(formatProvider(undefined)).toBe("OpenRouter");
	});

	test("special-cases microsoft/azure", () => {
		expect(formatProvider("microsoft/azure")).toBe("Microsoft Azure");
	});

	test("capitalizes any other slug", () => {
		expect(formatProvider("deepinfra")).toBe("Deepinfra");
	});
});

describe("formatMaker", () => {
	test.each([
		[undefined, "Unknown"],
		["openai", "OpenAI"],
		["anthropic", "Anthropic"],
		["google", "Google"],
		["meta", "Meta"],
		["mistral", "Mistral"],
		["someother", "Someother"],
	])("formatMaker(%p) → %p", (input, expected) => {
		expect(formatMaker(input)).toBe(expected);
	});
});

describe("formatModelName", () => {
	test("returns empty string for falsy input", () => {
		expect(formatModelName("")).toBe("");
		expect(formatModelName(null)).toBe("");
		expect(formatModelName(undefined)).toBe("");
	});

	test("strips the 'maker/' prefix and the ':variant' suffix", () => {
		expect(formatModelName("openai/gpt-4o:latest")).toBe("GPT-4o");
	});

	test("merges GPT + version into a hyphenated 'GPT-4o' token", () => {
		expect(formatModelName("openai/gpt-4o")).toBe("GPT-4o");
	});

	test("handles known token map entries (Claude, Llama, Mistral)", () => {
		expect(formatModelName("anthropic/claude-3-haiku")).toBe("Claude 3 Haiku");
		expect(formatModelName("meta/llama-3-70b")).toBe("Llama 3 70b");
		expect(formatModelName("mistral/mistral-large")).toBe("Mistral Large");
	});

	test("preserves purely-numeric version-like tokens lowercased", () => {
		// pure-digit/version-only token is detected by KNOWN_VERSION_REGEX
		expect(formatModelName("foo/3.5")).toBe("3.5");
		// 'v3.5' starts with a letter so the regex misses → falls back to capitalize
		expect(formatModelName("foo/v3.5")).toBe("V3.5");
	});

	test("returns the original name when split produces no tokens", () => {
		expect(formatModelName("/")).toBe("/");
	});
});

describe("getUniqueValues", () => {
	test("returns sorted unique values, dropping undefined", () => {
		expect(getUniqueValues([1, 2, 1, undefined, 3, 2])).toEqual([1, 2, 3]);
	});

	test("respects an optional filter predicate", () => {
		expect(getUniqueValues([1, 2, 3, 4], (v) => v % 2 === 0)).toEqual([2, 4]);
	});

	test("empty input → empty array", () => {
		expect(getUniqueValues([])).toEqual([]);
	});
});

const {
	PROVIDER_DISPLAY_OVERRIDES,
	MAKER_DISPLAY_OVERRIDES,
	VERSION_HYPHEN_PREFIXES,
	stripModelNamespace,
	tokenizeModelCore,
	mergeVersionTokens,
	shouldMergeVersion,
	isVersionMergeablePrev,
	shouldKeepUnique,
	formatModelToken,
} = __model_selector_utils_test_helpers__;

describe("PROVIDER_DISPLAY_OVERRIDES / MAKER_DISPLAY_OVERRIDES / VERSION_HYPHEN_PREFIXES", () => {
	test("PROVIDER_DISPLAY_OVERRIDES contains the microsoft/azure mapping", () => {
		expect(PROVIDER_DISPLAY_OVERRIDES["microsoft/azure"]).toBe("Microsoft Azure");
	});

	test("MAKER_DISPLAY_OVERRIDES contains expected makers", () => {
		expect(MAKER_DISPLAY_OVERRIDES.openai).toBe("OpenAI");
		expect(MAKER_DISPLAY_OVERRIDES.anthropic).toBe("Anthropic");
		expect(MAKER_DISPLAY_OVERRIDES.unknownmaker).toBeUndefined();
	});

	test("VERSION_HYPHEN_PREFIXES is a Set with GPT/o1/o3/o4", () => {
		expect(VERSION_HYPHEN_PREFIXES.has("GPT")).toBe(true);
		expect(VERSION_HYPHEN_PREFIXES.has("o1")).toBe(true);
		expect(VERSION_HYPHEN_PREFIXES.has("Claude")).toBe(false);
	});
});

describe("stripModelNamespace", () => {
	test("strips the slash prefix", () => {
		expect(stripModelNamespace("openai/gpt-4o")).toBe("gpt-4o");
	});

	test("strips the colon variant suffix", () => {
		expect(stripModelNamespace("gpt-4o:nitro")).toBe("gpt-4o");
	});

	test("strips both slash + colon", () => {
		expect(stripModelNamespace("openai/gpt-4o:nitro")).toBe("gpt-4o");
	});

	test("returns input unchanged when neither slash nor colon present", () => {
		expect(stripModelNamespace("plain")).toBe("plain");
	});
});

describe("formatModelToken", () => {
	test("uses MODEL_NAME_TOKEN_MAP entry when present", () => {
		expect(formatModelToken("gpt")).toBe("GPT");
		expect(formatModelToken("claude")).toBe("Claude");
		expect(formatModelToken("4o")).toBe("4o");
	});

	test("preserves a pure version-like token lowercased", () => {
		expect(formatModelToken("3.5")).toBe("3.5");
		expect(formatModelToken("128b")).toBe("128b");
	});

	test("capitalizes other unknown tokens", () => {
		expect(formatModelToken("foobar")).toBe("Foobar");
	});

	test("empty token gracefully returns empty/capitalized", () => {
		expect(formatModelToken("ZZZ")).toBe("Zzz");
	});
});

describe("tokenizeModelCore", () => {
	test("splits on - _ and whitespace, drops empty tokens", () => {
		expect(tokenizeModelCore("gpt-4o_mini turbo")).toEqual(["GPT", "4o", "Mini", "Turbo"]);
	});

	test("returns empty array for input that is only separators", () => {
		expect(tokenizeModelCore("--__  ")).toEqual([]);
	});
});

describe("isVersionMergeablePrev", () => {
	test.each([
		["GPT", true],
		["o1", true],
		["o3", true],
		["o4", true],
		["Claude", false],
		[undefined, false],
	])("isVersionMergeablePrev(%p) → %p", (input, expected) => {
		expect(isVersionMergeablePrev(input)).toBe(expected);
	});
});

describe("shouldMergeVersion", () => {
	test("returns false at index 0", () => {
		expect(shouldMergeVersion("GPT", "4o", 0)).toBe(false);
	});

	test("returns false when current is not a version-like token", () => {
		expect(shouldMergeVersion("GPT", "Mini", 1)).toBe(false);
	});

	test("returns true when prev is mergeable and cur is version-like", () => {
		expect(shouldMergeVersion("GPT", "4o", 1)).toBe(true);
	});

	test("returns false when prev is not in VERSION_HYPHEN_PREFIXES", () => {
		expect(shouldMergeVersion("Claude", "3.5", 1)).toBe(false);
	});
});

describe("mergeVersionTokens", () => {
	test("merges GPT + 4o into GPT-4o", () => {
		expect(mergeVersionTokens(["GPT", "4o"])).toEqual(["GPT-4o"]);
	});

	test("leaves non-mergeable tokens alone", () => {
		expect(mergeVersionTokens(["Claude", "3", "Haiku"])).toEqual(["Claude", "3", "Haiku"]);
	});

	test("empty input → empty output", () => {
		expect(mergeVersionTokens([])).toEqual([]);
	});
});

describe("shouldKeepUnique", () => {
	test("rejects undefined", () => {
		expect(shouldKeepUnique<number>(undefined)).toBe(false);
	});

	test("accepts defined when no filter supplied", () => {
		expect(shouldKeepUnique<number>(1)).toBe(true);
	});

	test("accepts defined when filter passes", () => {
		expect(shouldKeepUnique<number>(2, (v) => v > 1)).toBe(true);
	});

	test("rejects defined when filter fails", () => {
		expect(shouldKeepUnique<number>(0, (v) => v > 1)).toBe(false);
	});
});
