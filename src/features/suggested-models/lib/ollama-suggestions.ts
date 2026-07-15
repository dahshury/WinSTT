/**
 * Ollama adapter for the suggestion engine: budgets → the small verdict object
 * the Ollama picker threads down (same host-adapter pattern as
 * `stt-suggestions.ts`, shaped for Ollama's byte-first catalog).
 *
 * Unlike STT, the Ollama library publishes NO accuracy/speed scores and no
 * per-model quant matrix up front — cards carry a single GGUF size (installed
 * `OllamaModel.size`, recommended `sizeBytes`) and the scraped tag list adds
 * per-quant sizes lazily. So the adapter exposes two primitives instead of a
 * per-id map:
 *  - `fits(sizeBytes)` — the per-quant fit test (either-pool rule: VRAM budget
 *    OR RAM budget, per plan Part 3.3; Ollama does CPU/partial offload, so the
 *    Suggested filter must not hide what a big-RAM box runs fine — the
 *    VRAM-only rule stays with the warning chip's `assessOllamaFit`).
 *  - `score(input)` — the bang-for-buck proxy ranking (plan Part 3.4):
 *    accuracy ∝ log param count, speed ∝ how little of the pool the model
 *    occupies, folded through the same engine formula the STT ranking uses.
 *
 * NO language rule for Ollama (plan Part 3.5): the library has no per-model
 * language metadata and LLM cleanup is largely language-agnostic.
 */

import { ollamaRequiredRuntimeBytes } from "@/entities/llm-catalog";
import {
	type MemoryBudgets,
	ollamaProxyAccuracy,
	ollamaProxySpeed,
	ollamaQuantCandidate,
	quantFits,
	suggestModel,
} from "@/entities/model-suggestion";

export interface OllamaSuggestionScoreInput {
	/** Full pull tag (`gemma3:4b-q8_0`) — its quant token picks the tier. */
	name: string;
	displayName: string;
	/** Parameter-count label (`4B`, `1.2b`, `e2b`, `540M`); null/unparseable
	 * lands mid-pack via the unknown sentinel. */
	paramSizeLabel: string | null;
	/** GGUF download size; `<= 0` = unknown (mid-pack speed proxy). */
	sizeBytes: number;
}

/** The verdict object the Ollama picker receives (structurally compatible
 * with the picker's own `OllamaSuggestionsProp` — no widget import needed). */
export interface OllamaSuggestions {
	budgets: MemoryBudgets;
	fits: (sizeBytes: number) => boolean;
	score: (input: OllamaSuggestionScoreInput) => number;
}

/** `4B` / `1.2b` / `540M` / `e2b` (Gemma MatFormer "effective" sizes) →
 * parameter count in billions; unknown/unparseable → 0. */
const PARAM_LABEL_RE = /e?(\d+(?:\.\d+)?)\s*([bmk])/i;

export function ollamaParamCountB(label: string | null | undefined): number {
	const match = label ? PARAM_LABEL_RE.exec(label) : null;
	if (!(match?.[1] && match[2])) {
		return 0;
	}
	const value = Number.parseFloat(match[1]);
	if (!Number.isFinite(value)) {
		return 0;
	}
	const unit = match[2].toLowerCase();
	if (unit === "m") {
		return value / 1000;
	}
	if (unit === "k") {
		return value / 1_000_000;
	}
	return value;
}

/** The pool the proxy-speed denominator runs against: GPU-preferred (Ollama
 * offloads to the GPU whenever one exists), RAM otherwise. */
function poolBudgetBytes(budgets: MemoryBudgets): number {
	return budgets.hasGpu ? budgets.vramBytes : budgets.ramBytes;
}

/** Build the Ollama picker's Suggested verdict for a fixed budget snapshot. */
export function buildOllamaSuggestions(
	budgets: MemoryBudgets,
): OllamaSuggestions {
	return {
		budgets,
		// Either-pool + KV/activation headroom; unknown sizes stay lenient (the
		// rule already established in `ollama/lib/filter-state.ts`).
		fits: (sizeBytes: number) => {
			const candidate = ollamaQuantCandidate("", sizeBytes);
			return quantFits(candidate.bytes, candidate.device, budgets);
		},
		score: (input: OllamaSuggestionScoreInput) => {
			const requiredBytes =
				input.sizeBytes > 0 ? ollamaRequiredRuntimeBytes(input.sizeBytes) : 0;
			// One-candidate `suggestModel` run so the quant-tier adjustment
			// (Q8→int8, fp16, QAT→int4, default→q4) and the harmonic formula are
			// EXACTLY the engine's — the tag name carries the quant token.
			return suggestModel(
				{
					id: input.name,
					name: input.displayName,
					baseAccuracy: ollamaProxyAccuracy(
						ollamaParamCountB(input.paramSizeLabel),
					),
					baseSpeed: ollamaProxySpeed(requiredBytes, poolBudgetBytes(budgets)),
					quants: [ollamaQuantCandidate(input.name, input.sizeBytes)],
				},
				budgets,
			).score;
		},
	};
}
