/**
 * "Bang for buck" ranking formula — F-beta-style weighted harmonic mean of
 * effective accuracy and effective speed.
 *
 * Why harmonic (not weighted-sum): the harmonic form enforces a *soft speed
 * floor* — a very slow model cannot ride a high accuracy score to the top
 * because a near-zero term drags the product down multiplicatively. That is
 * exactly "runs *well* on this machine", not just "is accurate". β = 0.5
 * keeps accuracy primary (accuracy weighted 2× speed): dictation users
 * tolerate a 1.5× slower model, not a 5%-worse WER.
 */

import { clamp01, UNKNOWN_SCORE_SENTINEL } from "./quant-tiers";

/** β in the F-beta harmonic mean; < 1 weights accuracy over speed. Exported
 * for tuning. */
const SUGGEST_BETA = 0.5;

/** TTS language-mismatch de-rank multiplier (mismatches are shown but must
 * not outrank matches — see plan Part 3.5; STT mismatches are excluded
 * upstream instead). */
export const LANGUAGE_MISMATCH_FACTOR = 0.5;

/**
 * score(A, S) = (1 + β²)·A·S / (β²·A + S). Both inputs 0..1 (effective
 * scores, post quant-tier adjustment). Degenerate zero denominator → 0.
 */
export function bangForBuck(accuracy: number, speed: number): number {
	const betaSq = SUGGEST_BETA * SUGGEST_BETA;
	const denominator = betaSq * accuracy + speed;
	if (denominator <= 0) {
		return 0;
	}
	return ((1 + betaSq) * accuracy * speed) / denominator;
}

// ---------------------------------------------------------------------------
// Ollama proxies — the Ollama library publishes no accuracy/speed scores, so
// we substitute documented PROXIES and feed them through the same formula:
//  - accuracy ∝ log parameter count (quality grows with params, with heavy
//    diminishing returns — hence log, not linear);
//  - speed ∝ how little of the memory pool the model occupies (bigger models
//    are slower to generate, and models near the budget edge get partially
//    offloaded — a real measured speed cliff).
// ---------------------------------------------------------------------------

/** Param count (in billions) that maps to proxy accuracy 0.5 — an 8B model
 * is the mid-pack reference. */
export const OLLAMA_PARAM_LOG_MIDPOINT_B = 8;

/** Doublings from the midpoint that saturate the scale: ±5 doublings
 * (0.25B → 0, 256B → 1). */
const OLLAMA_PARAM_LOG_HALF_SPAN = 5;

/** Log-normalized param count → 0..1 proxy accuracy; unknown (`<= 0`) lands
 * mid-pack at the 0.5 sentinel. Monotonic in `paramCountB`. */
export function ollamaProxyAccuracy(paramCountB: number): number {
	if (paramCountB <= 0) {
		return UNKNOWN_SCORE_SENTINEL;
	}
	const doublings = Math.log2(paramCountB / OLLAMA_PARAM_LOG_MIDPOINT_B);
	return clamp01(0.5 + doublings / (2 * OLLAMA_PARAM_LOG_HALF_SPAN));
}

/** 1 − (required bytes / pool budget), clamped — a model filling its whole
 * pool scores 0, a tiny one approaches 1. Unknown size lands mid-pack;
 * zero budget scores 0. Monotonically decreasing in `requiredBytes`. */
export function ollamaProxySpeed(
	requiredBytes: number,
	poolBudgetBytes: number,
): number {
	if (requiredBytes <= 0) {
		return UNKNOWN_SCORE_SENTINEL;
	}
	if (poolBudgetBytes <= 0) {
		return 0;
	}
	return clamp01(1 - requiredBytes / poolBudgetBytes);
}
