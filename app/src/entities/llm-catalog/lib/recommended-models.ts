import type { RecommendedOllamaModel } from "@/shared/api/models";

const GB = 1_000_000_000;

export const RECOMMENDED_OLLAMA_MODELS: readonly RecommendedOllamaModel[] = [
	{
		name: "llama3.2:1b",
		displayName: "Llama 3.2 1B",
		family: "llama",
		paramSize: "1.2B",
		sizeBytes: Math.round(1.3 * GB),
		description:
			"Tiny Meta Llama 3.2 instruct model. Lowest VRAM usage; good for grammar and tone tweaks.",
		tags: ["fast", "tiny", "instruct"],
	},
	{
		name: "llama3.2:3b",
		displayName: "Llama 3.2 3B",
		family: "llama",
		paramSize: "3B",
		sizeBytes: Math.round(2.0 * GB),
		description:
			"Meta Llama 3.2 instruct model. Strong general-purpose pick that runs well on consumer GPUs.",
		tags: ["fast", "instruct", "recommended"],
	},
	{
		name: "gemma3:1b",
		displayName: "Gemma 3 1B",
		family: "gemma",
		paramSize: "1B",
		sizeBytes: Math.round(0.85 * GB),
		description: "Google Gemma 3, the smallest variant. Quick edits and rewrites with low VRAM.",
		tags: ["fast", "tiny", "instruct"],
	},
	{
		name: "gemma3:4b",
		displayName: "Gemma 3 4B",
		family: "gemma",
		paramSize: "4B",
		sizeBytes: Math.round(3.3 * GB),
		description: "Google Gemma 3 4B. Higher quality output while still fast on modern hardware.",
		tags: ["instruct", "recommended"],
	},
	{
		name: "qwen3:0.6b",
		displayName: "Qwen 3 0.6B",
		family: "qwen",
		paramSize: "0.6B",
		sizeBytes: Math.round(0.55 * GB),
		description: "Alibaba Qwen 3, ultra-tiny. Ideal for low-end devices.",
		tags: ["fast", "tiny", "instruct"],
	},
	{
		name: "qwen3:1.7b",
		displayName: "Qwen 3 1.7B",
		family: "qwen",
		paramSize: "1.7B",
		sizeBytes: Math.round(1.4 * GB),
		description: "Alibaba Qwen 3 small. Good balance of quality and speed.",
		tags: ["fast", "instruct", "recommended"],
	},
	{
		name: "qwen3:4b",
		displayName: "Qwen 3 4B",
		family: "qwen",
		paramSize: "4B",
		sizeBytes: Math.round(2.6 * GB),
		description: "Alibaba Qwen 3 4B. Strong multilingual performance for transformation tasks.",
		tags: ["instruct"],
	},
	{
		name: "phi3:mini",
		displayName: "Phi-3 Mini",
		family: "phi",
		paramSize: "3.8B",
		sizeBytes: Math.round(2.2 * GB),
		description: "Microsoft Phi-3 Mini. Lean instruct-tuned model with surprisingly strong output.",
		tags: ["instruct"],
	},
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
		name: "smollm2:1.7b",
		displayName: "SmolLM 2 1.7B",
		family: "smollm",
		paramSize: "1.7B",
		sizeBytes: Math.round(1.0 * GB),
		description: "Hugging Face SmolLM 2 1.7B. The largest of the SmolLM family.",
		tags: ["instruct"],
	},
	{
		name: "tinyllama",
		displayName: "TinyLlama 1.1B",
		family: "llama",
		paramSize: "1.1B",
		sizeBytes: Math.round(0.64 * GB),
		description: "Community TinyLlama. Classic small-footprint model.",
		tags: ["fast", "tiny"],
	},
];

export function findRecommendedModel(name: string): RecommendedOllamaModel | undefined {
	return RECOMMENDED_OLLAMA_MODELS.find((m) => m.name === name);
}
