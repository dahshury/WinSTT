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

	test("buildSystemPrompt returns neutral fallback for empty array", () => {
		expect(buildSystemPrompt([])).toBe(getPresetPrompt("neutral"));
	});

	test("buildSystemPrompt returns single prompt verbatim for one entry", () => {
		expect(buildSystemPrompt([{ key: "formal" }])).toBe(getPresetPrompt("formal"));
		expect(buildSystemPrompt([{ key: "summarize", level: "high" }])).toBe(
			getPresetPrompt("summarize", "high")
		);
	});

	test("buildSystemPrompt numbers multiple entries", () => {
		const out = buildSystemPrompt([
			{ key: "formal" },
			{ key: "summarize", level: "light" },
			{ key: "reorder" },
		]);
		expect(out.startsWith("Apply the following transformations")).toBe(true);
		expect(out).toContain(`1. ${getPresetPrompt("formal")}`);
		expect(out).toContain(`2. ${getPresetPrompt("summarize", "light")}`);
		expect(out).toContain(`3. ${getPresetPrompt("reorder")}`);
	});
});
