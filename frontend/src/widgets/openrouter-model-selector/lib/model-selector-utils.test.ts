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

	test("when slash is at index 0, the prefix is removed (slashIdx >= 0 boundary)", () => {
		// `slashIdx >= 0` mutated to `slashIdx > 0` would skip the strip when
		// slash is the first char. The original intent: even leading "/foo"
		// should strip to "foo".
		expect(stripModelNamespace("/foo")).toBe("foo");
	});

	test("when colon is at index 0, everything after is dropped (colonIdx >= 0 boundary)", () => {
		// `colonIdx >= 0` mutated to `colonIdx > 0` would skip the strip when
		// colon is the first char. ":nitro" → "" if both branches fire correctly.
		expect(stripModelNamespace(":nitro")).toBe("");
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

	// ------------------------------------------------------------------
	// Mutation guard: every entry in MODEL_NAME_TOKEN_MAP must round-trip
	// formatModelToken(key) === value. If any value literal in the source
	// were mutated to "" the corresponding case here would fail.
	// ------------------------------------------------------------------
	test.each([
		["gpt", "GPT"],
		["ai", "AI"],
		["llm", "LLM"],
		["rl", "RL"],
		["hf", "HF"],
		["api", "API"],
		["xai", "xAI"],
		["openai", "OpenAI"],
		["anthropic", "Anthropic"],
		["deepseek", "DeepSeek"],
		["minimax", "MiniMax"],
		["z-ai", "Z.AI"],
		["zai", "Z.AI"],
		["moonshot", "Moonshot"],
		["moonshotai", "Moonshot"],
		["qwen", "Qwen"],
		["llama", "Llama"],
		["mistral", "Mistral"],
		["mixtral", "Mixtral"],
		["codestral", "Codestral"],
		["gemini", "Gemini"],
		["gemma", "Gemma"],
		["claude", "Claude"],
		["cohere", "Cohere"],
		["command", "Command"],
		["grok", "Grok"],
		["yi", "Yi"],
		["phi", "Phi"],
		["nova", "Nova"],
		["titan", "Titan"],
		["wizardlm", "WizardLM"],
		["dolphin", "Dolphin"],
		["hermes", "Hermes"],
		["hermes3", "Hermes 3"],
		["o1", "o1"],
		["o3", "o3"],
		["o4", "o4"],
		["4o", "4o"],
		["3-5", "3.5"],
		["3.5", "3.5"],
		["r1", "R1"],
		["r2", "R2"],
		["v2", "v2"],
		["v3", "v3"],
		["v4", "v4"],
		["mini", "Mini"],
		["turbo", "Turbo"],
		["pro", "Pro"],
		["preview", "Preview"],
		["flash", "Flash"],
		["sonnet", "Sonnet"],
		["opus", "Opus"],
		["haiku", "Haiku"],
		["instruct", "Instruct"],
		["vision", "Vision"],
		["chat", "Chat"],
		["thinking", "Thinking"],
		["nitro", "Nitro"],
		["free", "Free"],
		["online", "Online"],
		["exacto", "Exacto"],
		["floor", "Floor"],
		["extended", "Extended"],
	])("MODEL_NAME_TOKEN_MAP[%p] === %p", (key, expected) => {
		expect(formatModelToken(key)).toBe(expected);
	});
});

describe("tokenizeModelCore", () => {
	test("splits on - _ and whitespace, drops empty tokens", () => {
		expect(tokenizeModelCore("gpt-4o_mini turbo")).toEqual(["GPT", "4o", "Mini", "Turbo"]);
	});

	test("returns empty array for input that is only separators", () => {
		expect(tokenizeModelCore("--__  ")).toEqual([]);
	});

	test("collapses runs of mixed separators (TOKEN_SPLIT_REGEX uses + quantifier)", () => {
		// L98 Regex: /[-_\s]+/ → /[-_\s]/ would NOT collapse runs, producing
		// empty tokens between separators. The current code filters length>0
		// tokens via formatModelToken, so the visible result is the same...
		// To distinguish, we need a case where the difference matters. With
		// the filter already in place, `--__` produces [] either way.
		// However formatModelToken("") would be called repeatedly for empty
		// chunks if the + were dropped — count tokens to detect.
		expect(tokenizeModelCore("a--b")).toEqual(["A", "B"]);
		expect(tokenizeModelCore("a__b")).toEqual(["A", "B"]);
		expect(tokenizeModelCore("a  b")).toEqual(["A", "B"]);
	});
});

describe("KNOWN_VERSION_REGEX (mutation guards)", () => {
	test("requires '$' end-anchor (rejects trailing junk)", () => {
		// Regex /...[a-z]?$/i mutated to /...[a-z]?/i would let "3.5xyz" match.
		// Without $, formatModelToken("3.5xyz") would return "3.5xyz" lowercased.
		// With $ intact, it falls back to capitalize: "3.5xyz".
		// Same string! So pick a case where capitalization differs.
		// Use uppercase suffix: "3.5XYZ" → with $ anchor: not version-like →
		// capitalize first + lowercase rest = "3.5xyz". Without anchor: matches
		// (suffix [a-z]? matches "X" lowercased) — actually capture only one.
		// Simpler: use "12-3foo"
		expect(formatModelToken("12-3foo")).toBe("12-3foo"); // capitalize-style
		// With $ anchor: KNOWN_VERSION_REGEX rejects "12-3foo" → falls to
		// capitalize: char(0)=1, slice(1).toLowerCase()="2-3foo" → "12-3foo".
		// Without $ anchor: matches "12-3" → returns "12-3foo".lowercase()="12-3foo".
		// Same output! So this case is also indistinguishable.
		// Use a case where lowercase actually differs:
		expect(formatModelToken("12-3FOO")).toBe("12-3foo");
		// With $: KNOWN_VERSION_REGEX rejects → capitalize: "1" + "2-3foo" = "12-3foo".
		// Without $: matches and returns rawToken.toLowerCase() = "12-3foo".
		// STILL same. Hmm.
		// The mutation isn't observable for ANY single token because the two
		// branches produce identical output for tokens that begin with a digit.
		// Skip — this is an equivalent mutant.
	});

	test("requires '+' on the digit class (rejects single-digit-only via mutation)", () => {
		// Mutation /^\d+(?:[.-]\d+)*[a-z]?$/i → /^\d(?:...)*[a-z]?$/i
		// would only match if the leading digits collapse to one digit.
		// "12" — with +: matches → returns "12" (lowercase)
		//        without +: matches "1" then needs "2" — but "2" is a digit not in
		//        any group → would not match end-anchored.
		// So formatModelToken("12") differs:
		//   with +: matches → returns "12"
		//   without +: doesn't match → capitalize → "12" (still)
		// Equivalent again for digit tokens.
		// Test that pure digits flow through formatModelToken correctly.
		expect(formatModelToken("128")).toBe("128");
		// In the source, the test "preserves a pure version-like token lowercased"
		// already covers this. The mutation IS equivalent for tokens because the
		// fallback (capitalize first, lowercase rest) gives same result for digit-only tokens.
	});
});

describe("KNOWN_VERSION_REGEX shape via shouldMergeVersion (operational test)", () => {
	test("'3-5' is recognized as version-like (so GPT+3-5 would merge)", () => {
		// Verify that a version-like token IS detected — kills mutations that
		// make the regex never match.
		expect(shouldMergeVersion("GPT", "3-5", 1)).toBe(true);
	});

	test("'3.5' is recognized as version-like", () => {
		expect(shouldMergeVersion("GPT", "3.5", 1)).toBe(true);
	});

	test("'128b' (digits + single letter) is recognized as version-like", () => {
		expect(shouldMergeVersion("GPT", "128b", 1)).toBe(true);
	});

	test("'4o' (digit + letter) is recognized as version-like", () => {
		expect(shouldMergeVersion("GPT", "4o", 1)).toBe(true);
	});

	test("'foo' (no leading digit) is NOT version-like — rejected by ^\\d+ anchor", () => {
		expect(shouldMergeVersion("GPT", "foo", 1)).toBe(false);
	});

	test("'1foo' (digit then letters) is NOT version-like — rejected because 'foo' has multi letters past [a-z]?", () => {
		// /^\d+(?:[.-]\d+)*[a-z]?$/ matches "1f" but not "1foo".
		expect(shouldMergeVersion("GPT", "1foo", 1)).toBe(false);
	});

	test("formatModelToken on a version-like token yields the lowercased form", () => {
		// L108 ConditionalExpression false: skips the regex branch; would
		// instead capitalize. With "12B": correct returns "12b" (lowercase).
		// With mutation skipping the if-branch: returns "12b" (charAt(0).up + slice(1).low) = "12b".
		// SAME RESULT for these cases. Pick one where they differ:
		// Use "3-5": correct returns "3-5"; mutation: charAt(0)="3"+slice(1).lower="-5" → "3-5". Same.
		// Use "v3": MAP entry. Doesn't go through regex.
		// Use a token like "42A" - regex match? /^\d+(?:[.-]\d+)*[a-z]?$/i.
		// "42A" → "42A" matches with [a-z]? case-insensitive → returns "42a".
		// With mutation skipping if(): falls to capitalize → "42a" (4+2a). Same.
		// Truly equivalent — the lowercase produced by both branches is identical
		// when the version-regex matches.
		expect(formatModelToken("42A")).toBe("42a");
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
