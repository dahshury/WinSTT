import { describe, expect, test } from "bun:test";
import {
	buildInitialPromptPair,
	collectDictionaryTerms,
	composeInitialPrompt,
} from "./initial-prompt";

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

	test("with no context tail, output is byte-identical to the two-arg call (backwards compatible)", () => {
		expect(composeInitialPrompt("My name is Alex.", ["Ollama"], "")).toBe(
			composeInitialPrompt("My name is Alex.", ["Ollama"])
		);
	});

	test("context tail is prepended above prefix + glossary", () => {
		const out = composeInitialPrompt("Static prefix.", ["Kubernetes"], "Hi Bob, thanks for");
		expect(out).toBe("Hi Bob, thanks for\n\nStatic prefix.\n\nGlossary: Kubernetes.");
	});

	test("context tail alone (no prefix, no glossary) returns just the sanitised tail", () => {
		expect(composeInitialPrompt("", [], "Dear Dr. Aljarbou,")).toBe("Dear Dr. Aljarbou,");
	});

	test("collapses runs of whitespace in the context tail", () => {
		const out = composeInitialPrompt("", [], "Hi\n\nBob,\t  thanks\nfor\nthe\nheads up.");
		expect(out).toBe("Hi Bob, thanks for the heads up.");
	});

	test("clips an oversized context tail to the LAST 250 chars (closest to caret = most relevant)", () => {
		// A 400-char tail of distinct letters lets us assert the tail-clip
		// direction precisely without depending on word-boundary heuristics.
		const longTail = "a".repeat(150) + "b".repeat(250);
		const out = composeInitialPrompt("", [], longTail);
		expect(out).toBe("b".repeat(250));
	});

	test("context tail does NOT crowd out a glossary (last-resort cap clips the tail's front)", () => {
		const huge = "z".repeat(2000);
		const out = composeInitialPrompt("", ["Ollama", "Kubernetes"], huge);
		expect(out.length).toBeLessThanOrEqual(600);
		expect(out.endsWith("Glossary: Ollama, Kubernetes.")).toBe(true);
	});

	test("empty context tail leaves the prefix-only path untouched", () => {
		expect(composeInitialPrompt("just prefix", [], "")).toBe("just prefix");
	});

	test("strips terminal/TUI box-drawing + dingbat chrome from the context tail", () => {
		// A captured terminal full of separator rules + symbols is what tipped
		// whisper-tiny into "ñoñoño" charset-drift hallucination. The decorative
		// glyphs must never reach Whisper's prompt.
		const terminalJunk = "─────────── ✻ still thinking ● ▶ ⠋ done ───────────";
		expect(composeInitialPrompt("", [], terminalJunk)).toBe("still thinking done");
	});

	test("a context tail that is ALL decorative noise collapses to empty (prefix-only path)", () => {
		const allChrome = `${"─".repeat(40)}█▀▄●◆★✻✶⠋⠙⠹`;
		expect(composeInitialPrompt("just prefix", [], allChrome)).toBe("just prefix");
	});

	test("noise between two words is replaced with a space, never fusing them", () => {
		// "wordA●wordB" must become "wordA wordB", not "wordAwordB".
		expect(composeInitialPrompt("", [], "wordA●wordB")).toBe("wordA wordB");
	});

	test("keeps real non-Latin scripts (ar/zh/hi dictation must retain its prior-text bias)", () => {
		// Filter is by Unicode category, NOT "non-ASCII" — letters survive.
		const arabic = "مرحبا بالعالم";
		const chinese = "你好世界";
		expect(composeInitialPrompt("", [], arabic)).toBe(arabic);
		expect(composeInitialPrompt("", [], chinese)).toBe(chinese);
	});

	test("keeps ASCII code symbols (code-editor context is the feature's primary use case)", () => {
		const code = "const x = (a + b) > 0 ? a & b : a | b; // ok";
		expect(composeInitialPrompt("", [], code)).toBe(code);
	});

	test("keeps letter-adjacent punctuation (em-dash, ellipsis, apostrophe)", () => {
		const prose = "It's done — finally… really.";
		expect(composeInitialPrompt("", [], prose)).toBe(prose);
	});

	test("strips U+FFFC object-replacement chars (dominant web-app noise)", () => {
		// Every image/icon/avatar in a browser a11y tree comes back as ￼.
		// A YouTube search capture that was mostly ￼ made whisper-tiny emit
		// a literal "￼" — these must be stripped (they're category So).
		const ytSearch = "￼\n￼\n￼\nEG\nSkip navigation\n￼\nstephanie jeff nippard";
		expect(composeInitialPrompt("", [], ytSearch)).toBe(
			"EG Skip navigation stephanie jeff nippard"
		);
	});

	test("strips bullet punctuation (•, ‣, ⁃) — leaked '•' into output", () => {
		// Bullets are category Po (not So), so they need explicit removal.
		expect(composeInitialPrompt("", [], "• first ‣ second ⁃ third")).toBe("first second third");
	});

	test("strips emoji including skin-tone modifiers but keeps surrounding words", () => {
		expect(composeInitialPrompt("", [], "great work 👍🏽 thanks 🎉")).toBe("great work thanks");
	});

	test("a tail-only prompt of exactly the per-tail cap (250) passes through the no-cap fast-path", () => {
		// No prefix, no dictionary => body is empty. The tail is hard-capped to
		// MAX_CONTEXT_TAIL_CHARS (250) by sanitiseContextTail, which is < the
		// MAX_PROMPT_CHARS (600) final cap, so the no-cap fast-path returns it
		// verbatim. This is precisely why the former `body.length === 0`
		// last-resort branch was dead code (now removed): an empty body can
		// never reach the cap-overflow path.
		const tail = "c".repeat(250);
		expect(composeInitialPrompt("", [], tail)).toBe(tail);
	});

	test("a tail-only prompt longer than the per-tail cap keeps only its LAST 250 chars", () => {
		// A 700-char single token has no whitespace to collapse and no noise to
		// strip, so sanitiseContextTail keeps only its LAST 250 chars (< 600).
		const out = composeInitialPrompt("", [], "d".repeat(700));
		expect(out).toBe("d".repeat(250));
		expect(out.length).toBe(250);
	});

	test("roomForTail <= 0: a body that fills the entire budget drops the tail entirely", () => {
		// Build a glossary body that occupies >= MAX_PROMPT_CHARS - 2 chars so
		// there is no room left for the tail after the "\n\n" separator. The
		// composer must return the body alone (glossary intact, tail dropped).
		const terms = Array.from({ length: 300 }, (_, i) => `term${i}`);
		const tail = "context that should be dropped";
		const out = composeInitialPrompt("", terms, tail);
		expect(out.length).toBeLessThanOrEqual(600);
		expect(out.startsWith("Glossary: ")).toBe(true);
		expect(out).not.toContain("context that should be dropped");
		// And it must match the body-only composition (no tail leaked in).
		expect(out).toBe(composeInitialPrompt("", terms, ""));
	});

	test("composed>600 with room for some tail: clips tail front, keeps body intact", () => {
		// To force composed>600 with a non-empty body AND positive roomForTail,
		// use a glossary of 424 chars (85 short terms) and a 250-char tail so
		// composed = 250 + 2 + 424 = 676 > 600, and roomForTail = 600 - 424 - 2
		// = 174 > 0. The body (glossary) is kept intact; the tail's FRONT is
		// clipped to its trailing 174 chars.
		const terms = Array.from({ length: 85 }, (_, i) => `t${i}`);
		const glossary = `Glossary: ${terms.join(", ")}.`;
		const tail = "k".repeat(250);
		const out = composeInitialPrompt("", terms, tail);
		expect(out.length).toBe(600);
		// Body (the glossary) survives intact at the end.
		expect(out.endsWith(glossary)).toBe(true);
		// The tail was clipped from its front (only a suffix of k's remains).
		const roomForTail = 600 - glossary.length - 2;
		expect(out.startsWith("k".repeat(roomForTail))).toBe(true);
		expect(out).toBe(`${"k".repeat(roomForTail)}\n\n${glossary}`);
	});
});

describe("fitComposedWithinCap (via composeInitialPrompt prefix+glossary overflow)", () => {
	test("prefix + glossary that overflows but glossary <= cap: clips the prefix's TAIL, keeps glossary", () => {
		// A 600-char prefix plus a short glossary (29 chars) overflows 600
		// (composed = 600 + 2 + 29 = 631), but the glossary alone is well under
		// the cap, so the composer clips the prefix's TAIL to fit rather than
		// clipping the glossary. This exercises the FALSE branch of
		// `glossary.length > MAX_PROMPT_CHARS` (clipPrefixToFitGlossary).
		const prefix = "p".repeat(600);
		const out = composeInitialPrompt(prefix, ["Ollama", "Kubernetes"]);
		expect(out.length).toBeLessThanOrEqual(600);
		expect(out.endsWith("Glossary: Ollama, Kubernetes.")).toBe(true);
		// Glossary kept intact (not clipped on a comma boundary).
		expect(out).toContain("Glossary: Ollama, Kubernetes.");
		// Prefix was clipped to make room; only a prefix-prefix of p's remains.
		const glossary = "Glossary: Ollama, Kubernetes.";
		const room = 600 - glossary.length - 2;
		expect(out).toBe(`${"p".repeat(room)}\n\n${glossary}`);
	});
});

describe("clipOversizedGlossary no-comma branch", () => {
	test("a single term longer than the cap is hard-cut to 600 chars WITH a terminating period", () => {
		// When one term alone overflows the cap there is no comma in the first
		// 600 chars, so lastIndexOf(',') === -1. Regression: this branch used to
		// return the raw slice with no terminating period, producing a malformed
		// (unterminated) glossary sentence. It must now hard-cut at the cap and
		// append a period so the prompt stays well-formed and within budget.
		const oneHugeTerm = "x".repeat(700);
		const out = composeInitialPrompt("", [oneHugeTerm]);
		expect(out.length).toBe(600);
		expect(out.startsWith("Glossary: ")).toBe(true);
		expect(out.includes(",")).toBe(false);
		// The no-comma branch now terminates the sentence with a period.
		expect(out.endsWith(".")).toBe(true);
	});
});

describe("buildInitialPromptPair", () => {
	test("builds main + realtime prompts sharing the same dictionary glossary", () => {
		const pair = buildInitialPromptPair({
			mainPrefix: "Main prefix.",
			realtimePrefix: "Realtime prefix.",
			dictionary: [{ term: "Ollama" }, { term: "Kubernetes" }],
		});
		expect(pair.main).toBe("Main prefix.\n\nGlossary: Ollama, Kubernetes.");
		expect(pair.realtime).toBe("Realtime prefix.\n\nGlossary: Ollama, Kubernetes.");
	});

	test("defaults contextTail to '' when omitted (byte-identical to two-tier shape)", () => {
		const pair = buildInitialPromptPair({
			mainPrefix: "Main.",
			realtimePrefix: "RT.",
			dictionary: [{ term: "Ollama" }],
		});
		expect(pair.main).toBe(composeInitialPrompt("Main.", ["Ollama"], ""));
		expect(pair.realtime).toBe(composeInitialPrompt("RT.", ["Ollama"], ""));
	});

	test("threads an explicit contextTail into BOTH prompts", () => {
		const pair = buildInitialPromptPair({
			mainPrefix: "Main.",
			realtimePrefix: "RT.",
			dictionary: [{ term: "Ollama" }],
			contextTail: "Hi Bob,",
		});
		expect(pair.main).toBe("Hi Bob,\n\nMain.\n\nGlossary: Ollama.");
		expect(pair.realtime).toBe("Hi Bob,\n\nRT.\n\nGlossary: Ollama.");
	});

	test("handles an undefined dictionary (no glossary, prefixes verbatim)", () => {
		const pair = buildInitialPromptPair({
			mainPrefix: "Just main.",
			realtimePrefix: "Just rt.",
			dictionary: undefined,
		});
		expect(pair.main).toBe("Just main.");
		expect(pair.realtime).toBe("Just rt.");
	});

	test("handles an empty dictionary array (no glossary)", () => {
		const pair = buildInitialPromptPair({
			mainPrefix: "Main.",
			realtimePrefix: "RT.",
			dictionary: [],
		});
		expect(pair.main).toBe("Main.");
		expect(pair.realtime).toBe("RT.");
	});

	test("all-empty inputs yield two empty prompts", () => {
		const pair = buildInitialPromptPair({
			mainPrefix: "",
			realtimePrefix: "",
			dictionary: [],
		});
		expect(pair.main).toBe("");
		expect(pair.realtime).toBe("");
	});
});
