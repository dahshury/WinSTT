import { describe, expect, test } from "bun:test";
import { matchesSearchQuery } from "./settings-search";

describe("matchesSearchQuery", () => {
	const general = "General Recording mode language Display Startup wake word";

	test("empty / whitespace query matches everything", () => {
		expect(matchesSearchQuery(general, "")).toBe(true);
		expect(matchesSearchQuery(general, "   ")).toBe(true);
	});

	test("matches a keyword that is not in the label (the 'display' bug)", () => {
		// "Display" lives in the keywords (a section name), not the tab label.
		expect(matchesSearchQuery(general, "display")).toBe(true);
	});

	test("is case-insensitive", () => {
		expect(matchesSearchQuery(general, "DISPLAY")).toBe(true);
		expect(matchesSearchQuery(general, "DiSpLaY")).toBe(true);
	});

	test("matches a token prefix", () => {
		expect(matchesSearchQuery(general, "lang")).toBe(true);
		expect(matchesSearchQuery(general, "disp")).toBe(true);
	});

	test("fuzzy-matches a typo'd token (Jaro-Winkler, like the dictionary)", () => {
		expect(matchesSearchQuery(general, "dispaly")).toBe(true);
		expect(matchesSearchQuery(general, "languege")).toBe(true);
	});

	test("matches a multi-word substring phrase", () => {
		expect(matchesSearchQuery(general, "recording mode")).toBe(true);
		expect(matchesSearchQuery(general, "wake word")).toBe(true);
	});

	test("requires every query token to match (AND across tokens)", () => {
		// "display" is present but "xyzzy" is not → overall miss.
		expect(matchesSearchQuery(general, "display xyzzy")).toBe(false);
	});

	test("rejects an unrelated query", () => {
		expect(matchesSearchQuery(general, "zzzznomatch")).toBe(false);
	});

	test("does not fuzzy-match short (≤3 char) tokens to avoid noise", () => {
		// Jaro-Winkler scores "ai" ~0.83 vs "main" — high enough to clear a
		// lenient bar. Gating fuzzy to ≥4 chars keeps a short, non-substring
		// query from fuzzily matching an unrelated word. ("ai" is NOT a
		// substring of "model device", so the contains-search can't rescue it.)
		expect(matchesSearchQuery("model device options", "ai")).toBe(false);
		// But when the short token genuinely appears (substring), it still
		// matches — contains-search is intentionally permissive for short input
		// and narrows as the user types more.
		expect(matchesSearchQuery("Main Model", "ai")).toBe(true);
	});

	test("short acronyms still match exactly / by prefix", () => {
		expect(matchesSearchQuery("Voice Activity Detection vad", "vad")).toBe(true);
		expect(matchesSearchQuery("Text-to-Speech tts voice", "tts")).toBe(true);
	});
});
