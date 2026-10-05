import { describe, expect, test } from "bun:test";
import { resolveLanguageControlMode } from "./language-controls";

const model = (
	id: string,
	family: string,
	languages: string[],
	supportsLanguageDetection: boolean,
) => ({ id, family, languages, supportsLanguageDetection }) as never;

describe("resolveLanguageControlMode", () => {
	test("language-prompted models without auto-detect get the single-language picker", () => {
		expect(
			resolveLanguageControlMode(
				model("audio8-asr-infinite", "audio8", ["zh", "en"], false),
				false,
			),
		).toBe("single");
		expect(
			resolveLanguageControlMode(
				model("nemo-canary-1b-v2", "nemo", ["en", "de", "fr"], false),
				false,
			),
		).toBe("single");
	});

	test("other non-detecting multilingual models keep the picker hidden", () => {
		expect(
			resolveLanguageControlMode(
				model("audio8-asr-0.1b", "audio8", ["en", "zh"], false),
				false,
			),
		).toBe("hidden");
	});

	test("cloud selection hides the picker", () => {
		expect(
			resolveLanguageControlMode(
				model("audio8-asr-infinite", "audio8", ["zh", "en"], false),
				true,
			),
		).toBe("hidden");
	});
});
