import { describe, expect, test } from "bun:test";
import {
	ALL_PRESET_KEYS,
	buildSystemPrompt,
	type CustomModifier,
	getPresetPrompt,
	hasLevels,
	INDEPENDENT_PRESETS,
	isToneKey,
	mergePresetsWithCustomModifiers,
	PRESET_LEVELS,
	PRESETS_WITH_LEVELS,
	STANDARD_PRESET_LEVELS,
	TONE_GROUP,
} from "@/shared/lib/preset-prompts";

function custom(overrides: Partial<CustomModifier> = {}): CustomModifier {
	return {
		id: "id-1",
		name: "My Style",
		prompt: "Be witty.",
		enabled: true,
		levelsEnabled: false,
		...overrides,
	};
}

describe("preset-prompts", () => {
	test("keeps the canonical preset groups", () => {
		expect(ALL_PRESET_KEYS).toHaveLength(10);
		expect(TONE_GROUP).toEqual(["neutral", "formal", "friendly", "technical"]);
		expect(INDEPENDENT_PRESETS).toContain("translate");
		expect(PRESETS_WITH_LEVELS).toEqual(["summarize", "concise"]);
		expect(isToneKey("formal")).toBe(true);
		expect(hasLevels("concise")).toBe(true);
		expect(hasLevels("reorder")).toBe(false);
	});

	test("adds Caveman as the fourth level while retaining standard levels", () => {
		expect(PRESET_LEVELS).toEqual(["light", "medium", "high", "caveman"]);
		expect(STANDARD_PRESET_LEVELS).toEqual(["light", "medium", "high"]);
	});

	test("every preset and supported level has a compact instruction", () => {
		for (const key of ALL_PRESET_KEYS) {
			if (hasLevels(key)) {
				for (const level of PRESET_LEVELS) {
					expect(getPresetPrompt(key, level).length).toBeGreaterThan(10);
				}
			} else {
				expect(getPresetPrompt(key).length).toBeGreaterThan(10);
			}
		}
	});

	test("Caveman is a distinct concise output style", () => {
		const prompt = getPresetPrompt("concise", "caveman");
		expect(prompt).toContain("FINAL CAVEMAN PASS");
		expect(prompt).toContain("highest priority");
		expect(prompt).toContain("terse telegraphic text");
		expect(prompt).toContain("copy technical terms, code");
		expect(prompt).toContain(
			"never translate, normalize, shorten, pluralize, or substitute",
		);
		expect(prompt).toContain("Never invent abbreviations");
		expect(prompt).toContain('"authentication" stays "authentication"');
	});

	test("malformed summarize Caveman degrades safely to summarize high", () => {
		expect(getPresetPrompt("summarize", "caveman")).toBe(
			getPresetPrompt("summarize", "high"),
		);
	});

	test("all system prompts use the compact Caveman-v2 base", () => {
		const neutral = getPresetPrompt("neutral");
		const out = buildSystemPrompt([
			{ key: "friendly" },
			{ key: "concise", level: "caveman" },
			{ key: "restructure" },
		]);
		expect(out).toContain(neutral);
		expect(out.split(neutral)).toHaveLength(2);
		expect(out).toContain("ACTIVE, mandatory:");
		expect(out).toContain("Return JSON with only `text`");
		expect(out).toContain("FINAL CAVEMAN PASS");
		expect(out.length).toBeLessThan(4000);
	});

	test("translate is ordered after other operations", () => {
		const out = buildSystemPrompt([
			{ key: "translate", targetLang: "Spanish" },
			{ key: "formal" },
		]);
		expect(out.indexOf("Formal:")).toBeLessThan(
			out.indexOf("Translate result into Spanish"),
		);
		expect(out).toContain("quoted UI labels");
	});

	test("Caveman is the final output pass after translation and other styles", () => {
		const out = buildSystemPrompt([
			{ key: "concise", level: "caveman" },
			{ key: "translate", targetLang: "Spanish" },
			{ key: "friendly" },
		]);
		expect(out.indexOf("Friendly:")).toBeLessThan(
			out.indexOf("Translate result into Spanish"),
		);
		expect(out.indexOf("Translate result into Spanish")).toBeLessThan(
			out.indexOf("FINAL CAVEMAN PASS"),
		);
	});

	test("prompt stays generalized instead of benchmark-specific", () => {
		const out = buildSystemPrompt([
			{ key: "restructure" },
			{ key: "rewordForClarity" },
		]);
		for (const leaked of [
			"TokenLens",
			"OpenRouter",
			"Push to Talk",
			"Taskbar",
		]) {
			expect(out).not.toContain(leaked);
		}
	});

	test("merges only enabled nonblank custom modifiers", () => {
		const result = mergePresetsWithCustomModifiers(
			[{ key: "formal" }],
			[
				custom({ id: "on", levelsEnabled: true, level: "high" }),
				custom({ id: "off", enabled: false }),
				custom({ id: "blank", prompt: "   " }),
			],
		);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ key: "formal" });
		expect(result[1]).toMatchObject({
			id: "on",
			name: "My Style",
			prompt: "Be witty.",
			level: "high",
		});
		expect(buildSystemPrompt(result)).toContain(
			'Custom "My Style": Be witty. Apply strongly.',
		);
	});

	test("custom modifier level defaults to medium only when enabled", () => {
		const [entry] = mergePresetsWithCustomModifiers(
			[],
			[custom({ levelsEnabled: true })],
		);
		expect(entry).toMatchObject({ level: "medium" });
	});
});
