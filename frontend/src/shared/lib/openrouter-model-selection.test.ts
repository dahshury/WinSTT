import { describe, expect, test } from "bun:test";
import { createModelSelection, parseModelSelection } from "./openrouter-model-selection";

describe("parseModelSelection", () => {
	test("returns empty modelId for empty input AND no providerSlug key (early return)", () => {
		// Pin the early-return branch: empty input → object with ONLY modelId.
		// A mutator that flips `if (!value)` to `if (false)` would fall through
		// to the @-split path and produce `{ modelId: "" }` from lastIndexOf
		// returning -1 — same shape, so we additionally check that the
		// returned object has no providerSlug key at all.
		const result = parseModelSelection("");
		expect(result).toEqual({ modelId: "" });
		expect("providerSlug" in result).toBe(false);
	});

	test("returns just modelId when no provider segment present", () => {
		expect(parseModelSelection("openai/gpt-4o")).toEqual({
			modelId: "openai/gpt-4o",
		});
	});

	test("splits modelId@providerSlug at the LAST @ (model ids contain @)", () => {
		expect(parseModelSelection("openai/gpt-4o@deepinfra")).toEqual({
			modelId: "openai/gpt-4o",
			providerSlug: "deepinfra",
		});
		expect(parseModelSelection("a@b@c")).toEqual({ modelId: "a@b", providerSlug: "c" });
	});

	test("treats trailing @ as no provider slug", () => {
		expect(parseModelSelection("openai/gpt-4o@")).toEqual({
			modelId: "openai/gpt-4o",
		});
	});

	test("allows empty modelId with provider slug present", () => {
		// Edge case: '@deepinfra' → modelId '', providerSlug 'deepinfra'
		expect(parseModelSelection("@deepinfra")).toEqual({
			modelId: "",
			providerSlug: "deepinfra",
		});
	});
});

describe("createModelSelection", () => {
	test("returns empty string when modelId is empty", () => {
		expect(createModelSelection("")).toBe("");
		expect(createModelSelection("", "deepinfra")).toBe("");
	});

	test("returns modelId only when provider not supplied", () => {
		expect(createModelSelection("openai/gpt-4o")).toBe("openai/gpt-4o");
	});

	test("joins modelId@providerSlug when both supplied", () => {
		expect(createModelSelection("openai/gpt-4o", "deepinfra")).toBe("openai/gpt-4o@deepinfra");
	});

	test("treats empty providerSlug as no provider", () => {
		expect(createModelSelection("openai/gpt-4o", "")).toBe("openai/gpt-4o");
	});

	test("round-trips through parseModelSelection", () => {
		const cases: [string, string?][] = [
			["openai/gpt-4o"],
			["openai/gpt-4o", "deepinfra"],
			["anthropic/claude-3", "anthropic"],
		];
		for (const [modelId, providerSlug] of cases) {
			const encoded = createModelSelection(modelId, providerSlug);
			const decoded = parseModelSelection(encoded);
			expect(decoded.modelId).toBe(modelId);
			if (providerSlug) {
				expect(decoded.providerSlug).toBe(providerSlug);
			} else {
				expect(decoded.providerSlug).toBeUndefined();
			}
		}
	});
});
