import { describe, expect, test } from "bun:test";
import {
	CUSTOM_PRESET_ID,
	LISTEN_POST_PROCESS_PRESETS,
	resolveInstructions,
} from "./presets";

describe("listen post-process presets", () => {
	test("every preset resolves to its instruction body", () => {
		for (const preset of LISTEN_POST_PROCESS_PRESETS) {
			expect(resolveInstructions(preset.id, "")).toBe(preset.instructions);
		}
	});

	test("custom resolves to the trimmed typed instructions", () => {
		expect(resolveInstructions(CUSTOM_PRESET_ID, "  Do the thing.  ")).toBe(
			"Do the thing.",
		);
	});

	test("custom with nothing typed cannot run", () => {
		expect(resolveInstructions(CUSTOM_PRESET_ID, "   ")).toBeNull();
	});

	test("unknown preset ids cannot run", () => {
		expect(resolveInstructions("nope", "fallback text")).toBeNull();
	});

	test("preset ids are unique", () => {
		const ids = LISTEN_POST_PROCESS_PRESETS.map((preset) => preset.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).not.toContain(CUSTOM_PRESET_ID);
	});
});
