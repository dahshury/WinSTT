import { beforeEach, describe, expect, test } from "bun:test";
import {
	__resetLastTranscriptionForTesting__,
	getLastTranscription,
	setLastTranscription,
} from "./last-transcription";

describe("last-transcription", () => {
	beforeEach(() => {
		__resetLastTranscriptionForTesting__();
	});

	test("defaults to empty string before anything is dictated", () => {
		expect(getLastTranscription()).toBe("");
	});

	test("records and returns the most recent transcription", () => {
		setLastTranscription("hello world");
		expect(getLastTranscription()).toBe("hello world");
		setLastTranscription("second one");
		expect(getLastTranscription()).toBe("second one");
	});

	test("ignores empty / whitespace-only input so the prior transcript survives", () => {
		setLastTranscription("keep me");
		setLastTranscription("");
		setLastTranscription("   \n\t ");
		expect(getLastTranscription()).toBe("keep me");
	});

	test("reset hook clears the slot", () => {
		setLastTranscription("temp");
		__resetLastTranscriptionForTesting__();
		expect(getLastTranscription()).toBe("");
	});
});
