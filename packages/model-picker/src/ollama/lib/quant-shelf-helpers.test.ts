import { describe, expect, it } from "bun:test";
import type { OllamaLibraryTag } from "@/shared/api/models";
import {
	canonicalOllamaTag,
	dedupeInstalledOllamaModels,
	findInstalledOllamaTag,
	isModelSizeInstalled,
	isSameOllamaTag,
	isTagInstalled,
	libraryBaseSlug,
	ollamaTagIdentityKey,
	paramSizeFromName,
	pruneToShownQuants,
	quantBadgeCacheState,
	quantBadgeLabel,
	tagsForParamSize,
} from "./quant-shelf-helpers";

function tag(
	partial: Partial<OllamaLibraryTag> & { name: string },
): OllamaLibraryTag {
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
	it("keeps only the explicit canonical ladder; the bare default is the card-body auto pick, not a badge", () => {
		const tags = [
			tag({ name: "qwen3.5:4b" }), // bare default → now card-body "auto", NOT a shelf badge
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
			"qwen3.5:4b-q4_K_M",
			"qwen3.5:4b-q5_K_M",
			"qwen3.5:4b-q8_0",
			"qwen3.5:4b-fp16",
		]);
	});

	it("still keeps a bare default the user already has on disk / is pulling (forceKeep)", () => {
		const tags = [
			tag({ name: "qwen3.5:4b" }),
			tag({ name: "qwen3.5:4b-q8_0", quantization: "Q8_0" }),
		];
		const keep = (n: string) => n === "qwen3.5:4b";
		expect(pruneToShownQuants(tags, keep).map((t) => t.name)).toEqual([
			"qwen3.5:4b",
			"qwen3.5:4b-q8_0",
		]);
	});

	it("always keeps a tag the user has on disk / is downloading, even if dominated", () => {
		const tags = [tag({ name: "m:4b-q4_0" }), tag({ name: "m:4b-mlx" })];
		const keep = (n: string) => n === "m:4b-q4_0";
		expect(pruneToShownQuants(tags, keep).map((t) => t.name)).toEqual([
			"m:4b-q4_0",
		]);
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
			tag({
				name: "m:4b-q4_K_M",
				parameterSize: "4b",
				sizeBytes: 3_300_000_000,
			}),
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
			tag({
				name: "gemma3:4b-it-q8_0",
				parameterSize: "4b",
				quantization: "Q8_0",
			}),
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
		expect(
			quantBadgeLabel(tag({ name: "x:4b-q8_0", quantization: "Q8_0" })),
		).toBe("Q8_0");
	});

	it("labels qat tags QAT instead of collapsing them to default", () => {
		expect(quantBadgeLabel(tag({ name: "gemma3:4b-it-qat" }))).toBe("QAT");
		// A parsed quantization still wins over the qat heuristic.
		expect(
			quantBadgeLabel(tag({ name: "x:4b-it-qat", quantization: "Q8_0" })),
		).toBe("Q8_0");
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

	it("treats same-artifact generic defaults as their explicit instruction-tuned tags", () => {
		expect(ollamaTagIdentityKey("smollm2:135m")).toBe(
			"smollm2:135m-instruct-fp16",
		);
		expect(isSameOllamaTag("smollm2:360m", "smollm2:360m-instruct-fp16")).toBe(
			true,
		);
		expect(isSameOllamaTag("llama3.2:1b", "llama3.2:1b-instruct-q8_0")).toBe(
			true,
		);
		expect(
			isSameOllamaTag("ministral-3:3b", "ministral-3:3b-instruct-2512-q4_K_M"),
		).toBe(true);
		expect(ollamaTagIdentityKey("gemma4:e2b")).toBe("gemma4:e2b-it-q4_k_m");
		expect(isSameOllamaTag("gemma4:e2b", "gemma4:e2b-it-q4_K_M")).toBe(true);
		expect(isSameOllamaTag("gemma4:e4b", "gemma4:e4b-it-q4_K_M")).toBe(true);
		expect(isSameOllamaTag("gemma4:12b", "gemma4:12b-it-q4_K_M")).toBe(true);
		expect(isSameOllamaTag("gemma4:e4b", "gemma4:12b-it-q4_K_M")).toBe(false);
		expect(isSameOllamaTag("llama3.2:1b", "llama3.2:1b-instruct-q4_K_M")).toBe(
			false,
		);

		const installed = new Set(["gemma4:e4b"]);
		expect(isTagInstalled(installed, "gemma4:e4b-it-q4_K_M")).toBe(true);
		expect(findInstalledOllamaTag(installed, "gemma4:e4b-it-q4_K_M")).toBe(
			"gemma4:e4b",
		);
	});
});

describe("isModelSizeInstalled", () => {
	it("matches any quant or instruction-tuned variant of the same size", () => {
		// The duplicate bug: recommended `gemma4:e2b` showed next to an installed
		// `gemma4:e2b-it-q8_0` because the alias table only maps the q4_K_M default.
		// Size-level coverage hides the recommended card for ANY e2b variant.
		expect(
			isModelSizeInstalled(new Set(["gemma4:e2b-it-q8_0"]), "gemma4:e2b"),
		).toBe(true);
		expect(
			isModelSizeInstalled(new Set(["gemma4:e2b-it-q4_K_M"]), "gemma4:e2b"),
		).toBe(true);
		expect(isModelSizeInstalled(new Set(["gemma4:e2b"]), "gemma4:e2b")).toBe(
			true,
		);
	});

	it("does not collapse a different size of the same family", () => {
		expect(
			isModelSizeInstalled(new Set(["gemma4:e4b-it-q4_K_M"]), "gemma4:e2b"),
		).toBe(false);
		expect(isModelSizeInstalled(new Set(["gemma4:12b"]), "gemma4:e2b")).toBe(
			false,
		);
	});

	it("does not collapse a same-size tag from a different family", () => {
		expect(isModelSizeInstalled(new Set(["qwen3.5:4b"]), "granite4.1:4b")).toBe(
			false,
		);
	});

	it("ignores a param token in the base name, not the variant", () => {
		// `command-r7b` carries `7b` in its BASE slug; only the post-colon variant
		// is the param size, so this must not false-match on the base's digits.
		expect(
			isModelSizeInstalled(
				new Set(["command-r7b:7b-q4_K_M"]),
				"command-r7b:7b",
			),
		).toBe(true);
	});

	it("covers a bare-base tag with any installed sibling of that family", () => {
		expect(
			isModelSizeInstalled(new Set(["tinyllama:latest"]), "tinyllama"),
		).toBe(true);
		expect(isModelSizeInstalled(new Set(["qwen3.5:4b"]), "tinyllama")).toBe(
			false,
		);
	});
});

describe("quantBadgeCacheState", () => {
	it("installed wins, then paused, then not-cached", () => {
		expect(quantBadgeCacheState({ installed: true, paused: false })).toBe(
			"cached",
		);
		expect(quantBadgeCacheState({ installed: true, paused: true })).toBe(
			"cached",
		);
		expect(quantBadgeCacheState({ installed: false, paused: true })).toBe(
			"partial",
		);
		expect(quantBadgeCacheState({ installed: false, paused: false })).toBe(
			"not_cached",
		);
	});
});

describe("dedupeInstalledOllamaModels", () => {
	it("collapses same-digest alias tags into one row, preferring the bare tag", () => {
		const models = [
			{ name: "gemma4:e2b-it-q4_K_M" },
			{ name: "gemma4:e2b" },
			{ name: "lfm2.5-thinking:1.2b-q8_0" },
		];
		const out = dedupeInstalledOllamaModels(models);
		expect(out.map((m) => m.name)).toEqual([
			// shorter name wins for the collapsed pair; first-seen position kept
			"gemma4:e2b",
			"lfm2.5-thinking:1.2b-q8_0",
		]);
	});

	it("keeps the currently-selected tag as the surviving representative", () => {
		const models = [{ name: "gemma4:e2b-it-q4_K_M" }, { name: "gemma4:e2b" }];
		const out = dedupeInstalledOllamaModels(models, "gemma4:e2b-it-q4_K_M");
		expect(out.map((m) => m.name)).toEqual(["gemma4:e2b-it-q4_K_M"]);
	});

	it("leaves genuinely distinct models untouched", () => {
		const models = [
			{ name: "gemma4:e2b" },
			{ name: "gemma4:e4b" },
			{ name: "llama3.2:1b" },
		];
		const out = dedupeInstalledOllamaModels(models);
		expect(out.map((m) => m.name)).toEqual([
			"gemma4:e2b",
			"gemma4:e4b",
			"llama3.2:1b",
		]);
	});
});
