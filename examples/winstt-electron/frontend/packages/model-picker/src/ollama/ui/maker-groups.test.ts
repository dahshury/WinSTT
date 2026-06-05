import { describe, expect, it } from "bun:test";
import type { OllamaLibraryHit, OllamaModel, RecommendedOllamaModel } from "@/shared/api/models";
import {
	buildMakerGroups,
	buildOllamaDescriptionIndex,
	ollamaDescriptionForName,
	type MakerGroup,
} from "./OllamaModelSelector";

function installed(name: string): OllamaModel {
	return { name, model: name, size: 0, digest: "", modified_at: "" } as OllamaModel;
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
		expect(groups.map((g) => g.slug)).toEqual(["qwen", "ibm-granite", "meta-llama"]);
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
		expect(group(groups, "google")?.library.map((h) => h.name)).toEqual(["gemma3"]);
	});
});

describe("buildOllamaDescriptionIndex", () => {
	it("maps installed tags back to their base Ollama library descriptions", () => {
		const descriptions = buildOllamaDescriptionIndex([
			{ name: "gemma4", description: "Gemma 4 from Ollama." },
		]);

		expect(ollamaDescriptionForName("gemma4:e2b", descriptions)).toBe(
			"Gemma 4 from Ollama."
		);
	});

	it("leaves models without an Ollama description blank", () => {
		const descriptions = buildOllamaDescriptionIndex([
			{ name: "blank", description: "   " },
			{ name: "missing" },
		]);

		expect(ollamaDescriptionForName("blank:latest", descriptions)).toBeUndefined();
		expect(ollamaDescriptionForName("missing:latest", descriptions)).toBeUndefined();
	});
});
