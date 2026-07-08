import type { RecommendedOllamaModel } from "@/shared/api/models";

const GB = 1_000_000_000;

/**
 * Curated local LLMs suggested for post-processing dictated text (grammar /
 * tone / rewrite / transform) via Ollama. Picked for STRONG instruction-following
 * at SMALL sizes that run at good speeds on consumer hardware. Defaults are
 * compact Q4_K_M-style pulls that stay under a 16 GB RAM budget, so even the
 * largest curated local pick is viable on a 16 GB machine (and the picker's
 * "won't fit" chip warns per-device). Ordered smallest → largest.
 *
 * EVERY entry is the LATEST generation of its family available on
 * `ollama.com/library`, verified live (2026-06). Superseded versions were removed
 * outright: gemma3 → **gemma4**, qwen3/qwen2.5 → **qwen3.5** (qwen3.6 is large-only,
 * no small sizes), granite3.x → **granite4.1**, tinyllama dropped. Notes:
 *   - Llama 4 is MoE-only (Scout 67 GB+), so **llama3.2** remains the latest SMALL
 *     Llama — kept, not outdated.
 *   - SmolLM3 has no official library entry (404), so **smollm2** is the latest
 *     SmolLM on Ollama — all three library sizes (135m, 360m, 1.7b) are offered.
 *   - gemma4 is offered at the current local sizes requested from Ollama:
 *     `e2b`, `e4b`, and full `12b`.
 *   - NVIDIA: only **nemotron-3-nano:4b** is curated — the newest-gen small pick
 *     (2.8 GB, 256K ctx, thinking-toggleable). Every other Nemotron is out: the
 *     70B `nemotron`, `nemotron3` (33B multimodal), `nemotron-3-super` (120B MoE),
 *     `-ultra`, and `nemotron-cascade-2` (30B MoE, 24 GB) all blow the RAM budget,
 *     and `nemotron-mini` is a superseded 2024 4K-context distill.
 *   - Mistral: **ministral-3** is the newest small-capable line (Dec 2025, 256K
 *     ctx), offered at all three budget-fitting local sizes `3b`/`8b`/`14b`.
 *     `mistral-small3.2` (24B, 15 GB) and `magistral` (reasoning) are over budget;
 *     `mistral` (7B v0.3) and `mistral-nemo` (12B) are older gens.
 *   - OpenAI: **gpt-oss:20b** (13.8 GB, MoE ~3.6B active) is the ONE over-budget
 *     exception — a deliberate GPU-class pick for users with the VRAM. It sits
 *     last (largest) and relies on the picker's fit warning to gate it on smaller
 *     machines. The bigger `gpt-oss:120b` stays out.
 *   - Reasoning/"thinking" models are excluded by default (a `<think>` preamble
 *     is pure latency for short rewrites), except explicit requested picks.
 *
 * Users can still browse the full library in the picker for anything not curated
 * here (e.g. qwen3.5:27b, command-a — bigger but heavier/slower).
 */
export const RECOMMENDED_OLLAMA_MODELS: readonly RecommendedOllamaModel[] = [
	{
		name: "smollm2:135m",
		displayName: "SmolLM 2 135M",
		family: "smollm",
		paramSize: "135M",
		sizeBytes: Math.round(0.27 * GB),
		description:
			"Hugging Face SmolLM 2, 135M parameters. The smallest viable choice.",
		tags: ["fast", "tiny"],
	},
	{
		name: "smollm2:360m",
		displayName: "SmolLM 2 360M",
		family: "smollm",
		paramSize: "360M",
		sizeBytes: Math.round(0.73 * GB),
		description:
			"Hugging Face SmolLM 2 360M. Tiny footprint with passable instruction following.",
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
		name: "lfm2.5-thinking:1.2b",
		displayName: "LFM2.5 Thinking 1.2B",
		family: "lfm",
		paramSize: "1.2B",
		sizeBytes: Math.round(0.731 * GB),
		description:
			"Liquid AI LFM2.5 Thinking 1.2B. Compact hybrid reasoning model with a 125K context window for longer cleanup and rewrite tasks.",
		tags: ["fast", "instruct"],
		// Dedicated reasoning build: `think:false` only stops tag PARSING (the
		// `<think>` block leaks into content) — reasoning itself can't be disabled.
		thinking: "always-on",
	},
	{
		name: "smollm2:1.7b",
		displayName: "SmolLM 2 1.7B",
		family: "smollm",
		paramSize: "1.7B",
		sizeBytes: Math.round(1.8 * GB),
		description:
			"Hugging Face SmolLM 2 1.7B instruct. The largest SmolLM 2 — noticeably stronger instruction-following while still tiny.",
		tags: ["fast", "instruct"],
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
		name: "qwen3.5:2b",
		displayName: "Qwen 3.5 2B",
		family: "qwen",
		paramSize: "2B",
		sizeBytes: Math.round(2.7 * GB),
		description:
			"Alibaba Qwen 3.5 2B. Fills the gap between 0.8B and 4B — strong instruction-following per GB for low-VRAM GPUs.",
		tags: ["fast", "instruct"],
	},
	{
		name: "nemotron-3-nano:4b",
		displayName: "Nemotron 3 Nano 4B",
		family: "nemotron",
		paramSize: "4B",
		sizeBytes: Math.round(2.8 * GB),
		description:
			"NVIDIA Nemotron 3 Nano 4B, the newest generation. Unified reasoning/non-reasoning model — leave Thinking effort off for fast rewrites, with a 256K context window.",
		tags: ["instruct"],
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
		name: "ministral-3:8b",
		displayName: "Ministral 3 8B",
		family: "mistral",
		paramSize: "8B",
		sizeBytes: Math.round(6.0 * GB),
		description:
			"Mistral AI Ministral 3 8B. The mid-size edge model — noticeably stronger rewrites than the 3B while still fitting a low-VRAM GPU, with a 256K context window.",
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
		name: "ministral-3:14b",
		displayName: "Ministral 3 14B",
		family: "mistral",
		paramSize: "14B",
		sizeBytes: Math.round(9.1 * GB),
		description:
			"Mistral AI Ministral 3 14B. The largest Ministral 3 — best instruction-following quality in the family; needs a GPU or 16 GB RAM.",
		tags: ["instruct"],
	},
	{
		name: "gemma4:e2b",
		displayName: "Gemma 4 E2B",
		family: "gemma",
		paramSize: "E2B",
		sizeBytes: Math.round(7.2 * GB),
		description:
			"Google Gemma 4 E2B, the efficient edge-size variant. Strong multilingual cleanup with the smallest Gemma 4 local footprint.",
		tags: ["instruct"],
	},
	{
		name: "gemma4:e4b",
		displayName: "Gemma 4 E4B",
		family: "gemma",
		paramSize: "E4B",
		sizeBytes: Math.round(9.6 * GB),
		description:
			"Google Gemma 4 E4B, the larger edge variant. Better quality than E2B when you have more RAM or GPU headroom.",
		tags: ["instruct"],
	},
	{
		name: "gemma4:12b",
		displayName: "Gemma 4 12B",
		family: "gemma",
		paramSize: "12B",
		sizeBytes: Math.round(7.6 * GB),
		description:
			"Google Gemma 4 12B, the full local workstation model. Highest-quality curated Gemma 4 choice with a 256K context window.",
		tags: ["instruct", "recommended"],
	},
	{
		name: "gpt-oss:20b",
		displayName: "GPT-OSS 20B",
		family: "gpt",
		paramSize: "20B",
		sizeBytes: Math.round(13.8 * GB),
		description:
			"OpenAI GPT-OSS 20B, an open-weight MoE (~3.6B active) with adjustable reasoning effort and a 128K context window. The largest curated pick — GPU-class; the picker's fit warning gates it on smaller machines.",
		tags: ["instruct"],
		// Measured live: `think:false` still reasons at the DEFAULT trace length
		// (~2k chars) — only the low/medium/high strings are actually supported.
		thinking: "levels",
	},
];

export function findRecommendedModel(
	name: string,
): RecommendedOllamaModel | undefined {
	return RECOMMENDED_OLLAMA_MODELS.find((m) => m.name === name);
}
