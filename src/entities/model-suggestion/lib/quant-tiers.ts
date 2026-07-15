/**
 * Quantization tier tables — how much accuracy/speed each published precision
 * systematically gains or loses relative to the model's catalog scores.
 *
 * Catalog `accuracyScore`/`speedScore` are per model at the natural (fp32 /
 * largest) export, normalized 0..1 with **0.5 = unknown sentinel** (see
 * `sort-state.ts`: unknown lands mid-pack). These maps encode the degradation
 * per quant as tunable additive constants, documented from the measured
 * evidence already in the repo:
 *  - `quant_resolve.rs` `CPU_ORDER` comments: ORT's CPU EP up-casts fp16 →
 *    4–8× SLOWER than fp32 on CPU (measured), hence the large negative CPU
 *    deltas for fp16/fp16w/q4f16.
 *  - `QUANTIZATION_WEIGHT` in `stt/lib/quantization-helpers.ts`: bit width as
 *    fidelity proxy — accuracy penalty grows as precision drops.
 */

import {
	ONNX_QUANTIZATIONS,
	type OnnxQuantization,
} from "@/shared/config/defaults";

/** Additive accuracy penalty on the 0..1 normalized score; clamped to [0, 1]. */
export const QUANT_ACCURACY_PENALTY: Record<OnnxQuantization, number> = {
	"": 0,
	fp16: 0.01,
	fp16w: 0.01,
	int8: 0.03,
	uint8: 0.03,
	q4f16: 0.06,
	int4: 0.08,
	q4: 0.08,
	bnb4: 0.08,
};

/**
 * Speed adjustment when the quant is routed to the GPU EP. Positive = faster
 * than the fp32 baseline (smaller weights, tensor-core fp16 paths).
 */
export const QUANT_SPEED_DELTA_GPU: Record<OnnxQuantization, number> = {
	"": 0,
	fp16: 0.1,
	fp16w: 0.05,
	int8: 0.05,
	uint8: 0.05,
	q4f16: 0.08,
	int4: 0.08,
	q4: 0.08,
	bnb4: 0.08,
};

/**
 * Speed adjustment when the quant is routed to the CPU EP. Mirrors `CPU_ORDER`
 * in `quant_resolve.rs`: integer quants are faster on CPU, but fp16 weights are
 * up-cast per op by ORT's CPU EP → a large measured SLOWDOWN, not a speedup.
 */
export const QUANT_SPEED_DELTA_CPU: Record<OnnxQuantization, number> = {
	"": 0,
	int8: 0.08,
	uint8: 0.08,
	q4: 0.12,
	int4: 0.12,
	bnb4: 0.12,
	fp16: -0.3,
	fp16w: -0.3,
	q4f16: -0.2,
};

/** Catalog scores use 0.5 as "unknown" — it must pass through untouched so
 * unknown models keep landing mid-pack instead of being tier-shifted. */
export const UNKNOWN_SCORE_SENTINEL = 0.5;

/** Where a (model, quant) pair actually runs — decides which speed table applies. */
export type RoutedDevice = "gpu" | "cpu";

export interface BaseScores {
	/** 0..1 normalized; 0.5 = unknown sentinel. */
	accuracy: number;
	/** 0..1 normalized; 0.5 = unknown sentinel. */
	speed: number;
}

export function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function adjustedAccuracy(base: number, quant: OnnxQuantization): number {
	if (base === UNKNOWN_SCORE_SENTINEL) {
		return base;
	}
	return clamp01(base - QUANT_ACCURACY_PENALTY[quant]);
}

function adjustedSpeed(
	base: number,
	quant: OnnxQuantization,
	device: RoutedDevice,
): number {
	if (base === UNKNOWN_SCORE_SENTINEL) {
		return base;
	}
	const deltas =
		device === "gpu" ? QUANT_SPEED_DELTA_GPU : QUANT_SPEED_DELTA_CPU;
	return clamp01(base + deltas[quant]);
}

/**
 * The model's scores as they would actually be experienced at `quant` on
 * `device`: accuracy penalized by precision loss, speed adjusted by the
 * device-dependent delta. Both clamped to [0, 1]; the 0.5 unknown sentinel
 * passes through untouched.
 */
export function effectiveScores(
	base: BaseScores,
	quant: OnnxQuantization,
	device: RoutedDevice,
): BaseScores {
	return {
		accuracy: adjustedAccuracy(base.accuracy, quant),
		speed: adjustedSpeed(base.speed, quant, device),
	};
}

function isOnnxQuantization(value: string): value is OnnxQuantization {
	return (ONNX_QUANTIZATIONS as readonly string[]).includes(value);
}

const QAT_TOKEN_RE = /(?:^|[-_:])qat(?=$|[-_])/;
const FP16_TOKEN_RE = /(?:^|[-_:])b?fp?16(?=$|[-_])/;
const Q8_TOKEN_RE = /(?:^|[-_:])q8(?:_\w+)?(?=$|[-_])/;

/**
 * Map any quant label — ONNX suffix or Ollama tag label — onto the tier tables'
 * `OnnxQuantization` key. ONNX quants map to themselves (`"fp32"` to `""`, the
 * unsuffixed base export). Ollama GGUF labels map to the closest tier:
 * `Q8_0` → int8, `fp16`/`bf16` → fp16, `QAT` → int4 (quantization-aware int4),
 * and everything else — `Q4_K_M`, `Q5_K_M`, `default`, `latest` — → q4, since
 * Ollama's default pulls are Q4_K_M.
 */
export function quantTierForLabel(label: string): OnnxQuantization {
	const normalized = label.trim().toLowerCase();
	if (isOnnxQuantization(normalized)) {
		return normalized;
	}
	if (normalized === "fp32") {
		return "";
	}
	if (QAT_TOKEN_RE.test(normalized)) {
		return "int4";
	}
	if (Q8_TOKEN_RE.test(normalized)) {
		return "int8";
	}
	if (FP16_TOKEN_RE.test(normalized)) {
		return "fp16";
	}
	return "q4";
}
