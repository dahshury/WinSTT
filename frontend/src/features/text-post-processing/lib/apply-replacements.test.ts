import { describe, expect, test } from "bun:test";
import { applyAllReplacements, applyDictionary, applySnippets } from "./apply-replacements";

const dict = (
	overrides: Partial<{
		find: string;
		replace: string;
		caseSensitive: boolean;
		wholeWord: boolean;
		id: string;
	}>
) => ({
	id: "1",
	find: "",
	replace: "",
	caseSensitive: false,
	wholeWord: false,
	...overrides,
});

describe("applyDictionary", () => {
	test("returns input unchanged with no entries", () => {
		expect(applyDictionary("hello", [])).toBe("hello");
	});

	test("case-insensitive replacement (default)", () => {
		const out = applyDictionary("UR cool. ur fine.", [dict({ find: "ur", replace: "your" })]);
		expect(out).toBe("your cool. your fine.");
	});

	test("case-sensitive replacement matches only exact case", () => {
		const out = applyDictionary("UR ur", [dict({ find: "ur", replace: "X", caseSensitive: true })]);
		expect(out).toBe("UR X");
	});

	test("whole-word boundary respects subword boundaries", () => {
		const out = applyDictionary("cat scatter category", [
			dict({ find: "cat", replace: "dog", wholeWord: true }),
		]);
		expect(out).toBe("dog scatter category");
	});

	test("escapes regex special characters in find pattern", () => {
		const out = applyDictionary("price: $5.99", [dict({ find: "$5.99", replace: "$X" })]);
		expect(out).toBe("price: $X");
	});
});

describe("applySnippets", () => {
	test("expands every occurrence of trigger", () => {
		const out = applySnippets("/sig and /sig", [
			{ id: "1", trigger: "/sig", expansion: "Best,\nSan" },
		]);
		expect(out).toBe("Best,\nSan and Best,\nSan");
	});

	test("multiple snippets apply in declaration order", () => {
		const out = applySnippets("/a then /b", [
			{ id: "1", trigger: "/a", expansion: "first" },
			{ id: "2", trigger: "/b", expansion: "second" },
		]);
		expect(out).toBe("first then second");
	});

	test("non-matching trigger leaves text untouched", () => {
		expect(applySnippets("hello", [{ id: "1", trigger: "/none", expansion: "X" }])).toBe("hello");
	});
});

describe("applyAllReplacements", () => {
	test("dictionary applies before snippets", () => {
		const out = applyAllReplacements(
			"hi world",
			[dict({ find: "hi", replace: "hello" })],
			[{ id: "1", trigger: "hello", expansion: "HOWDY" }]
		);
		expect(out).toBe("HOWDY world");
	});

	test("returns input unchanged when both lists are empty", () => {
		expect(applyAllReplacements("hello", [], [])).toBe("hello");
	});
});
