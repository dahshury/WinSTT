import { describe, expect, test } from "bun:test";
import { PRESET_PROMPTS } from "./preset-prompts";

describe("PRESET_PROMPTS", () => {
	test("includes the six canonical presets", () => {
		const keys = Object.keys(PRESET_PROMPTS).sort();
		expect(keys).toEqual(
			["casual", "concise", "formal", "friendly", "neutral", "technical"].sort()
		);
	});

	test("every entry has a non-empty prompt string", () => {
		for (const [key, prompt] of Object.entries(PRESET_PROMPTS)) {
			expect(typeof prompt).toBe("string");
			expect(prompt.length).toBeGreaterThan(10);
			expect(key.length).toBeGreaterThan(0);
		}
	});

	test("prompts are unique", () => {
		const values = Object.values(PRESET_PROMPTS);
		expect(new Set(values).size).toBe(values.length);
	});
});
