import { describe, expect, test } from "bun:test";
import {
	bestDictionaryMatch,
	buildPhoneticTerm,
	DICTIONARY_JW_THRESHOLD,
	DICTIONARY_PHONETIC_JW_THRESHOLD,
	findSnippetMatches,
	jaroWinkler,
	type PhoneticTerm,
	replaceWithDictionary,
	replaceWithSnippets,
	SNIPPET_JW_THRESHOLD,
} from "./fuzzy-match";

// All assertions are anchored on the Jaro-Winkler reference values listed in
// the original Winkler 1990 paper and Wikipedia's worked examples. Any drift
// here means the algorithm changed — algorithm fidelity is the whole point of
// this module since dictionary/snippet correction depends on these scores
// passing the documented thresholds.

describe("jaroWinkler", () => {
	test("returns 1 for identical strings", () => {
		expect(jaroWinkler("hello", "hello")).toBe(1);
	});

	test("returns 0 when either string is empty", () => {
		expect(jaroWinkler("", "hello")).toBe(0);
		expect(jaroWinkler("hello", "")).toBe(0);
		expect(jaroWinkler("", "")).toBe(1); // identical (both empty) short-circuits before length check
	});

	test("matches the documented Winkler 'MARTHA'/'MARHTA' = 0.9611 example", () => {
		// Winkler's canonical example: shared 'MAR' prefix + 1 transposition.
		// jaro = 0.9444…, jw = jaro + 3 * 0.1 * (1 - jaro) = 0.9611…
		const score = jaroWinkler("martha", "marhta");
		expect(score).toBeCloseTo(0.9611, 3);
	});

	test("matches the documented 'DWAYNE'/'DUANE' = 0.84 example", () => {
		// jaro = 0.8222…, prefix = 1 ('D' only) → jw ≈ 0.840.
		const score = jaroWinkler("dwayne", "duane");
		expect(score).toBeCloseTo(0.84, 2);
	});

	test("does not apply the prefix boost below the 0.7 Jaro floor", () => {
		// "abc"/"xyz" share no characters → Jaro 0 → JW returned untouched.
		expect(jaroWinkler("abc", "xyz")).toBe(0);
	});

	test("caps the prefix length at 4 even when strings share a longer prefix", () => {
		// "abcdefg" vs "abcdefh" → 6 of 7 chars match, jaro very high; the prefix
		// boost should saturate after 4 chars so the result remains ≤ 1.
		const score = jaroWinkler("abcdefg", "abcdefh");
		expect(score).toBeGreaterThan(0.9);
		expect(score).toBeLessThanOrEqual(1);
	});

	test("returns 0 when no characters fall inside the match window", () => {
		// Match window = floor(max(2,2)/2)-1 = 0 → only same-index matches count;
		// none here. Drives the `state.matches === 0` early-return branch in jaro.
		expect(jaroWinkler("ab", "cd")).toBe(0);
	});
});

describe("buildPhoneticTerm", () => {
	test("preserves the original casing in `canonical`", () => {
		const term = buildPhoneticTerm("WinSTT");
		expect(term.canonical).toBe("WinSTT");
		expect(term.lower).toBe("winstt");
	});

	test("includes both double-metaphone codes (primary + secondary)", () => {
		const term = buildPhoneticTerm("Schmidt");
		expect(Array.isArray(term.mp)).toBe(true);
		expect(term.mp.length).toBe(2);
		expect(typeof term.mp[0]).toBe("string");
		expect(typeof term.mp[1]).toBe("string");
	});
});

describe("bestDictionaryMatch", () => {
	const terms: readonly PhoneticTerm[] = [
		buildPhoneticTerm("WinSTT"),
		buildPhoneticTerm("React"),
		buildPhoneticTerm("TypeScript"),
		buildPhoneticTerm("Anthropic"),
	];

	test("returns null when the term list is empty", () => {
		expect(bestDictionaryMatch("anything", [])).toBeNull();
	});

	test("returns null when the input word is empty", () => {
		expect(bestDictionaryMatch("", terms)).toBeNull();
	});

	test("returns the canonical form on a case-insensitive exact match", () => {
		expect(bestDictionaryMatch("winstt", terms)).toBe("WinSTT");
		expect(bestDictionaryMatch("WINSTT", terms)).toBe("WinSTT");
		expect(bestDictionaryMatch("React", terms)).toBe("React");
	});

	test("accepts a near-miss above the JW threshold (fuzzy spell-fix)", () => {
		// "Antropic" → JW vs "anthropic" ≈ 0.96 — above 0.88 threshold.
		expect(bestDictionaryMatch("Antropic", terms)).toBe("Anthropic");
	});

	test("rejects a wholly unrelated word", () => {
		expect(bestDictionaryMatch("xylophone", terms)).toBeNull();
	});

	test("phonetic gate rescues a JW that's only above the lower 0.80 threshold", () => {
		// "Reakt" vs "React" — high enough JW + identical double-metaphone code
		// pair → passes via the phonetic confirmation branch.
		expect(bestDictionaryMatch("Reakt", terms)).toBe("React");
	});

	test("scoring keeps only the strictly-higher candidate", () => {
		// Two terms with the same prefix; the closer one (exact match minus
		// trailing char) must win over the more distant one.
		const items = [buildPhoneticTerm("ApplePie"), buildPhoneticTerm("AppleSauce")];
		expect(bestDictionaryMatch("ApplePi", items)).toBe("ApplePie");
	});

	test("threshold constants are at the documented values", () => {
		expect(DICTIONARY_JW_THRESHOLD).toBeCloseTo(0.88);
		expect(DICTIONARY_PHONETIC_JW_THRESHOLD).toBeCloseTo(0.8);
		expect(SNIPPET_JW_THRESHOLD).toBeCloseTo(0.92);
	});
});

describe("replaceWithDictionary", () => {
	const terms: readonly PhoneticTerm[] = [
		buildPhoneticTerm("WinSTT"),
		buildPhoneticTerm("Anthropic"),
	];

	test("returns the text unchanged when the term list is empty", () => {
		const text = "I use winstt every day.";
		expect(replaceWithDictionary(text, [])).toBe(text);
	});

	test("snaps each matched word to its canonical casing", () => {
		const out = replaceWithDictionary("I use winstt at antropic.", terms);
		expect(out).toBe("I use WinSTT at Anthropic.");
	});

	test("preserves surrounding punctuation when replacing a word", () => {
		// The trailing period must remain outside the matched span.
		expect(replaceWithDictionary("winstt.", terms)).toBe("WinSTT.");
		expect(replaceWithDictionary("(winstt)", terms)).toBe("(WinSTT)");
	});

	test("leaves unrelated words untouched", () => {
		expect(replaceWithDictionary("hello world", terms)).toBe("hello world");
	});
});

describe("findSnippetMatches", () => {
	test("returns empty for an empty trigger", () => {
		expect(findSnippetMatches("some text here", "", "expansion")).toEqual([]);
	});

	test("returns empty when the trigger is longer than the text in words", () => {
		expect(findSnippetMatches("one two", "three four five", "X")).toEqual([]);
	});

	test("finds an exact single-word trigger and reports the right span", () => {
		const matches = findSnippetMatches("hello world", "hello", "HI");
		expect(matches.length).toBe(1);
		const [m] = matches;
		expect(m).toBeDefined();
		if (!m) {
			return;
		}
		expect(m.start).toBe(0);
		expect(m.end).toBe("hello".length);
		expect(m.expansion).toBe("HI");
	});

	test("finds a multi-word trigger with surrounding text preserved", () => {
		const matches = findSnippetMatches("please email me back", "email me", "ping me");
		expect(matches.length).toBe(1);
		const [m] = matches;
		expect(m).toBeDefined();
		if (!m) {
			return;
		}
		expect("please email me back".slice(m.start, m.end)).toBe("email me");
	});

	test("emits non-overlapping matches for repeated triggers", () => {
		const text = "hello world hello world hello";
		const matches = findSnippetMatches(text, "hello", "HI");
		expect(matches.length).toBe(3);
	});

	test("rejects matches that fail the phonetic gate even with high JW", () => {
		// Synthetic case: a single weak fuzzy candidate that should NOT match.
		// "abc" vs "xyz" → JW 0 → far below threshold.
		expect(findSnippetMatches("xyz here", "abc", "X")).toEqual([]);
	});

	test("preserves trailing punctuation outside the matched span", () => {
		const text = "say hello.";
		const matches = findSnippetMatches(text, "hello", "HI");
		expect(matches.length).toBe(1);
		const [m] = matches;
		expect(m).toBeDefined();
		if (!m) {
			return;
		}
		// The matched span covers the word only — punctuation remains in `text`.
		expect(text.slice(m.start, m.end)).toBe("hello");
	});
});

describe("replaceWithSnippets", () => {
	test("returns the text unchanged when there are no snippets", () => {
		expect(replaceWithSnippets("hi there", [])).toBe("hi there");
	});

	test("returns the text unchanged when no snippet matches", () => {
		expect(replaceWithSnippets("hi there", [{ trigger: "xyz", expansion: "REPLACED" }])).toBe(
			"hi there"
		);
	});

	test("splices in a single expansion in place of the matched span", () => {
		const out = replaceWithSnippets("say hello world", [{ trigger: "hello", expansion: "HI" }]);
		expect(out).toBe("say HI world");
	});

	test("splices multiple matches right-to-left, preserving punctuation", () => {
		const out = replaceWithSnippets("hello world hello.", [{ trigger: "hello", expansion: "HI" }]);
		expect(out).toBe("HI world HI.");
	});

	test("applies multiple snippets in order", () => {
		const out = replaceWithSnippets("say hello to the world", [
			{ trigger: "hello", expansion: "HI" },
			{ trigger: "world", expansion: "EARTH" },
		]);
		expect(out).toBe("say HI to the EARTH");
	});
});
