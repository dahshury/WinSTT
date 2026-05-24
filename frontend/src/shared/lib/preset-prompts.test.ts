import { describe, expect, test } from "bun:test";
import {
	ALL_PRESET_KEYS,
	buildSystemPrompt,
	CUSTOM_MODIFIER_KEY,
	type CustomModifier,
	type CustomModifierEntry,
	getPresetPrompt,
	hasLevels,
	INDEPENDENT_PRESETS,
	isCustomEntry,
	isToneKey,
	mergePresetsWithCustomModifiers,
	PRESET_LEVELS,
	PRESETS_WITH_LEVELS,
	type PresetEntry,
	TONE_GROUP,
} from "./preset-prompts";

// preset-prompts is load-bearing for LLM dictation cleanup. Asserts cover the
// public surface plus the sentinel-key merge contract documented in
// memory/project_custom_modifiers.md (custom modifiers fold into the runtime
// presets array via the __custom__ sentinel; disabled or empty entries are
// dropped; translate is always emitted last by composePresetBody).

// The schema-clamp tail that every preset prompt ends with. Spot-checking its
// presence keeps the per-preset structured-output guarantee from regressing.
const SCHEMA_CLAMP_TAIL = "Output only the transformed text";

function makeCustom(overrides: Partial<CustomModifier> = {}): CustomModifier {
	return {
		enabled: true,
		id: "m1",
		level: "medium",
		levelsEnabled: false,
		name: "My modifier",
		prompt: "Speak like a pirate.",
		...overrides,
	};
}

describe("isCustomEntry", () => {
	test("true when the entry uses the custom sentinel key", () => {
		const entry: PresetEntry = {
			key: CUSTOM_MODIFIER_KEY,
			id: "x",
			name: "x",
			prompt: "x",
		};
		expect(isCustomEntry(entry)).toBe(true);
	});

	test("false for any built-in preset key", () => {
		expect(isCustomEntry({ key: "neutral" })).toBe(false);
		expect(isCustomEntry({ key: "translate", targetLang: "Spanish" })).toBe(false);
	});
});

describe("isToneKey / hasLevels", () => {
	test("isToneKey returns true for every tone-group key", () => {
		for (const k of TONE_GROUP) {
			expect(isToneKey(k)).toBe(true);
		}
	});

	test("isToneKey returns false for non-tone keys", () => {
		for (const k of INDEPENDENT_PRESETS) {
			expect(isToneKey(k)).toBe(false);
		}
	});

	test("hasLevels returns true exactly for the leveled preset keys", () => {
		for (const k of PRESETS_WITH_LEVELS) {
			expect(hasLevels(k)).toBe(true);
		}
		expect(hasLevels("neutral")).toBe(false);
		expect(hasLevels("translate")).toBe(false);
	});

	test("ALL_PRESET_KEYS unions tones and independent presets without overlap", () => {
		// `length` on `as const` tuples is a literal type, so coerce to `number`
		// before comparing the runtime sums.
		const allLen: number = ALL_PRESET_KEYS.length;
		const sum: number = TONE_GROUP.length + INDEPENDENT_PRESETS.length;
		expect(allLen).toBe(sum);
		expect(new Set(ALL_PRESET_KEYS).size).toBe(allLen);
	});

	test("PRESET_LEVELS is the three standard intensities", () => {
		expect(PRESET_LEVELS).toEqual(["light", "medium", "high"]);
	});
});

describe("getPresetPrompt", () => {
	test("every preset key resolves to a non-empty string ending in the schema clamp", () => {
		for (const k of ALL_PRESET_KEYS) {
			const out = getPresetPrompt(k);
			expect(out.length).toBeGreaterThan(0);
			expect(out).toContain(SCHEMA_CLAMP_TAIL);
		}
	});

	test("leveled presets emit different prompts per level", () => {
		const light = getPresetPrompt("concise", "light");
		const medium = getPresetPrompt("concise", "medium");
		const high = getPresetPrompt("concise", "high");
		expect(light).not.toBe(medium);
		expect(medium).not.toBe(high);
	});

	test("leveled presets default to medium when no level is supplied", () => {
		expect(getPresetPrompt("concise")).toBe(getPresetPrompt("concise", "medium"));
		expect(getPresetPrompt("summarize")).toBe(getPresetPrompt("summarize", "medium"));
	});

	test("translate preset returns a prompt mentioning the default target language", () => {
		const out = getPresetPrompt("translate");
		expect(out).toContain("English");
	});
});

describe("mergePresetsWithCustomModifiers", () => {
	const builtins: readonly PresetEntry[] = [{ key: "neutral" }, { key: "formal" }];

	test("returns a copy of the presets when the modifier list is null/undefined", () => {
		const out = mergePresetsWithCustomModifiers(builtins, null);
		expect(out).toEqual([...builtins]);
		// Must NOT alias the input.
		expect(out).not.toBe(builtins);
	});

	test("returns a copy of the presets when the modifier list is empty", () => {
		expect(mergePresetsWithCustomModifiers(builtins, [])).toEqual([...builtins]);
	});

	test("appends enabled, non-blank modifiers using the sentinel key", () => {
		const m = makeCustom({ id: "a" });
		const out = mergePresetsWithCustomModifiers(builtins, [m]);
		expect(out.length).toBe(builtins.length + 1);
		const last = out.at(-1) as CustomModifierEntry;
		expect(last.key).toBe(CUSTOM_MODIFIER_KEY);
		expect(last.id).toBe("a");
		expect(last.name).toBe(m.name);
		expect(last.prompt).toBe(m.prompt);
	});

	test("drops disabled modifiers", () => {
		const out = mergePresetsWithCustomModifiers(builtins, [
			makeCustom({ enabled: false, id: "off" }),
		]);
		expect(out).toEqual([...builtins]);
	});

	test("drops modifiers whose prompt is blank or whitespace-only", () => {
		const out = mergePresetsWithCustomModifiers(builtins, [
			makeCustom({ id: "empty", prompt: "" }),
			makeCustom({ id: "ws", prompt: "   \t  " }),
		]);
		expect(out).toEqual([...builtins]);
	});

	test("carries level through when levelsEnabled is true", () => {
		const out = mergePresetsWithCustomModifiers(builtins, [
			makeCustom({ id: "lvl", level: "high", levelsEnabled: true }),
		]);
		const last = out.at(-1) as CustomModifierEntry;
		expect(last.level).toBe("high");
	});

	test("omits level when levelsEnabled is false (single-prompt mode)", () => {
		const out = mergePresetsWithCustomModifiers(builtins, [
			makeCustom({ id: "nolvl", level: "high", levelsEnabled: false }),
		]);
		const last = out.at(-1) as CustomModifierEntry;
		expect(last.level).toBeUndefined();
	});

	test("defaults the carried level to medium when levelsEnabled but level missing", () => {
		// `level` is `level?: PresetLevel | undefined`, so we cast through the
		// partial overrides shape to omit it.
		const out = mergePresetsWithCustomModifiers(builtins, [
			makeCustom({ id: "auto", levelsEnabled: true, level: undefined }),
		]);
		const last = out.at(-1) as CustomModifierEntry;
		expect(last.level).toBe("medium");
	});
});

describe("buildSystemPrompt", () => {
	test("with no presets, emits just the Polish base + closing reminder", () => {
		const out = buildSystemPrompt([]);
		expect(out).toContain("Clean up dictated speech");
		expect(out).toContain("Output only the transformed text in the `text` field.");
	});

	test("`[neutral]` collapses to the same output as `[]` (neutral IS the base)", () => {
		expect(buildSystemPrompt([{ key: "neutral" }])).toBe(buildSystemPrompt([]));
	});

	test("a single non-neutral preset is layered on top with the 'apply this style' phrasing", () => {
		const out = buildSystemPrompt([{ key: "formal" }]);
		expect(out).toContain("Then apply this style on top");
		expect(out).toContain("professional business English");
	});

	test("multiple non-neutral presets are rendered as a bulleted list", () => {
		const out = buildSystemPrompt([{ key: "formal" }, { key: "concise", level: "high" }]);
		expect(out).toContain("Then apply all of the following style constraints");
		expect(out).toMatch(/^- /m);
	});

	test("translate is always the LAST bullet, regardless of input order", () => {
		const out = buildSystemPrompt([
			{ key: "translate", targetLang: "Spanish" },
			{ key: "formal" },
			{ key: "concise", level: "medium" },
		]);
		const formalIdx = out.indexOf("professional business English");
		const conciseIdx = out.indexOf("Compress wording");
		const translateIdx = out.indexOf("Spanish");
		expect(formalIdx).toBeGreaterThanOrEqual(0);
		expect(conciseIdx).toBeGreaterThanOrEqual(0);
		expect(translateIdx).toBeGreaterThan(formalIdx);
		expect(translateIdx).toBeGreaterThan(conciseIdx);
	});

	test("translate inherits the chosen targetLang and falls back to English when blank", () => {
		const withTarget = buildSystemPrompt([{ key: "translate", targetLang: "French" }]);
		expect(withTarget).toContain("French");
		const blank = buildSystemPrompt([{ key: "translate", targetLang: "" }]);
		expect(blank).toContain("English");
	});

	test("custom modifier with levelsEnabled appends a level hint before the schema clamp", () => {
		const merged = mergePresetsWithCustomModifiers(
			[{ key: "neutral" }],
			[makeCustom({ id: "p", prompt: "Use emoji.", levelsEnabled: true, level: "light" })]
		);
		const out = buildSystemPrompt(merged);
		expect(out).toContain("Use emoji.");
		expect(out).toContain("Apply this lightly");
		expect(out).toContain(SCHEMA_CLAMP_TAIL);
	});

	test("custom modifier without levels applies the prompt verbatim (no hint)", () => {
		const merged = mergePresetsWithCustomModifiers(
			[{ key: "neutral" }],
			[makeCustom({ id: "p", prompt: "Use emoji.", levelsEnabled: false })]
		);
		const out = buildSystemPrompt(merged);
		expect(out).toContain("Use emoji.");
		expect(out).not.toContain("Apply this lightly");
		expect(out).not.toContain("Apply this moderately");
		expect(out).not.toContain("Apply this strongly");
	});

	test("custom-level high/medium hints render as expected", () => {
		const high = buildSystemPrompt(
			mergePresetsWithCustomModifiers(
				[],
				[makeCustom({ id: "h", prompt: "X.", levelsEnabled: true, level: "high" })]
			)
		);
		expect(high).toContain("Apply this strongly and thoroughly");
		const med = buildSystemPrompt(
			mergePresetsWithCustomModifiers(
				[],
				[makeCustom({ id: "m", prompt: "X.", levelsEnabled: true, level: "medium" })]
			)
		);
		expect(med).toContain("Apply this moderately");
	});
});
