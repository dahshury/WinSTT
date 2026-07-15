/**
 * Orchestration: model list → per-model suggestion verdicts + a best-first
 * ordering. Pure and structural — the hosts adapt each catalog (STT / TTS /
 * Ollama) into `SuggestModelInput`s via the `per-quant-fit` candidate
 * builders, then thread `getSuggestion(modelId)` into the presentational
 * pickers (same pattern as the existing `getFitAssessment` prop).
 *
 * Language rules live UPSTREAM of this module (plan Part 3.5): STT models
 * that can't transcribe the user's dictation language are excluded before
 * calling in (`modelSupportsSelectedSourceLanguages`); TTS language
 * mismatches are DE-RANKED by passing `scoreFactor = LANGUAGE_MISMATCH_FACTOR`.
 */

import { bangForBuck } from "./bang-for-buck";
import type { MemoryBudgets } from "./memory-budget";
import { type QuantCandidate, quantFits } from "./per-quant-fit";
import {
	effectiveScores,
	quantTierForLabel,
	type RoutedDevice,
} from "./quant-tiers";

export interface SuggestModelInput {
	id: string;
	/** Display name — the deterministic tie-breaker (A→Z, base sensitivity,
	 * mirroring the pickers' `makeNameComparator`). */
	name: string;
	/** Catalog accuracy/quality score, 0..1, 0.5 = unknown sentinel. For
	 * Ollama use `ollamaProxyAccuracy`. */
	baseAccuracy: number;
	/** Catalog speed score, 0..1, 0.5 = unknown sentinel. For Ollama use
	 * `ollamaProxySpeed`. */
	baseSpeed: number;
	/** One candidate per published quant (see `sttQuantCandidates` /
	 * `ttsQuantCandidates` / `ollamaQuantCandidate`). */
	quants: readonly QuantCandidate[];
	/** Multiplier on the final score — e.g. `LANGUAGE_MISMATCH_FACTOR` for a
	 * TTS model whose languages miss the preferred set. Default 1. */
	scoreFactor?: number;
}

export interface ModelSuggestion {
	/** False when NO published quant fits — the picker hides the card. */
	visible: boolean;
	/** Quants that fit the budgets — badges outside this set render disabled. */
	fittingQuants: ReadonlySet<string>;
	/** Headline bang-for-buck score = max over fitting quants (× scoreFactor). */
	score: number;
	/** The quant achieving the headline score; null when nothing fits. */
	bestQuant: string | null;
}

export interface SuggestionResult {
	byId: ReadonlyMap<string, ModelSuggestion>;
	/** Visible model ids, best-first (score desc, name A→Z tie-break). */
	order: readonly string[];
}

/** Speed-tier device for a candidate: "either" (Ollama) is GPU-preferred, so
 * it experiences GPU speed characteristics whenever a GPU exists. */
function routedDeviceOf(
	candidate: QuantCandidate,
	budgets: MemoryBudgets,
): RoutedDevice {
	if (candidate.device === "either") {
		return budgets.hasGpu ? "gpu" : "cpu";
	}
	return candidate.device;
}

function scoreQuant(
	model: SuggestModelInput,
	candidate: QuantCandidate,
	budgets: MemoryBudgets,
): number {
	const tier = quantTierForLabel(candidate.quant);
	const effective = effectiveScores(
		{ accuracy: model.baseAccuracy, speed: model.baseSpeed },
		tier,
		routedDeviceOf(candidate, budgets),
	);
	return bangForBuck(effective.accuracy, effective.speed);
}

/** Assess one model: which quants fit, and the best score among them. */
export function suggestModel(
	model: SuggestModelInput,
	budgets: MemoryBudgets,
): ModelSuggestion {
	const fittingQuants = new Set<string>();
	let best: { quant: string; score: number } | null = null;
	for (const candidate of model.quants) {
		if (!quantFits(candidate.bytes, candidate.device, budgets)) {
			continue;
		}
		fittingQuants.add(candidate.quant);
		const score = scoreQuant(model, candidate, budgets);
		if (best === null || score > best.score) {
			best = { quant: candidate.quant, score };
		}
	}
	return {
		visible: fittingQuants.size > 0,
		fittingQuants,
		score: (best?.score ?? 0) * (model.scoreFactor ?? 1),
		bestQuant: best?.quant ?? null,
	};
}

function compareByName(a: SuggestModelInput, b: SuggestModelInput): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Assess a whole catalog slice and derive the Suggested ordering. */
export function suggestModels(
	models: readonly SuggestModelInput[],
	budgets: MemoryBudgets,
): SuggestionResult {
	const byId = new Map<string, ModelSuggestion>();
	for (const model of models) {
		byId.set(model.id, suggestModel(model, budgets));
	}
	const order = models
		.filter((model) => byId.get(model.id)?.visible)
		.toSorted((a, b) => {
			const scoreA = byId.get(a.id)?.score ?? 0;
			const scoreB = byId.get(b.id)?.score ?? 0;
			return scoreB - scoreA || compareByName(a, b);
		})
		.map((model) => model.id);
	return { byId, order };
}
