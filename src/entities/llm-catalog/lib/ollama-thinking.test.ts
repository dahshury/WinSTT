import { describe, expect, test } from "bun:test";
import {
	isAlwaysOnReasoningModel,
	ollamaThinkingMode,
	ollamaUsesThinkingLevels,
} from "./ollama-thinking";

const THINKING = ["completion", "thinking"];

describe("ollamaThinkingMode", () => {
	test("'none' when the model has no thinking capability and no catalog entry", () => {
		expect(ollamaThinkingMode("llama3.2:3b", ["completion", "tools"])).toBe(
			"none",
		);
		expect(ollamaThinkingMode("mystery-model:7b", undefined)).toBe("none");
	});

	test("catalog knowledge wins even when live capabilities are unknown (un-pulled model)", () => {
		// gpt-oss is recorded as `thinking: "levels"` in the catalog; the
		// classifier must not depend on /api/show having run.
		expect(ollamaThinkingMode("gpt-oss:20b", undefined)).toBe("levels");
		expect(ollamaThinkingMode("gpt-oss:20b", null)).toBe("levels");
		expect(ollamaThinkingMode("lfm2.5-thinking:1.2b", undefined)).toBe(
			"always-on",
		);
	});

	test("'levels' for GPT-OSS (any tag shares the catalog entry's base slug)", () => {
		expect(ollamaThinkingMode("gpt-oss:20b", THINKING)).toBe("levels");
		expect(ollamaThinkingMode("GPT-OSS:120b", THINKING)).toBe("levels");
	});

	test("'toggle' for hybrid thinking models (levels are no-ops)", () => {
		for (const m of ["gemma4:e4b", "qwen3.5:4b", "granite4.1:8b"]) {
			expect(ollamaThinkingMode(m, THINKING)).toBe("toggle");
		}
	});

	test("'always-on' for dedicated reasoning models (can't be turned off)", () => {
		for (const m of [
			"lfm2.5-thinking:1.2b",
			"phi4-mini-reasoning:3.8b",
			"deepseek-r1:7b",
			"qwq:32b",
			"magistral:24b",
		]) {
			expect(ollamaThinkingMode(m, THINKING)).toBe("always-on");
		}
	});

	test("always-on takes precedence over the levels check", () => {
		// A hypothetical gpt-oss reasoning build would still be treated as always-on.
		expect(ollamaThinkingMode("gpt-oss-reasoning:20b", THINKING)).toBe(
			"always-on",
		);
	});
});

describe("classifier helpers", () => {
	test("ollamaUsesThinkingLevels only matches gpt-oss", () => {
		expect(ollamaUsesThinkingLevels("gpt-oss:20b")).toBe(true);
		expect(ollamaUsesThinkingLevels("qwen3.5:4b")).toBe(false);
	});

	test("isAlwaysOnReasoningModel matches the always-on families", () => {
		expect(isAlwaysOnReasoningModel("deepseek-r1:7b")).toBe(true);
		expect(isAlwaysOnReasoningModel("lfm2.5-thinking:1.2b")).toBe(true);
		expect(isAlwaysOnReasoningModel("gemma4:e4b")).toBe(false);
		expect(isAlwaysOnReasoningModel("qwen3.5:9b")).toBe(false);
	});
});
