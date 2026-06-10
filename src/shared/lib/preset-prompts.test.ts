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
	type PresetKey,
	TONE_GROUP,
} from "@/shared/lib/preset-prompts";

function makeCustomModifier(
	overrides: Partial<CustomModifier> = {},
): CustomModifier {
	return {
		id: "id-1",
		name: "My Style",
		prompt: "Wrap output in <result>…</result>.",
		enabled: true,
		levelsEnabled: false,
		...overrides,
	};
}

describe("preset-prompts", () => {
	test("ALL_PRESET_KEYS contains the ten canonical presets", () => {
		expect([...(ALL_PRESET_KEYS as readonly string[])].sort()).toEqual(
			[
				"concise",
				"formal",
				"friendly",
				"neutral",
				"reorder",
				"restructure",
				"rewordForClarity",
				"summarize",
				"technical",
				"translate",
			].sort(),
		);
	});

	test("TONE_GROUP and INDEPENDENT_PRESETS are disjoint and cover all keys", () => {
		const tones = new Set<PresetKey>(TONE_GROUP as readonly PresetKey[]);
		const indep = new Set<PresetKey>(
			INDEPENDENT_PRESETS as readonly PresetKey[],
		);
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
		const leveled = new Set<PresetKey>(
			PRESETS_WITH_LEVELS as readonly PresetKey[],
		);
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

	test("Polish base is present in every system prompt, exactly once", () => {
		const polishBase = getPresetPrompt("neutral");
		const occurrences = (haystack: string, needle: string): number =>
			haystack.split(needle).length - 1;

		for (const presets of [
			[] as const,
			[{ key: "neutral" }] as const,
			[{ key: "formal" }] as const,
			[{ key: "summarize", level: "high" }] as const,
			[
				{ key: "formal" },
				{ key: "concise", level: "medium" },
				{ key: "reorder" },
			] as const,
			[{ key: "neutral" }, { key: "neutral" }] as const,
		]) {
			const out = buildSystemPrompt([...presets]);
			expect(occurrences(out, polishBase)).toBe(1);
		}
	});

	test("neutral alone is exactly the Polish prompt (no extra style layer)", () => {
		const base = getPresetPrompt("neutral");
		const expected = buildSystemPrompt([]);
		expect(buildSystemPrompt([{ key: "neutral" }])).toBe(expected);
		expect(buildSystemPrompt([{ key: "neutral" }, { key: "neutral" }])).toBe(
			expected,
		);
		expect(expected).toContain(base);
		expect(expected).not.toContain("on top");
	});

	test("restructure defaults to prose and gates list conversion", () => {
		// Regression: restructure numbered every sentence of a connected
		// statement+question ("…Whisper models… Is that correct?") as 1-/2-/3-.
		const r = getPresetPrompt("restructure");
		expect(r.toLowerCase()).toContain("actively reshape content");
		expect(r).toContain(
			"Do NOT convert text to a list merely because it has several sentences",
		);
		expect(r.toLowerCase()).toContain(
			"never turn a standalone question into a list item",
		);
		expect(r).toContain("announces a count");
		expect(r).toContain("numbered list");
		expect(r).toContain("exactly as many items as the announced count");
		expect(r).toContain("Never leave an announced enumeration inline");
		expect(r).toContain("`* ` bullet lines (not `- `)");
		expect(r).toContain("label-value mappings");
		expect(r).toContain("blank line before and after every list");
		// The general boundary rule that replaced the case-specific
		// "then first problem" phrasing: a list ends where the enumeration ends.
		expect(r).toContain("A list ends where the enumeration ends");
		expect(r.toLowerCase()).toContain("never absorb the new topic");
	});

	test("reorder moves requests only when they stand alone", () => {
		const r = getPresetPrompt("reorder");
		expect(r).toContain("only when it improves the sequence");
		expect(r).toContain("does not depend on preceding context");
		expect(r).toContain("any existing list structure");
		expect(r).toContain("do not summarize or invent");
	});

	test("reword for clarity repairs slips conservatively and keeps voice", () => {
		const r = getPresetPrompt("rewordForClarity");
		expect(r).toContain("wrong-word slips");
		expect(r).toContain('"adopt to the request" -> "adapt to the request"');
		expect(r).toContain("when intent is unclear, keep the dictated wording");
		expect(r.toLowerCase()).toContain("vague placeholders");
		expect(r).toContain('do not change "we" to "you"');
		expect(r).toContain("Preserve incomplete trailing fragments exactly");
	});

	test("Polish base handles generalized cleanup and forbids unprompted structure", () => {
		const base = getPresetPrompt("neutral");
		expect(base).toContain("Core cleanup:");
		expect(base).toContain("Spoken-form conversion:");
		expect(base).toContain("Labels and quoting:");
		expect(base).toContain("Mishearing repair:");
		expect(base).toContain("Safety and scope:");
		expect(base).toContain("Do not add lists");
		expect(base).toContain("figures and symbols");
		expect(base).toContain('"fifty percent" -> "50%"');
		// Spoken layout commands must still survive the prohibition.
		expect(base).toContain("new paragraph");
		// Preservation outranks polish — the core small-model guardrail.
		expect(base).toContain("Preservation outranks polish");
	});

	test("post-processing prompt stays generalized rather than exact-output overfit", () => {
		const out = buildSystemPrompt([
			{ key: "neutral" },
			{ key: "reorder" },
			{ key: "restructure" },
			{ key: "rewordForClarity" },
			{ key: "concise", level: "high" },
		]);
		expect(out).toContain("Core cleanup:");
		expect(out).not.toMatch(/exact output/i);
		expect(out).not.toMatch(/literal final/i);
		// Phrases that previously leaked from individual regression cases.
		// The composed prompt must stay free of app/case-specific rules.
		for (const overfit of [
			"then first problem",
			"first case",
			"turns into",
			"for less",
			"TokenLens",
			"OpenRouter",
			"Push to Talk",
			"Taskbar",
			"default template",
			"table columns tab",
			"working hours",
			"day-specific",
			"auto-clean",
			"AI agent-initiated",
			"drag drop",
			"Here is how it works",
			"set up the tool",
			"Recording-mode color",
		]) {
			expect(out).not.toContain(overfit);
		}
	});

	test("a tone layers its own prompt on top of the Polish base", () => {
		const out = buildSystemPrompt([{ key: "formal" }]);
		expect(out).toContain(getPresetPrompt("neutral"));
		expect(out).toContain(getPresetPrompt("formal"));
		expect(out).toContain("on top");
	});

	test("translate is an independent preset with no levels", () => {
		expect(
			(INDEPENDENT_PRESETS as readonly string[]).includes("translate"),
		).toBe(true);
		expect(isToneKey("translate")).toBe(false);
		expect(hasLevels("translate")).toBe(false);
	});

	test("translate entry resolves the chosen target language into the prompt", () => {
		const out = buildSystemPrompt([
			{ key: "translate", targetLang: "Spanish" },
		]);
		// Polish base is still present exactly once (cleanup runs first).
		expect(out).toContain(getPresetPrompt("neutral"));
		// The target language is named in the composed instruction.
		expect(out).toContain("Spanish");
		// Generalization clause: English examples are illustrative only.
		expect(out.toLowerCase()).toContain("language-general");
		// Must not leak the original / transliteration.
		expect(out).toContain("Output ONLY the Spanish text");
	});

	test("translate is folded LAST so cleanup/style run in the source language", () => {
		const out = buildSystemPrompt([
			{ key: "formal" },
			{ key: "translate", targetLang: "French" },
		]);
		const formalIdx = out.indexOf(getPresetPrompt("formal"));
		const translateIdx = out.indexOf(
			"translate the cleaned, styled result into French",
		);
		expect(formalIdx).toBeGreaterThan(-1);
		expect(translateIdx).toBeGreaterThan(formalIdx);
	});

	test("translate without an explicit language defaults to English", () => {
		const out = buildSystemPrompt([{ key: "translate" }]);
		expect(out).toContain("into English");
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
		expect(out).toContain("Move a direct request");
		// Explicit anti-numbered-list check: no "1." / "2." / "3." prefixes.
		expect(out).not.toMatch(/^\s*1\./m);
	});

	test("concise and restructure preserve required layout when combined", () => {
		const out = buildSystemPrompt([
			{ key: "restructure" },
			{ key: "concise", level: "high" },
		]);
		expect(out).toContain("Restructure controls layout");
		expect(out).toContain("apply concision inside each item");
		expect(out).toContain("collapsing structure into prose");
	});

	describe("mergePresetsWithCustomModifiers", () => {
		const builtin = [{ key: "formal" }] as const;

		test("returns presets unchanged when customModifiers is null/undefined", () => {
			expect(mergePresetsWithCustomModifiers([...builtin], null)).toEqual([
				...builtin,
			]);
			expect(mergePresetsWithCustomModifiers([...builtin], undefined)).toEqual([
				...builtin,
			]);
		});

		test("returns presets unchanged when customModifiers is empty", () => {
			expect(mergePresetsWithCustomModifiers([...builtin], [])).toEqual([
				...builtin,
			]);
		});

		test("appends enabled, non-blank modifiers as custom entries", () => {
			const mod = makeCustomModifier({ id: "m1", prompt: "Be witty." });
			const result = mergePresetsWithCustomModifiers([...builtin], [mod]);
			expect(result).toHaveLength(2);
			// Built-in preset is preserved first.
			expect(result[0]).toEqual({ key: "formal" });
			// Custom modifier becomes a CUSTOM_MODIFIER_KEY-keyed entry.
			const custom = result[1];
			expect(custom).toBeDefined();
			if (!(custom && "id" in custom)) {
				throw new Error("expected custom entry with id");
			}
			expect(custom.id).toBe("m1");
			expect(custom.prompt).toBe("Be witty.");
			// levelsEnabled=false ⇒ no level carried through (resolveCustomPrompt
			// uses this branch to apply the prompt verbatim, no hint).
			expect(custom.level).toBeUndefined();
		});

		test("drops disabled modifiers", () => {
			const mod = makeCustomModifier({ enabled: false });
			expect(mergePresetsWithCustomModifiers([...builtin], [mod])).toEqual([
				...builtin,
			]);
		});

		test("drops modifiers with blank/whitespace-only prompts", () => {
			const blank = makeCustomModifier({ id: "blank", prompt: "   " });
			const empty = makeCustomModifier({ id: "empty", prompt: "" });
			expect(
				mergePresetsWithCustomModifiers([...builtin], [blank, empty]),
			).toEqual([...builtin]);
		});

		test("carries level through when levelsEnabled is true (defaults to medium)", () => {
			const explicit = makeCustomModifier({
				id: "explicit",
				levelsEnabled: true,
				level: "high",
			});
			const defaultLevel = makeCustomModifier({
				id: "default",
				levelsEnabled: true,
				// level intentionally omitted — `customModifierToEntry` falls
				// back to DEFAULT_LEVEL ("medium").
			});
			const result = mergePresetsWithCustomModifiers(
				[],
				[explicit, defaultLevel],
			);
			expect(result).toHaveLength(2);
			const first = result[0];
			const second = result[1];
			if (!(first && "id" in first && second && "id" in second)) {
				throw new Error("expected two custom entries");
			}
			expect(first.level).toBe("high");
			expect(second.level).toBe("medium");
		});

		test("custom modifier prompts are folded into the composed system prompt", () => {
			// End-to-end smoke through buildSystemPrompt → resolveEntryPrompt →
			// resolveCustomPrompt. The authored text + level hint must appear,
			// followed by the schema clamp the resolver always appends.
			const mod = makeCustomModifier({
				prompt: "Add a sparkle emoji at the end.",
				levelsEnabled: true,
				level: "light",
			});
			const merged = mergePresetsWithCustomModifiers([], [mod]);
			const out = buildSystemPrompt([...merged]);
			expect(out).toContain("Add a sparkle emoji at the end.");
			// Light-tier hint from CUSTOM_LEVEL_HINT.
			expect(out).toContain("Apply this lightly");
		});
	});
});
