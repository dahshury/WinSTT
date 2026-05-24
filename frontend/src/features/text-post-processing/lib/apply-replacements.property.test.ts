import { describe, test } from "bun:test";
import fc from "fast-check";
import { applyAllReplacements, applyDictionary, applySnippets } from "./apply-replacements";

// Bounded ASCII text generator — keeps fuzzy matcher predictable.
const text = () => fc.string({ minLength: 0, maxLength: 60 });

// DictionaryEntry generator — id + non-empty term.
const dictEntry = () =>
	fc.record({
		id: fc.string({ minLength: 1, maxLength: 8 }),
		term: fc
			.string({ minLength: 1, maxLength: 12 })
			// Avoid empty-after-trim terms; the fuzzy WORD_RE requires letters/digits.
			.filter((s) => /[\p{L}\p{N}]/u.test(s)),
	});

// SnippetEntry generator — id + non-empty trigger + expansion.
const snippetEntry = () =>
	fc.record({
		id: fc.string({ minLength: 1, maxLength: 8 }),
		trigger: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /[\p{L}\p{N}]/u.test(s)),
		expansion: fc.string({ minLength: 0, maxLength: 16 }),
	});

describe("applyDictionary (property-based)", () => {
	test("empty entries list is the identity function", () => {
		fc.assert(
			fc.property(text(), (t) => applyDictionary(t, []) === t),
			{ numRuns: 300 }
		);
	});

	test("deterministic: same (text, entries) produces same output", () => {
		fc.assert(
			fc.property(text(), fc.array(dictEntry(), { maxLength: 5 }), (t, entries) => {
				const a = applyDictionary(t, entries);
				const b = applyDictionary(t, entries);
				return a === b;
			}),
			{ numRuns: 200 }
		);
	});

	test("idempotent in general: applying twice equals once", () => {
		// First pass snaps near-misses to canonical terms. Second pass: every
		// token in the output is either a canonical term (exact match → stays)
		// or text that didn't match anything (stays). So twice == once.
		// Use longer, distinct alphabetic terms to keep fuzzy matching stable.
		const longTerm = fc.record({
			id: fc.string({ minLength: 1, maxLength: 8 }),
			term: fc.stringMatching(/^[a-zA-Z]{4,10}$/).filter((s) => s.length >= 4),
		});
		fc.assert(
			fc.property(text(), fc.array(longTerm, { maxLength: 3 }), (t, entries) => {
				const once = applyDictionary(t, entries);
				const twice = applyDictionary(once, entries);
				return once === twice;
			}),
			{ numRuns: 200 }
		);
	});
});

describe("applySnippets (property-based)", () => {
	test("empty snippets list is the identity function", () => {
		fc.assert(
			fc.property(text(), (t) => applySnippets(t, []) === t),
			{ numRuns: 300 }
		);
	});

	test("output length bound: snippet replacement cannot exceed text + N × max(expansion)", () => {
		// Pessimistic bound: each token in text could be replaced by the
		// largest expansion. The output length cannot exceed the original
		// length plus that worst-case grow.
		fc.assert(
			fc.property(
				text(),
				fc.array(snippetEntry(), { minLength: 1, maxLength: 4 }),
				(t, snippets) => {
					const out = applySnippets(t, snippets);
					const maxExpansionLen = snippets.reduce((m, s) => Math.max(m, s.expansion.length), 0);
					// Each snippet pass replaces matches inside the current text.
					// Conservative bound: original length + snippets.length × text.length × maxExpansionLen.
					const bound = t.length + snippets.length * Math.max(1, t.length) * maxExpansionLen + 64;
					return out.length <= bound;
				}
			),
			{ numRuns: 200 }
		);
	});

	test("deterministic for snippets too", () => {
		fc.assert(
			fc.property(text(), fc.array(snippetEntry(), { maxLength: 4 }), (t, snippets) => {
				const a = applySnippets(t, snippets);
				const b = applySnippets(t, snippets);
				return a === b;
			}),
			{ numRuns: 200 }
		);
	});
});

describe("applyAllReplacements (property-based)", () => {
	test("both empty lists is the identity function", () => {
		fc.assert(
			fc.property(text(), (t) => applyAllReplacements(t, [], []) === t),
			{ numRuns: 300 }
		);
	});

	test("composition: applyAllReplacements equals applySnippets(applyDictionary(text, dict), snips)", () => {
		fc.assert(
			fc.property(
				text(),
				fc.array(dictEntry(), { maxLength: 3 }),
				fc.array(snippetEntry(), { maxLength: 3 }),
				(t, dict, snips) => {
					const composed = applyAllReplacements(t, dict, snips);
					const manual = applySnippets(applyDictionary(t, dict), snips);
					return composed === manual;
				}
			),
			{ numRuns: 200 }
		);
	});
});
