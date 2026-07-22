import { describe, expect, it } from "bun:test";
import type { OllamaModel } from "@/shared/api/models";
import {
	formatOllamaDisplayName,
	formatOllamaDisplayNameParts,
	getOllamaFamily,
	getOllamaPublisher,
	getOllamaPublisherBySlug,
	groupOllamaModelsByPublisher,
	resolveOllamaParameterSize,
	resolveOllamaQuantization,
} from "./family-helpers";

function model(name: string, family?: string): OllamaModel {
	const base: OllamaModel = { name, size: 0, modifiedAt: "" };
	return family ? { ...base, details: { family } } : base;
}

describe("formatOllamaDisplayName", () => {
	it("beautifies a base+param tag", () => {
		expect(formatOllamaDisplayName("gemma3:4b")).toBe("Gemma 3");
	});

	it("preserves fractional version numbers", () => {
		expect(formatOllamaDisplayName("llama3.2:1b")).toBe("Llama 3.2");
	});

	it("keeps multi-cap brand spellings (TinyLlama)", () => {
		expect(formatOllamaDisplayName("tinyllama")).toBe("TinyLlama");
	});

	it("keeps multi-cap brand spellings (SmolLM 2)", () => {
		expect(formatOllamaDisplayName("smollm2:135m")).toBe("SmolLM 2");
	});

	it("strips quantization suffixes (Q8_0)", () => {
		expect(formatOllamaDisplayName("gemma3:4b-it-q8_0")).toBe("Gemma 3 IT");
	});

	it("keeps meaningful variant tokens (Mini)", () => {
		expect(formatOllamaDisplayName("phi3:mini")).toBe("Phi 3 Mini");
	});

	it("drops the fp16 quant marker", () => {
		expect(formatOllamaDisplayName("llama3.2:3b-fp16")).toBe("Llama 3.2");
	});

	it("formats the namespaced Bonsai Q1_0 reference as a catalogue name", () => {
		const reference = "hf.co/prism-ml/Bonsai-27B-gguf:Q1_0";
		expect(formatOllamaDisplayName(reference)).toBe("Bonsai 27B");
		expect(formatOllamaDisplayNameParts(reference)).toMatchObject({
			main: "Bonsai 27B",
			parameterSize: "27B",
			quantization: "Q1_0",
		});
	});

	it("returns an empty string for empty input", () => {
		expect(formatOllamaDisplayName("")).toBe("");
	});
});

describe("installed Ollama metadata", () => {
	it("normalizes a parameter count recovered from a lowercase model tag", () => {
		expect(resolveOllamaParameterSize(model("qwen3.5:4b"))).toBe("4B");
	});

	it("recovers Bonsai metadata when Ollama describes its drafter", () => {
		const bonsai: OllamaModel = {
			name: "hf.co/prism-ml/Bonsai-27B-gguf:Q1_0",
			size: 4_432_699_840,
			modifiedAt: "",
			details: {
				family: "dspark",
				parameterSize: "3.65B",
				quantizationLevel: "unknown",
			},
		};
		expect(resolveOllamaQuantization(bonsai)).toBe("Q1_0");
		expect(resolveOllamaParameterSize(bonsai)).toBe("27B");
	});

	it("keeps a real structured quantization ahead of the tag fallback", () => {
		const tagged: OllamaModel = {
			name: "example:7b-q4_k_m",
			size: 0,
			modifiedAt: "",
			details: { quantizationLevel: "Q5_K_M" },
		};
		expect(resolveOllamaQuantization(tagged)).toBe("Q5_K_M");
	});
});

describe("getOllamaPublisher", () => {
	it("maps gemma family to Google", () => {
		expect(getOllamaPublisher("gemma").label).toBe("Google");
	});

	it("maps llama family to Meta", () => {
		expect(getOllamaPublisher("llama").slug).toBe("meta-llama");
	});

	it("maps qwen family to Alibaba", () => {
		expect(getOllamaPublisher("qwen").label).toBe("Alibaba");
	});

	it("keeps an installed Hugging Face Bonsai pull under PrismML", () => {
		const bonsai = model("hf.co/prism-ml/Bonsai-27B-gguf:Q1_0", "dspark");
		expect(getOllamaFamily(bonsai)).toBe("bonsai");
		expect(getOllamaPublisher(getOllamaFamily(bonsai))).toEqual({
			slug: "prismml",
			label: "PrismML",
		});
	});

	it("falls back to Community for unknown families", () => {
		expect(getOllamaPublisher("not-a-real-family").label).toBe("Community");
	});
});

describe("getOllamaPublisherBySlug", () => {
	it("recovers the publisher record from its slug", () => {
		expect(getOllamaPublisherBySlug("google").label).toBe("Google");
		expect(getOllamaPublisherBySlug("meta-llama").label).toBe("Meta");
		expect(getOllamaPublisherBySlug("microsoft").label).toBe("Microsoft");
	});

	it("fabricates a fallback label for unknown slugs", () => {
		expect(getOllamaPublisherBySlug("zaphod").label).toBe("Zaphod");
	});
});

describe("groupOllamaModelsByPublisher", () => {
	it("collapses two families with the same publisher into one group", () => {
		const models = [
			model("gemma3:4b", "gemma"),
			model("codegemma:7b", "codegemma"),
			model("llama3.2:1b", "llama"),
		];
		const groups = groupOllamaModelsByPublisher(models);
		const groupMap = new Map(groups);
		expect(groupMap.get("google")?.length).toBe(2);
		expect(groupMap.get("meta-llama")?.length).toBe(1);
	});

	it("sorts groups alphabetically by publisher label", () => {
		const models = [
			model("phi3:mini", "phi"),
			model("gemma3:4b", "gemma"),
			model("llama3.2:1b", "llama"),
		];
		const labels = groupOllamaModelsByPublisher(models).map(
			([slug]) => getOllamaPublisherBySlug(slug).label,
		);
		expect(labels).toEqual(["Google", "Meta", "Microsoft"]);
	});

	it("falls back to Community for unrecognised families", () => {
		const models = [model("mystery:1b", "mystery")];
		const groups = groupOllamaModelsByPublisher(models);
		expect(groups[0]?.[0]).toBe("community");
		expect(getOllamaPublisherBySlug(groups[0]?.[0] ?? "").label).toBe(
			"Community",
		);
	});
});
