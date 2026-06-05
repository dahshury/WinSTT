import { describe, expect, test } from "bun:test";
import { getProcessingStartedAt } from "./processing-start";

describe("getProcessingStartedAt", () => {
	test("keeps the transcription timer running when LLM thinking starts after STT decode", () => {
		expect(
			getProcessingStartedAt({
				isThinking: true,
				isTranscribing: true,
				thinkingStartedAt: 5_000,
				transcribingStartedAt: 1_000,
			})
		).toBe(1_000);
	});

	test("falls back to the LLM start when there is no active transcription timestamp", () => {
		expect(
			getProcessingStartedAt({
				isThinking: true,
				isTranscribing: false,
				thinkingStartedAt: 5_000,
				transcribingStartedAt: null,
			})
		).toBe(5_000);
	});

	test("returns null when no processing state is active", () => {
		expect(
			getProcessingStartedAt({
				isThinking: false,
				isTranscribing: false,
				thinkingStartedAt: 5_000,
				transcribingStartedAt: 1_000,
			})
		).toBeNull();
	});
});
