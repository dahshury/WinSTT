import { describe, expect, test } from "bun:test";
import type { SentenceSpan } from "./playback-queue";
import { activeTokenIndex, buildScriptTokens } from "./script-timing";

const span = (index: number, start: number, end: number): SentenceSpan => ({
	index,
	start,
	end,
});

describe("buildScriptTokens", () => {
	test("splits every sentence into whitespace-separated tokens", () => {
		const tokens = buildScriptTokens(["Hello there.", "How are you?"], []);
		expect(tokens.map((t) => t.text)).toEqual([
			"Hello",
			"there.",
			"How",
			"are",
			"you?",
		]);
		expect(tokens.map((t) => t.index)).toEqual([0, 1, 2, 3, 4]);
		expect(tokens.map((t) => t.sentenceIndex)).toEqual([0, 0, 1, 1, 1]);
	});

	test("a sentence with no buffered audio yet stays untimed rather than absent", () => {
		// The island shows the WHOLE script from the moment it arrives; the tail
		// that is still synthesizing just renders as not-yet-spoken.
		const tokens = buildScriptTokens(["one two", "three"], [span(0, 0, 1)]);
		expect(tokens[0]?.start).toBe(0);
		expect(tokens.at(-1)?.text).toBe("three");
		expect(tokens.at(-1)?.start).toBeNull();
		expect(tokens.at(-1)?.end).toBeNull();
	});

	test("a sentence's tokens exactly fill its audio window", () => {
		const tokens = buildScriptTokens(["alpha be c"], [span(0, 2, 6)]);
		expect(tokens[0]?.start).toBe(2);
		// No gaps and no overshoot: each token starts where the previous ended and
		// the last one lands on the span's end.
		for (let i = 1; i < tokens.length; i++) {
			expect(tokens[i]?.start).toBeCloseTo(tokens[i - 1]?.end ?? -1, 10);
		}
		expect(tokens.at(-1)?.end).toBeCloseTo(6, 10);
	});

	test("longer words get proportionally more time than shorter ones", () => {
		const [short, long] = buildScriptTokens(
			["a alphabetical"],
			[span(0, 0, 10)],
		);
		const shortWidth = (short?.end ?? 0) - (short?.start ?? 0);
		const longWidth = (long?.end ?? 0) - (long?.start ?? 0);
		expect(longWidth).toBeGreaterThan(shortWidth);
		// The `+1` floor keeps a one-letter word from flashing past unreadably.
		expect(shortWidth).toBeGreaterThan(0);
	});

	test("sentence windows are independent, so estimation error cannot accumulate", () => {
		// Sentence 1 is long text over short audio, sentence 2 the reverse. Each
		// still starts and ends exactly on its own span.
		const tokens = buildScriptTokens(
			["a very wordy first sentence indeed", "short"],
			[span(0, 0, 1), span(1, 1, 9)],
		);
		const second = tokens.filter((t) => t.sentenceIndex === 1);
		expect(second[0]?.start).toBe(1);
		expect(second.at(-1)?.end).toBeCloseTo(9, 10);
	});

	test("multiple chunks per sentence collapse into one span", () => {
		// `getSentenceSpans` unions them; this asserts the consumer honours the
		// union rather than the first chunk's window.
		const tokens = buildScriptTokens(["one two"], [span(0, 0, 4)]);
		expect(tokens.at(-1)?.end).toBeCloseTo(4, 10);
	});

	test("flags inline paralinguistic tags in BOTH shipped syntaxes", () => {
		// Orpheus reads `<laugh>`, Chatterbox Turbo reads `[laugh]` — the two
		// vocabularies are not interchangeable, so both must be recognized.
		const tokens = buildScriptTokens(["ha <laugh> ho [sigh] hm"], []);
		expect(tokens.filter((t) => t.tag).map((t) => t.text)).toEqual([
			"<laugh>",
			"[sigh]",
		]);
	});

	test("skips blank sentences and collapses runs of whitespace", () => {
		const tokens = buildScriptTokens(["  ", "a\n\nb  c "], []);
		expect(tokens.map((t) => t.text)).toEqual(["a", "b", "c"]);
		// The blank sentence is skipped but does NOT renumber the survivors'
		// sentence index — that index addresses the audio spans.
		expect(tokens.every((t) => t.sentenceIndex === 1)).toBe(true);
	});

	test("an empty script produces no tokens", () => {
		expect(buildScriptTokens([], [])).toEqual([]);
	});
});

describe("activeTokenIndex", () => {
	const tokens = buildScriptTokens(
		["aa bb", "cc dd"],
		[span(0, 0, 2), span(1, 2, 4)],
	);

	test("returns -1 before the first token starts", () => {
		const late = buildScriptTokens(["aa"], [span(0, 5, 6)]);
		expect(activeTokenIndex(late, 1)).toBe(-1);
	});

	test("returns -1 when nothing is timed yet", () => {
		expect(activeTokenIndex(buildScriptTokens(["aa bb"], []), 3)).toBe(-1);
	});

	test("advances through the tokens as the playhead moves", () => {
		const seen = tokens.map((token) =>
			activeTokenIndex(tokens, (token.start ?? 0) + 0.01),
		);
		expect(seen).toEqual([0, 1, 2, 3]);
	});

	test("holds on the last spoken token past the end of the timed audio", () => {
		// Between one sentence draining and the next arriving the queue clamps its
		// clock to the buffered end; the highlight must stay put, not blink off.
		expect(activeTokenIndex(tokens, 999)).toBe(tokens.length - 1);
	});

	test("resolves correctly when the playhead jumps backwards (a seek)", () => {
		expect(activeTokenIndex(tokens, 0)).toBe(0);
	});

	test("ignores the untimed tail when picking the active token", () => {
		const partial = buildScriptTokens(["aa bb", "cc"], [span(0, 0, 2)]);
		expect(activeTokenIndex(partial, 999)).toBe(1);
	});
});
