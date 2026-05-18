import { describe, expect, test } from "bun:test";
import {
	ALL_PRESET_KEYS,
	buildSystemPrompt,
	getPresetPrompt,
	hasLevels,
	INDEPENDENT_PRESETS,
	isToneKey,
	PRESET_LEVELS,
	PRESETS_WITH_LEVELS,
	type PresetKey,
	TONE_GROUP,
} from "./preset-prompts";

describe("preset-prompts", () => {
	test("ALL_PRESET_KEYS contains the ten canonical presets", () => {
		expect([...(ALL_PRESET_KEYS as readonly string[])].sort()).toEqual(
			[
				"casual",
				"concise",
				"formal",
				"friendly",
				"neutral",
				"reorder",
				"restructure",
				"rewordForClarity",
				"summarize",
				"technical",
			].sort()
		);
	});

	test("TONE_GROUP and INDEPENDENT_PRESETS are disjoint and cover all keys", () => {
		const tones = new Set<PresetKey>(TONE_GROUP as readonly PresetKey[]);
		const indep = new Set<PresetKey>(INDEPENDENT_PRESETS as readonly PresetKey[]);
		for (const key of ALL_PRESET_KEYS) {
			expect(tones.has(key) !== indep.has(key)).toBe(true);
		}
	});

	test("PRESETS_WITH_LEVELS is summarize and concise", () => {
		expect([...PRESETS_WITH_LEVELS].sort()).toEqual(["concise", "summarize"]);
	});

	test("isToneKey and hasLevels classify correctly", () => {
		expect(isToneKey("neutral")).toBe(true);
		expect(isToneKey("summarize")).toBe(false);
		expect(hasLevels("summarize")).toBe(true);
		expect(hasLevels("concise")).toBe(true);
		expect(hasLevels("reorder")).toBe(false);
	});

	test("every preset returns a non-empty prompt", () => {
		const leveled = new Set<PresetKey>(PRESETS_WITH_LEVELS as readonly PresetKey[]);
		for (const key of ALL_PRESET_KEYS) {
			if (leveled.has(key)) {
				for (const level of PRESET_LEVELS) {
					const prompt = getPresetPrompt(key, level);
					expect(prompt.length).toBeGreaterThan(10);
				}
			} else {
				const prompt = getPresetPrompt(key);
				expect(prompt.length).toBeGreaterThan(10);
			}
		}
	});

	test("level variants differ for summarize and concise", () => {
		for (const family of PRESETS_WITH_LEVELS) {
			const light = getPresetPrompt(family, "light");
			const medium = getPresetPrompt(family, "medium");
			const high = getPresetPrompt(family, "high");
			expect(new Set([light, medium, high]).size).toBe(3);
		}
	});

	test("buildSystemPrompt includes the neutral preset body for empty array", () => {
		// The system prompt now wraps every preset body with a trailing
		// reminder that the model should output ONLY the transformed text.
		// The structural guarantee comes from Ollama's `format` schema; the
		// reminder just keeps the model from putting reasoning INSIDE the
		// `text` field.
		const out = buildSystemPrompt([]);
		expect(out).toContain(getPresetPrompt("neutral"));
		expect(out.toLowerCase()).toContain("output only the transformed text");
	});

	test("buildSystemPrompt includes the single preset body verbatim", () => {
		const out = buildSystemPrompt([{ key: "formal" }]);
		expect(out).toContain(getPresetPrompt("formal"));
	});

	test("buildSystemPrompt combines multiple presets as bullets, NOT numbered steps", () => {
		// Numbered lists invite chain-of-thought ("I'll go through each in
		// turn") from reasoning models trained on instruction-following
		// data. Bullets phrase the same constraints as a unified style guide
		// the model applies in one pass.
		const out = buildSystemPrompt([
			{ key: "formal" },
			{ key: "summarize", level: "light" },
			{ key: "reorder" },
		]);
		expect(out).toContain("simultaneously");
		expect(out).toContain(`- ${getPresetPrompt("formal")}`);
		expect(out).toContain(`- ${getPresetPrompt("summarize", "light")}`);
		expect(out).toContain(`- ${getPresetPrompt("reorder")}`);
		// Explicit anti-numbered-list check: no "1." / "2." / "3." prefixes.
		expect(out).not.toMatch(/^\s*1\./m);
	});
});
