import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "./setting";

describe("DEFAULT_SETTINGS", () => {
	test("derives a fully-populated settings object from the schema", () => {
		expect(DEFAULT_SETTINGS).toBeDefined();
		expect(DEFAULT_SETTINGS.general.recordingMode).toBe("ptt");
		expect(DEFAULT_SETTINGS.model.model).toBe("tiny");
		expect(DEFAULT_SETTINGS.audio.sampleRate).toBe(16_000);
		expect(DEFAULT_SETTINGS.dictionary).toEqual([]);
		expect(DEFAULT_SETTINGS.snippets).toEqual([]);
	});
});
