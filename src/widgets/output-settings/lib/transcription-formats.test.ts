import { describe, expect, test } from "bun:test";
import {
	resolveSelectedFormats,
	toggleTranscriptionFormat,
	transcriptionFormatsEqual,
} from "./transcription-formats";

describe("file transcription formats", () => {
	test("falls back to txt when the array is empty", () => {
		expect(
			resolveSelectedFormats({
				fileTranscriptionFormats: [],
			}),
		).toEqual(["txt"]);
	});

	test("the non-empty array wins and is deduplicated", () => {
		expect(
			resolveSelectedFormats({
				fileTranscriptionFormats: ["vtt", "json", "vtt"],
			}),
		).toEqual(["vtt", "json"]);
	});

	test("the final selected format cannot be removed", () => {
		expect(toggleTranscriptionFormat(["txt"], "txt")).toEqual(["txt"]);
		expect(toggleTranscriptionFormat(["txt", "srt"], "txt")).toEqual(["srt"]);
	});

	test("format selections compare by value for reset state", () => {
		expect(transcriptionFormatsEqual(["txt", "json"], ["txt", "json"])).toBe(
			true,
		);
		expect(transcriptionFormatsEqual(["json", "txt"], ["txt", "json"])).toBe(
			false,
		);
	});
});
