import type { RecommendedOllamaModel } from "@/shared/api/models";

const GB = 1_000_000_000;

/**
 * Curated local LLMs suggested for post-processing dictated text (grammar /
 * tone / rewrite / transform) via Ollama. Picked for STRONG instruction-following
 * at SMALL sizes that run at good speeds on consumer hardware — every entry is
 * ≤ 9B params and its default (≈ q4) download stays well under a 16 GB RAM budget,
 * so even the largest runs comfortably on a 16 GB machine (and the picker's
 * "won't fit" chip warns per-device). Ordered smallest → largest.
 *
 * EVERY entry is the LATEST generation of its family available on
 * `ollama.com/library`, verified live (2026-05). Superseded versions were removed
 * outright: gemma3 → **gemma4**, qwen3/qwen2.5 → **qwen3.5** (qwen3.6 is large-only,
 * no small sizes), granite3.x → **granite4.1**, tinyllama dropped. Notes:
 *   - Llama 4 is MoE-only (Scout 67 GB+), so **llama3.2** remains the latest SMALL
 *     Llama — kept, not outdated.
 *   - SmolLM3 has no official library entry (404), so **smollm2** is the latest
 *     SmolLM on Ollama.
 *   - gemma4's smallest is the efficient `e2b` (MatFormer; ~2B effective, heavier
 *     download) — there is no tiny gemma4, so the tiny tier leans on qwen3.5 / smollm2.
 *   - Reasoning/"thinking" models are excluded (a `<think>` preamble is pure
 *     latency for short rewrites).
 *
 * Users can still browse the full library in the picker for anything not curated
 * here (e.g. gemma4:e4b, qwen3.5:27b, command-a — bigger but heavier/slower).
 */
export const RECOMMENDED_OLLAMA_MODELS: readonly RecommendedOllamaModel[] = [
	{
		name: "smollm2:135m",
		displayName: "SmolLM 2 135M",
		family: "smollm",
		paramSize: "135M",
		sizeBytes: Math.round(0.27 * GB),
		description: "Hugging Face SmolLM 2, 135M parameters. The smallest viable choice.",
		tags: ["fast", "tiny"],
	},
	{
		name: "smollm2:360m",
		displayName: "SmolLM 2 360M",
		family: "smollm",
		paramSize: "360M",
		sizeBytes: Math.round(0.73 * GB),
		description: "Hugging Face SmolLM 2 360M. Tiny footprint with passable instruction following.",
		tags: ["fast", "tiny"],
	},
	{
		name: "qwen3.5:0.8b",
		displayName: "Qwen 3.5 0.8B",
		family: "qwen",
		paramSize: "0.8B",
		sizeBytes: Math.round(1.0 * GB),
		description:
			"Alibaba Qwen 3.5, ultra-tiny. The newest small Qwen — strong instruction-following and multilingual for its size.",
		tags: ["fast", "tiny", "instruct"],
	},
	{
		name: "llama3.2:1b",
		displayName: "Llama 3.2 1B",
		family: "llama",
		paramSize: "1.2B",
		sizeBytes: Math.round(1.3 * GB),
		description:
			"Meta Llama 3.2 1B instruct — the latest small Llama (Llama 4 is large MoE-only). Low VRAM, safe default.",
		tags: ["fast", "tiny", "instruct"],
	},
	{
		name: "llama3.2:3b",
		displayName: "Llama 3.2 3B",
		family: "llama",
		paramSize: "3B",
		sizeBytes: Math.round(2.0 * GB),
		description:
			"Meta Llama 3.2 3B instruct. Solid, widely-used general-purpose pick that runs well on consumer GPUs.",
		tags: ["fast", "instruct"],
	},
	{
		name: "granite4.1:3b",
		displayName: "Granite 4.1 3B",
		family: "granite",
		paramSize: "3B",
		sizeBytes: Math.round(2.1 * GB),
		description:
			"IBM Granite 4.1 3B, tuned for instruction-following and summarization — ideal for clean rewrites at low VRAM.",
		tags: ["fast", "instruct", "recommended"],
	},
	{
		name: "phi4-mini:3.8b",
		displayName: "Phi-4 Mini",
		family: "phi",
		paramSize: "3.8B",
		sizeBytes: Math.round(2.5 * GB),
		description:
			"Microsoft Phi-4 Mini. Strong instruction-following and function calling; beats Llama 3.2 3B across benchmarks.",
		tags: ["instruct", "recommended"],
	},
	{
		name: "ministral-3:3b",
		displayName: "Ministral 3 3B",
		family: "mistral",
		paramSize: "3B",
		sizeBytes: Math.round(3.0 * GB),
		description:
			"Mistral AI Ministral 3 (3B instruct). Crisp, efficient edge model with good instruction-following.",
		tags: ["instruct"],
	},
	{
		name: "qwen3.5:4b",
		displayName: "Qwen 3.5 4B",
		family: "qwen",
		paramSize: "4B",
		sizeBytes: Math.round(3.4 * GB),
		description:
			"Alibaba Qwen 3.5 4B. Best-in-class small all-rounder for instruction-following — rivals far larger models.",
		tags: ["instruct", "recommended"],
	},
	{
		name: "command-r7b:7b",
		displayName: "Command R7B",
		family: "command",
		paramSize: "7B",
		sizeBytes: Math.round(5.1 * GB),
		description:
			"Cohere Command R7B. Tuned for instruction-following, multilingual text and RAG; needs a GPU or 16 GB RAM.",
		tags: ["instruct"],
	},
	{
		name: "granite4.1:8b",
		displayName: "Granite 4.1 8B",
		family: "granite",
		paramSize: "8B",
		sizeBytes: Math.round(5.3 * GB),
		description:
			"IBM Granite 4.1 8B. Enterprise-grade instruction-following and summarization; best on a GPU or 16 GB RAM.",
		tags: ["instruct"],
	},
	{
		name: "qwen3.5:9b",
		displayName: "Qwen 3.5 9B",
		family: "qwen",
		paramSize: "9B",
		sizeBytes: Math.round(6.6 * GB),
		description:
			"Alibaba Qwen 3.5 9B. The highest quality that still runs comfortably in 16 GB RAM.",
		tags: ["instruct", "recommended"],
	},
	{
		name: "gemma4:e2b",
		displayName: "Gemma 4 E2B",
		family: "gemma",
		paramSize: "E2B",
		sizeBytes: Math.round(7.2 * GB),
		description:
			"Google Gemma 4 (E2B, efficient MatFormer ≈ 2B active). The latest Gemma — strong multilingual quality; heavier download, best on a GPU.",
		tags: ["instruct"],
	},
];

export function findRecommendedModel(name: string): RecommendedOllamaModel | undefined {
	return RECOMMENDED_OLLAMA_MODELS.find((m) => m.name === name);
}
