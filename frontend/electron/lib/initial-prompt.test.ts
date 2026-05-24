import { describe, expect, test } from "bun:test";
import { collectDictionaryTerms, composeInitialPrompt } from "./initial-prompt";

describe("collectDictionaryTerms", () => {
	test("returns empty array on empty/undefined input", () => {
		expect(collectDictionaryTerms(undefined)).toEqual([]);
		expect(collectDictionaryTerms([])).toEqual([]);
	});

	test("skips entries with empty/whitespace terms", () => {
		expect(collectDictionaryTerms([{ term: "" }, { term: "   " }, { term: "Ollama" }, {}])).toEqual(
			["Ollama"]
		);
	});

	test("de-duplicates case-insensitively, preserves first casing", () => {
		expect(
			collectDictionaryTerms([
				{ term: "Kubernetes" },
				{ term: "kubernetes" },
				{ term: "KUBERNETES" },
				{ term: "ollama" },
			])
		).toEqual(["Kubernetes", "ollama"]);
	});

	test("includes replacement-pair LHS terms (they're mis-transcription targets too)", () => {
		expect(
			collectDictionaryTerms([
				{ term: "github", replacement: "GitHub" },
				{ term: "baseui", replacement: "Base UI" },
			])
		).toEqual(["github", "baseui"]);
	});

	test("caps at MAX_VOCAB_TERMS (100)", () => {
		const big = Array.from({ length: 200 }, (_, i) => ({ term: `term${i}` }));
		const out = collectDictionaryTerms(big);
		expect(out).toHaveLength(100);
		expect(out[0]).toBe("term0");
		expect(out[99]).toBe("term99");
	});
});

describe("composeInitialPrompt", () => {
	test("empty in, empty out", () => {
		expect(composeInitialPrompt("", [])).toBe("");
	});

	test("returns user prefix verbatim when dictionary is empty", () => {
		expect(composeInitialPrompt("My name is Alex.", [])).toBe("My name is Alex.");
	});

	test("returns glossary only when prefix is empty", () => {
		expect(composeInitialPrompt("", ["Ollama", "Kubernetes"])).toBe(
			"Glossary: Ollama, Kubernetes."
		);
	});

	test("composes prefix + glossary with blank line between", () => {
		expect(composeInitialPrompt("My name is Alex.", ["Ollama"])).toBe(
			"My name is Alex.\n\nGlossary: Ollama."
		);
	});

	test("trims whitespace from prefix", () => {
		expect(composeInitialPrompt("   spaced  \n\n", [])).toBe("spaced");
	});

	test("clips a runaway prefix without losing the glossary", () => {
		// 700-char prefix exceeds MAX_PROMPT_CHARS (600).
		const longPrefix = "x".repeat(700);
		const composed = composeInitialPrompt(longPrefix, ["Ollama"]);
		expect(composed.length).toBeLessThanOrEqual(600);
		expect(composed.endsWith("Glossary: Ollama.")).toBe(true);
	});

	test("clips a runaway glossary on a comma boundary", () => {
		const terms = Array.from({ length: 200 }, (_, i) => `term${i}`);
		const composed = composeInitialPrompt("", terms);
		expect(composed.length).toBeLessThanOrEqual(600);
		expect(composed.startsWith("Glossary: ")).toBe(true);
		expect(composed.endsWith(".")).toBe(true);
	});

	test("clips a runaway prefix-only when no dictionary", () => {
		const longPrefix = "y".repeat(800);
		expect(composeInitialPrompt(longPrefix, [])).toHaveLength(600);
	});
});
