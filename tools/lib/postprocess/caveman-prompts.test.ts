import { describe, expect, test } from "bun:test";

import { buildSystemPrompt } from "../../../src/shared/lib/preset-prompts";
import { CAPABILITY_GAP_PROFILES, CAPABILITY_GAP_CASES } from "./corpus";
import {
	buildCavemanSystemPrompt,
	buildCavemanUserPrompt,
	cavemanOperationSummary,
} from "./caveman-prompts";
import { buildUserPromptForPresets } from "./prompts";

describe("production Caveman prompts", () => {
	test("legacy experiment wrappers now mirror production", () => {
		for (const profile of CAPABILITY_GAP_PROFILES) {
			expect(buildCavemanSystemPrompt(profile.presets)).toBe(
				buildSystemPrompt(profile.presets),
			);
			expect(buildCavemanUserPrompt("sample", profile.presets)).toBe(
				buildUserPromptForPresets("sample", profile.presets),
			);
		}
	});

	test("covers every benchmark profile with compact contracts", () => {
		for (const profile of CAPABILITY_GAP_PROFILES) {
			const system = buildSystemPrompt(profile.presets);
			const user = buildUserPromptForPresets("sample", profile.presets);
			expect(system).toContain("Return JSON with only `text`");
			expect(system).toContain("last version");
			expect(user).toContain("Return only transformed text");
			expect(system.length + user.length).toBeLessThan(5_000);
			if (profile.id !== "neutral") {
				expect(cavemanOperationSummary(profile.presets).length).toBeGreaterThan(
					0,
				);
			}
		}
	});

	test("Concise Caveman prompts both instruction and output in Caveman", () => {
		const presets = [{ key: "concise", level: "caveman" }] as const;
		const system = buildSystemPrompt(presets);
		const user = buildUserPromptForPresets(
			"Please check the API error.",
			presets,
		);
		for (const prompt of [system, user]) {
			expect(prompt).toContain("FINAL CAVEMAN PASS");
			expect(prompt).toContain("telegraphic");
		}
	});

	test("keeps translation last and input byte-for-byte at the tail", () => {
		const operations = cavemanOperationSummary([
			{ key: "translate", targetLang: "Spanish" },
			{ key: "friendly" },
		]);
		expect(operations[0]).toContain("friendly conversational tone");
		expect(operations[1]).toContain("translate result into Spanish");
		const input = "line one\n\nC:\\temp\\logs";
		expect(
			buildCavemanUserPrompt(input, [{ key: "neutral" }]).endsWith(input),
		).toBe(true);
	});

	test("does not leak benchmark wording into reusable prompts", () => {
		const prompt = CAPABILITY_GAP_PROFILES.map((profile) =>
			buildSystemPrompt(profile.presets),
		).join("\n");
		for (const testCase of CAPABILITY_GAP_CASES) {
			const distinctive = testCase.before.split(/\s+/).slice(0, 5).join(" ");
			expect(prompt.toLowerCase()).not.toContain(distinctive.toLowerCase());
		}
	});
});
