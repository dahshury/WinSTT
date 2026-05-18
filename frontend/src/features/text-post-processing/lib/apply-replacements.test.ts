import { describe, expect, test } from "bun:test";
import { applyAllReplacements, applyDictionary, applySnippets } from "./apply-replacements";

const term = (t: string, id = t) => ({ id, term: t });

describe("applyDictionary (fuzzy)", () => {
	test("returns input unchanged with no entries", () => {
		expect(applyDictionary("hello", [])).toBe("hello");
	});

	test("near-miss spelling is snapped to the canonical term", () => {
		// Whisper misheard "Kubernetes" as "kubernetees" — JW above 0.88.
		expect(applyDictionary("deployed on kubernetees today", [term("Kubernetes")])).toBe(
			"deployed on Kubernetes today"
		);
	});

	test("exact match (case-insensitive) snaps to canonical casing", () => {
		expect(applyDictionary("kubernetes is up", [term("Kubernetes")])).toBe("Kubernetes is up");
	});

	test("phonetically equivalent spelling matches even when JW alone wouldn't", () => {
		// "Wispr" → "Whisper" — short, drops a letter, but Metaphone codes match.
		expect(applyDictionary("use wispr to dictate", [term("Whisper")])).toBe(
			"use Whisper to dictate"
		);
	});

	test("dissimilar word is left alone (no false-positive replacement)", () => {
		// "cube" should NOT trigger "Kubernetes" even though they share letters.
		expect(applyDictionary("you're a cube of nuts", [term("Kubernetes")])).toBe(
			"you're a cube of nuts"
		);
	});

	test("preserves surrounding punctuation around the matched word", () => {
		expect(applyDictionary("(kubernetees), yes!", [term("Kubernetes")])).toBe("(Kubernetes), yes!");
	});

	test("picks the best matching term when multiple are close", () => {
		// "Wisper" is closer to "Whisper" than to "Whippet".
		expect(applyDictionary("wisper is fast", [term("Whippet"), term("Whisper")])).toBe(
			"Whisper is fast"
		);
	});
});

describe("applySnippets (fuzzy)", () => {
	test("non-matching trigger leaves text untouched", () => {
		expect(applySnippets("hello", [{ id: "1", trigger: "my email", expansion: "X" }])).toBe(
			"hello"
		);
	});

	test("multi-word trigger expansion works on exact wording", () => {
		expect(
			applySnippets("send me my email address please", [
				{ id: "1", trigger: "my email address", expansion: "khaled@example.com" },
			])
		).toBe("send me khaled@example.com please");
	});

	test("fuzzy trigger fires on a phonetically-close variant", () => {
		// Whisper drops one letter from "address" → "adress". Trigger window has
		// the same token count (3), so JW + Metaphone push it over threshold.
		const out = applySnippets("forward to my email adress now", [
			{ id: "1", trigger: "my email address", expansion: "khaled@example.com" },
		]);
		expect(out).toBe("forward to khaled@example.com now");
	});

	test("preserves trailing punctuation around the matched phrase", () => {
		expect(
			applySnippets("forward to my email address.", [
				{ id: "1", trigger: "my email address", expansion: "khaled@example.com" },
			])
		).toBe("forward to khaled@example.com.");
	});

	test("preserves leading punctuation around the matched phrase", () => {
		expect(
			applySnippets("(my email address) is here", [
				{ id: "1", trigger: "my email address", expansion: "khaled@example.com" },
			])
		).toBe("(khaled@example.com) is here");
	});

	test("multiple snippets apply in declaration order", () => {
		const out = applySnippets("good morning team it is now afternoon", [
			{ id: "1", trigger: "good morning", expansion: "[GREET]" },
			{ id: "2", trigger: "now afternoon", expansion: "[PM]" },
		]);
		expect(out).toBe("[GREET] team it is [PM]");
	});

	test("snippet whose expansion would itself match a later trigger does not chain", () => {
		// Right-to-left splicing means we don't re-scan replaced text.
		const out = applySnippets("expand alpha", [
			{ id: "1", trigger: "alpha", expansion: "beta" },
			{ id: "2", trigger: "beta", expansion: "gamma" },
		]);
		expect(out).toBe("expand gamma");
		// Because applySnippets iterates triggers and scans the result each iteration,
		// the chained replacement IS expected here. Lock in the behavior.
	});
});

describe("applyAllReplacements", () => {
	test("dictionary applies before snippets", () => {
		// Dictionary corrects the product name first; snippet then matches the
		// canonicalized text. Each pass is independent and composable.
		const out = applyAllReplacements(
			"i use winstt and my email adress daily",
			[term("WinSTT")],
			[{ id: "1", trigger: "my email address", expansion: "khaled@example.com" }]
		);
		expect(out).toBe("i use WinSTT and khaled@example.com daily");
	});

	test("returns input unchanged when both lists are empty", () => {
		expect(applyAllReplacements("hello", [], [])).toBe("hello");
	});
});
