import { describe, expect, it } from "bun:test";
import type {
	OllamaLibraryHit,
	OllamaModel,
	OllamaPullProgress,
	RecommendedOllamaModel,
} from "@/shared/api/models";
import {
	activePullNameForRow,
	buildOllamaDescriptionIndex,
	installedDescriptionForModel,
	ollamaDescriptionForName,
	ollamaPullMatchesRow,
	singleActivePullName,
	supportsOllamaToolCalling,
	typedModelQueryInfo,
} from "../lib/ollama-description-helpers";
import {
	buildMakerGroups,
	computeRecommendedVisible,
	isCatalogBackedModel,
	type MakerGroup,
} from "../lib/maker-groups";

function installed(name: string): OllamaModel {
	return {
		name,
		model: name,
		size: 0,
		digest: "",
		modified_at: "",
	} as OllamaModel;
}
function pull(model: string, percent: number): OllamaPullProgress {
	return {
		model,
		percent,
		status: "pulling",
	};
}
function recommended(name: string, family: string): RecommendedOllamaModel {
	return {
		name,
		family,
		displayName: name,
		paramSize: "4B",
		sizeBytes: 1,
		description: "",
		tags: ["instruct"],
	};
}
function hit(name: string): OllamaLibraryHit {
	return { name };
}

function group(groups: MakerGroup[], slug: string): MakerGroup | undefined {
	return groups.find((g) => g.slug === slug);
}

describe("buildMakerGroups", () => {
	it("puts a recommended model under its maker next to an installed sibling", () => {
		// The user's exact complaint: installed gemma3 under Google, but gemma4
		// (recommended) was in a separate maker-less section. Now both are Google.
		const groups = buildMakerGroups({
			installed: [installed("gemma3:4b")],
			recommended: [recommended("gemma4:e2b", "gemma")],
			library: [],
		});
		const google = group(groups, "google");
		expect(google).toBeDefined();
		expect(google?.installed.map((m) => m.name)).toEqual(["gemma3:4b"]);
		expect(google?.recommended.map((m) => m.name)).toEqual(["gemma4:e2b"]);
		// No maker-less "recommended"/"community" bucket swallowing it.
		expect(group(groups, "community")).toBeUndefined();
	});

	it("groups distinct makers separately, sorted by label", () => {
		const groups = buildMakerGroups({
			installed: [installed("qwen3.5:4b"), installed("llama3.2:3b")],
			recommended: [recommended("granite4.1:3b", "granite")],
			library: [],
		});
		// Sorted by maker LABEL: Alibaba (qwen), IBM (ibm-granite), Meta (meta-llama).
		expect(groups.map((g) => g.slug)).toEqual([
			"qwen",
			"ibm-granite",
			"meta-llama",
		]);
	});

	it("merges library hits into maker groups only when provided (search), deduped vs installed/recommended base slugs", () => {
		const groups = buildMakerGroups({
			installed: [installed("gemma3:4b")],
			recommended: [recommended("gemma4:e2b", "gemma")],
			// "gemma3" base is already shown (installed) → dropped; "gemma2" is new.
			library: [hit("gemma3"), hit("gemma2")],
		});
		const google = group(groups, "google");
		expect(google?.library.map((h) => h.name)).toEqual(["gemma2"]);
	});

	it("omits a group that ends up empty after library dedup", () => {
		const groups = buildMakerGroups({
			installed: [],
			recommended: [],
			library: [hit("gemma3")],
		});
		// gemma3 is the only Google entry and isn't deduped here (nothing covers
		// it), so Google exists with one library hit.
		expect(group(groups, "google")?.library.map((h) => h.name)).toEqual([
			"gemma3",
		]);
	});
});

describe("computeRecommendedVisible", () => {
	const gemmaE2b = recommended("gemma4:e2b", "gemma");

	it("hides a recommended card once any quant of its size is installed", () => {
		// The reported duplicate: installed `gemma4:e2b-it-q8_0` (an IT card with a
		// trash icon) showing next to the recommended `gemma4:e2b` card.
		const visible = computeRecommendedVisible(
			[gemmaE2b],
			new Set(["gemma4:e2b-it-q8_0"]),
			"",
		);
		expect(visible).toEqual([]);
	});

	it("keeps a recommended card when only a different size is installed", () => {
		const visible = computeRecommendedVisible(
			[gemmaE2b],
			new Set(["gemma4:e4b-it-q4_K_M"]),
			"",
		);
		expect(visible.map((m) => m.name)).toEqual(["gemma4:e2b"]);
	});

	it("still applies the search query after the install filter", () => {
		expect(computeRecommendedVisible([gemmaE2b], new Set(), "qwen")).toEqual(
			[],
		);
		expect(
			computeRecommendedVisible([gemmaE2b], new Set(), "gemma").map(
				(m) => m.name,
			),
		).toEqual(["gemma4:e2b"]);
	});

	it("fuzzy-matches typo'd version queries", () => {
		const parakeet = recommended("parakeet-v3:latest", "parakeet");
		const visible = computeRecommendedVisible(
			[
				{
					...parakeet,
					displayName: "Parakeet version 3",
					description: "NVIDIA Parakeet version 3 speech model",
				},
			],
			new Set(),
			"Parkeet v3",
		);

		expect(visible.map((m) => m.name)).toEqual(["parakeet-v3:latest"]);
	});
});

describe("isCatalogBackedModel", () => {
	// The curated set ships a `gemma4:e2b` entry; `qwen3.5:4b` stands in for any
	// other catalog model.
	const catalog = new Set(["gemma4:e2b", "qwen3.5:4b"]);

	it("treats any quant/IT variant of a curated size as catalog-backed", () => {
		// Catalog models must keep their card forever → no whole-card delete.
		expect(isCatalogBackedModel(catalog, "gemma4:e2b")).toBe(true);
		expect(isCatalogBackedModel(catalog, "gemma4:e2b-it-q8_0")).toBe(true);
		expect(isCatalogBackedModel(catalog, "qwen3.5:4b-instruct-q4_K_M")).toBe(
			true,
		);
	});

	it("treats an ad-hoc pulled model as NOT catalog-backed (keeps card delete)", () => {
		// A different size of a curated family, and an entirely uncurated model.
		expect(isCatalogBackedModel(catalog, "gemma4:e4b-it-q4_K_M")).toBe(false);
		expect(isCatalogBackedModel(catalog, "mistral-nemo:12b")).toBe(false);
		expect(isCatalogBackedModel(catalog, "deepseek-r1:7b")).toBe(false);
	});

	it("is false when no catalog is supplied (installed-only mode)", () => {
		expect(isCatalogBackedModel(new Set(), "gemma4:e2b")).toBe(false);
	});
});

describe("buildOllamaDescriptionIndex", () => {
	it("maps installed tags back to their base Ollama library descriptions", () => {
		const descriptions = buildOllamaDescriptionIndex([
			{ name: "gemma4", description: "Gemma 4 from Ollama." },
		]);

		expect(ollamaDescriptionForName("gemma4:e2b", descriptions)).toBe(
			"Gemma 4 from Ollama.",
		);
	});

	it("leaves models without an Ollama description blank", () => {
		const descriptions = buildOllamaDescriptionIndex([
			{ name: "blank", description: "   " },
			{ name: "missing" },
		]);

		expect(
			ollamaDescriptionForName("blank:latest", descriptions),
		).toBeUndefined();
		expect(
			ollamaDescriptionForName("missing:latest", descriptions),
		).toBeUndefined();
	});

	it("falls back to local Ollama metadata for models missing from the library catalog", () => {
		const model = {
			name: "acme/custom-cleanup:latest",
			size: 4_000_000_000,
			modifiedAt: "2026-06-05T00:00:00Z",
			details: {
				format: "gguf",
				family: "llama",
				families: ["llama"],
				parameterSize: "7B",
				quantizationLevel: "Q5_K_M",
			},
			capabilities: ["completion", "vision", "tools"],
			contextLength: 8192,
		} as OllamaModel;

		expect(installedDescriptionForModel(model, new Map())).toBe(
			"Local Ollama model: GGUF / llama family / Q5_K_M / 8K context / Vision, Tools",
		);
	});

	it("prefers a scraped library description when one exists", () => {
		const descriptions = buildOllamaDescriptionIndex([
			{ name: "gemma4", description: "Official Gemma description." },
		]);
		const model = {
			name: "gemma4:e2b",
			details: { format: "gguf" },
			capabilities: ["vision"],
		} as OllamaModel;

		expect(installedDescriptionForModel(model, descriptions)).toBe(
			"Official Gemma description.",
		);
	});
});

describe("supportsOllamaToolCalling", () => {
	it("detects Ollama's tools capability case-insensitively", () => {
		expect(supportsOllamaToolCalling(["completion", "TOOLS"])).toBe(true);
		expect(supportsOllamaToolCalling(["completion", "vision"])).toBe(false);
		expect(supportsOllamaToolCalling(null)).toBe(false);
	});
});

describe("typedModelQueryInfo", () => {
	it("parses a typed exact tag into a library base and param size", () => {
		expect(typedModelQueryInfo("  Gemma3:4b-q4_K_M  ")).toEqual({
			baseSlug: "gemma3",
			modelName: "Gemma3:4b-q4_K_M",
			paramSize: "4b",
		});
	});

	it("does not treat a bare model name as an exact tag", () => {
		expect(typedModelQueryInfo("qwen3")).toBeNull();
	});

	it("rejects empty and invalid search strings", () => {
		expect(typedModelQueryInfo("   ")).toBeNull();
		expect(typedModelQueryInfo("gemma3:")).toBeNull();
		expect(typedModelQueryInfo("gemma3 4b")).toBeNull();
	});
});

describe("active Ollama pull focus helpers", () => {
	it("returns the active pull only when exactly one model is downloading", () => {
		expect(
			singleActivePullName({
				"gemma3:4b-q4_K_M": pull("gemma3:4b-q4_K_M", 12),
			}),
		).toBe("gemma3:4b-q4_K_M");
		expect(
			singleActivePullName({
				"gemma3:4b-q4_K_M": pull("gemma3:4b-q4_K_M", 12),
				"qwen3:4b-q4_K_M": pull("qwen3:4b-q4_K_M", 30),
			}),
		).toBeNull();
		expect(singleActivePullName({})).toBeNull();
	});

	it("matches an active quant pull to the row with the same parameter size", () => {
		expect(ollamaPullMatchesRow("gemma3:4b-q4_K_M", "gemma3:4b", "4B")).toBe(
			true,
		);
		expect(ollamaPullMatchesRow("gemma3:27b-q4_K_M", "gemma3:4b", "4B")).toBe(
			false,
		);
		expect(ollamaPullMatchesRow("gemma3:27b-q4_K_M", "gemma3")).toBe(true);
	});

	it("finds the pull that should highlight and scroll a row", () => {
		const pulls = {
			"gemma3:27b-q4_K_M": pull("gemma3:27b-q4_K_M", 20),
			"gemma3:4b-q8_0": pull("gemma3:4b-q8_0", 80),
		};

		expect(activePullNameForRow(pulls, "gemma3:4b", "4B")).toBe(
			"gemma3:4b-q8_0",
		);
	});
});
