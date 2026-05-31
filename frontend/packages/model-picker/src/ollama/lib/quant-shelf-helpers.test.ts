import { describe, expect, it } from "bun:test";
import type { OllamaLibraryTag } from "@/shared/api/models";
import {
	canonicalOllamaTag,
	isSameOllamaTag,
	isTagInstalled,
	libraryBaseSlug,
	paramSizeFromName,
	pruneToShownQuants,
	quantBadgeCacheState,
	quantBadgeLabel,
	tagsForParamSize,
} from "./quant-shelf-helpers";

function tag(partial: Partial<OllamaLibraryTag> & { name: string }): OllamaLibraryTag {
	return { ...partial };
}

describe("libraryBaseSlug", () => {
	it("strips the variant after the colon", () => {
		expect(libraryBaseSlug("gemma3:4b-q8_0")).toBe("gemma3");
		expect(libraryBaseSlug("llama3.2:1b")).toBe("llama3.2");
	});

	it("lower-cases and handles bare base tags", () => {
		expect(libraryBaseSlug("Gemma3")).toBe("gemma3");
		expect(libraryBaseSlug("  qwen3  ")).toBe("qwen3");
	});
});

describe("paramSizeFromName", () => {
	it("pulls the param token out of the variant", () => {
		expect(paramSizeFromName("gemma3:4b-q8_0")).toBe("4b");
		expect(paramSizeFromName("qwen3:1.7b")).toBe("1.7b");
		expect(paramSizeFromName("smollm2:135m")).toBe("135m");
	});

	it("returns empty when there's no param token", () => {
		expect(paramSizeFromName("gemma3")).toBe("");
		expect(paramSizeFromName("phi3:mini")).toBe("");
	});

	it("captures Gemma MatFormer effective sizes (e2b / e4b)", () => {
		expect(paramSizeFromName("gemma4:e2b")).toBe("e2b");
		expect(paramSizeFromName("gemma4:e4b-it-q8_0")).toBe("e4b");
	});
});

describe("pruneToShownQuants", () => {
	const noKeep = () => false;
	it("keeps the canonical ladder + bare default, drops dominated/irrelevant", () => {
		const tags = [
			tag({ name: "qwen3.5:4b" }), // bare default
			tag({ name: "qwen3.5:4b-q4_K_M", quantization: "Q4_K_M" }),
			tag({ name: "qwen3.5:4b-q5_K_M", quantization: "Q5_K_M" }),
			tag({ name: "qwen3.5:4b-q8_0", quantization: "Q8_0" }),
			tag({ name: "qwen3.5:4b-fp16" }),
			tag({ name: "qwen3.5:4b-q4_0" }), // legacy linear → drop
			tag({ name: "qwen3.5:4b-q2_K" }), // too lossy → drop
			tag({ name: "qwen3.5:4b-q4_K_S" }), // near-dup → drop
			tag({ name: "qwen3.5:4b-mlx" }), // Apple-only → drop
			tag({ name: "qwen3.5:4b-mxfp8" }), // niche → drop
			tag({ name: "qwen3.5:4b-nvfp4" }), // niche → drop
			tag({ name: "qwen3.5:4b-bf16" }), // ≈fp16 → drop
		];
		expect(pruneToShownQuants(tags, noKeep).map((t) => t.name)).toEqual([
			"qwen3.5:4b",
			"qwen3.5:4b-q4_K_M",
			"qwen3.5:4b-q5_K_M",
			"qwen3.5:4b-q8_0",
			"qwen3.5:4b-fp16",
		]);
	});

	it("always keeps a tag the user has on disk / is downloading, even if dominated", () => {
		const tags = [tag({ name: "m:4b-q4_0" }), tag({ name: "m:4b-mlx" })];
		const keep = (n: string) => n === "m:4b-q4_0";
		expect(pruneToShownQuants(tags, keep).map((t) => t.name)).toEqual(["m:4b-q4_0"]);
	});
});

describe("tagsForParamSize", () => {
	const tags = [
		tag({ name: "gemma3:4b", parameterSize: "4b", quantization: "Q4_K_M" }),
		tag({ name: "gemma3:4b-q8_0", parameterSize: "4b", quantization: "Q8_0" }),
		tag({ name: "gemma3:27b", parameterSize: "27b", quantization: "Q4_K_M" }),
	];

	it("filters to one param size (case-insensitive)", () => {
		const result = tagsForParamSize(tags, "4B");
		expect(result.map((t) => t.name)).toEqual(["gemma3:4b", "gemma3:4b-q8_0"]);
	});

	it("returns all tags when paramSize is empty", () => {
		expect(tagsForParamSize(tags, "")).toHaveLength(3);
		expect(tagsForParamSize(tags, undefined)).toHaveLength(3);
	});

	it("falls back to all tags when nothing matches the size", () => {
		expect(tagsForParamSize(tags, "70b")).toHaveLength(3);
	});

	it("sorts heaviest → lightest by download size", () => {
		const sized = [
			tag({ name: "m:4b-q4_K_M", parameterSize: "4b", sizeBytes: 3_300_000_000 }),
			tag({ name: "m:4b-fp16", parameterSize: "4b", sizeBytes: 8_600_000_000 }),
			tag({ name: "m:4b-q8_0", parameterSize: "4b", sizeBytes: 5_000_000_000 }),
		];
		expect(tagsForParamSize(sized, "4b").map((t) => t.name)).toEqual([
			"m:4b-fp16",
			"m:4b-q8_0",
			"m:4b-q4_K_M",
		]);
	});

	it("drops cloud variants (not locally pullable)", () => {
		const withCloud = [
			tag({ name: "gemma3:4b", parameterSize: "4b", quantization: "Q4_K_M" }),
			tag({ name: "gemma3:4b-cloud", parameterSize: "4b" }),
			tag({ name: "gemma3:4b-it-q8_0", parameterSize: "4b", quantization: "Q8_0" }),
		];
		expect(tagsForParamSize(withCloud, "4b").map((t) => t.name)).toEqual([
			"gemma3:4b",
			"gemma3:4b-it-q8_0",
		]);
		// Cloud is also excluded when no param filter is applied.
		expect(tagsForParamSize(withCloud, "").map((t) => t.name)).toEqual([
			"gemma3:4b",
			"gemma3:4b-it-q8_0",
		]);
	});
});

describe("quantBadgeLabel", () => {
	it("prefers the parsed quantization", () => {
		expect(quantBadgeLabel(tag({ name: "x:4b-q8_0", quantization: "Q8_0" }))).toBe("Q8_0");
	});

	it("labels qat tags QAT instead of collapsing them to default", () => {
		expect(quantBadgeLabel(tag({ name: "gemma3:4b-it-qat" }))).toBe("QAT");
		// A parsed quantization still wins over the qat heuristic.
		expect(quantBadgeLabel(tag({ name: "x:4b-it-qat", quantization: "Q8_0" }))).toBe("Q8_0");
	});

	it("falls back to latest then default", () => {
		expect(quantBadgeLabel(tag({ name: "x", isLatest: true }))).toBe("latest");
		expect(quantBadgeLabel(tag({ name: "x" }))).toBe("default");
	});
});

describe("canonicalOllamaTag / isSameOllamaTag / isTagInstalled", () => {
	it("canonicalizes a bare name to its :latest form", () => {
		expect(canonicalOllamaTag("tinyllama")).toBe("tinyllama:latest");
		expect(canonicalOllamaTag("gemma3:4b")).toBe("gemma3:4b");
		expect(canonicalOllamaTag("  tinyllama  ")).toBe("tinyllama:latest");
	});

	it("treats bare ≡ :latest as the same model for selection", () => {
		expect(isSameOllamaTag("tinyllama", "tinyllama:latest")).toBe(true);
		expect(isSameOllamaTag("tinyllama:latest", "tinyllama")).toBe(true);
		expect(isSameOllamaTag("gemma3:4b", "gemma3:4b")).toBe(true);
		expect(isSameOllamaTag("gemma3:1b", "gemma3:4b")).toBe(false);
		expect(isSameOllamaTag(undefined, "tinyllama")).toBe(false);
	});

	it("matches a downloaded default whose on-disk name carries :latest", () => {
		// `ollama pull tinyllama` lands as `tinyllama:latest` — the bug was the
		// bare "tinyllama" badge reading as not-installed.
		const installed = new Set(["tinyllama:latest", "gemma3:4b"]);
		expect(isTagInstalled(installed, "tinyllama")).toBe(true);
		expect(isTagInstalled(installed, "tinyllama:latest")).toBe(true);
		expect(isTagInstalled(installed, "gemma3:4b")).toBe(true);
		expect(isTagInstalled(installed, "gemma3:1b")).toBe(false);
	});
});

describe("quantBadgeCacheState", () => {
	it("installed wins, then paused, then not-cached", () => {
		expect(quantBadgeCacheState({ installed: true, paused: false })).toBe("cached");
		expect(quantBadgeCacheState({ installed: true, paused: true })).toBe("cached");
		expect(quantBadgeCacheState({ installed: false, paused: true })).toBe("partial");
		expect(quantBadgeCacheState({ installed: false, paused: false })).toBe("not_cached");
	});
});
