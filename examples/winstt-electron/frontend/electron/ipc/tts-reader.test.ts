import { describe, expect, test } from "bun:test";
import { runSentenceRead, type SentenceReadControl, splitSentences } from "./tts-reader";

describe("splitSentences", () => {
	test("returns [] for blank input", () => {
		expect(splitSentences("")).toEqual([]);
		expect(splitSentences("   \n  ")).toEqual([]);
	});

	test("splits on sentence terminators, trimming each", () => {
		expect(splitSentences("Hello world. How are you? Fine!")).toEqual([
			"Hello world.",
			"How are you?",
			"Fine!",
		]);
	});

	test("keeps a trailing un-terminated fragment as its own sentence", () => {
		expect(splitSentences("First sentence. Then a tail")).toEqual([
			"First sentence.",
			"Then a tail",
		]);
	});

	test("treats text with no terminator as one sentence", () => {
		expect(splitSentences("just some words")).toEqual(["just some words"]);
	});

	test("keeps closing quotes/brackets with the sentence", () => {
		expect(splitSentences('She said "hi." Then left.')).toEqual(['She said "hi."', "Then left."]);
	});

	test("hard-caps an over-long sentence on word boundaries", () => {
		const word = "word";
		const long = `${new Array(100).fill(word).join(" ")}.`; // ~499 chars, no terminator until end
		const parts = splitSentences(long, 50);
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts) {
			expect(part.length).toBeLessThanOrEqual(50);
		}
	});

	test("hard-splits a single word longer than maxLen", () => {
		const parts = splitSentences("a".repeat(120), 50);
		expect(parts).toHaveLength(3);
		expect(parts[0]).toHaveLength(50);
		expect(parts[2]).toHaveLength(20);
	});
});

describe("runSentenceRead", () => {
	function control(over: Partial<SentenceReadControl> = {}): SentenceReadControl {
		return { getSpeed: () => 1, isCancelled: () => false, ...over };
	}

	test("synthesizes each sentence in order with the live speed", async () => {
		const calls: Array<{ sentence: string; index: number; speed: number }> = [];
		await runSentenceRead(
			"One. Two. Three.",
			(sentence, index, speed) => {
				calls.push({ sentence, index, speed });
				return Promise.resolve();
			},
			control({ getSpeed: () => 1.5 })
		);
		expect(calls).toEqual([
			{ sentence: "One.", index: 0, speed: 1.5 },
			{ sentence: "Two.", index: 1, speed: 1.5 },
			{ sentence: "Three.", index: 2, speed: 1.5 },
		]);
	});

	test("samples speed fresh for each sentence (mid-read change applies next)", async () => {
		let speed = 1;
		const seen: number[] = [];
		await runSentenceRead(
			"One. Two. Three.",
			(_s, index, s) => {
				seen.push(s);
				// Bump the speed "between" sentences — the next one should pick it up.
				if (index === 0) {
					speed = 2;
				}
				return Promise.resolve();
			},
			control({ getSpeed: () => speed })
		);
		expect(seen).toEqual([1, 2, 2]);
	});

	test("stops firing new sentences once cancelled", async () => {
		const seen: string[] = [];
		let cancelled = false;
		await runSentenceRead(
			"One. Two. Three.",
			(sentence) => {
				seen.push(sentence);
				cancelled = true; // cancel after the first sentence
				return Promise.resolve();
			},
			control({ isCancelled: () => cancelled })
		);
		expect(seen).toEqual(["One."]);
	});

	test("never synthesizes when cancelled before the first sentence", async () => {
		let count = 0;
		await runSentenceRead(
			"One. Two.",
			() => {
				count += 1;
				return Promise.resolve();
			},
			control({ isCancelled: () => true })
		);
		expect(count).toBe(0);
	});
});
