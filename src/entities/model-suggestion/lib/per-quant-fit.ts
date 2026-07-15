/**
 * Fit of one (model, quantization) pair against the shared memory budgets.
 *
 * This is the per-quant re-check the legacy `comfortable_on_*` path never did
 * (it judged each model ONCE, at the effective quant only — see plan Part 2
 * finding 3): a model too big at fp32 can still be suggestible at int8, and
 * the fitting SET decides which quant badges stay clickable.
 *
 * Pool routing is per (model, quant), never per hardware presence: int8/uint8/
 * q4… are CPU-routed (RAM) even on GPU hosts, and CPU-pinned engines consume
 * RAM at every quant. The authoritative pin matrix is Rust-only
 * (`override_dml_to_cpu_for_kind` in `quant_resolve.rs`), surfaced per entry
 * as `device_by_quantization`; when an older server omits it we fall back to
 * the `predictedTarget` heuristic (GPU-compatible quant AND a GPU exists).
 */

import { ollamaRequiredRuntimeBytes } from "@/entities/llm-catalog/@x/model-suggestion";
import {
	estimateForQuant,
	GPU_COMPATIBLE_QUANTIZATIONS,
} from "@/entities/system-resources/@x/model-suggestion";
import type { MemoryBudgets } from "./memory-budget";

/**
 * Pool the fit test runs against. `"either"` is Ollama's rule: GPU-preferred
 * but RAM fallback allowed (Ollama does CPU/partial offload), so the Suggested
 * filter must not hide a model a big-RAM box runs fine — the VRAM-only rule
 * stays with the warning chip (`assessOllamaFit`).
 */
export type FitDevice = "gpu" | "cpu" | "either";

/** ONNX TTS disk size ≈ resident size, plus activation headroom. */
export const TTS_RUNTIME_HEADROOM = 1.2;

export interface QuantCandidate {
	/** Quant label as published (ONNX suffix or Ollama tag label). */
	quant: string;
	/** Estimated runtime bytes at this quant; `<= 0` = unknown (lenient: fits). */
	bytes: number;
	device: FitDevice;
}

/** Whether `bytesAtQuant` fits the pool(s) `device` routes to. Unknown
 * footprints (`<= 0`) are lenient — never hide a model we can't size (the
 * rule already established in `ollama/lib/filter-state.ts`). */
export function quantFits(
	bytesAtQuant: number,
	device: FitDevice,
	budgets: MemoryBudgets,
): boolean {
	if (bytesAtQuant <= 0) {
		return true;
	}
	if (device === "gpu") {
		return bytesAtQuant <= budgets.vramBytes;
	}
	if (device === "cpu") {
		return bytesAtQuant <= budgets.ramBytes;
	}
	return (
		(budgets.hasGpu && bytesAtQuant <= budgets.vramBytes) ||
		bytesAtQuant <= budgets.ramBytes
	);
}

export interface DeviceResolutionInput {
	hasGpu: boolean;
	/** Per-quant routed device from the server (`ModelStateEntry.
	 * device_by_quantization`, values "gpu"/"cpu"). Absent/unknown quants fall
	 * back to the heuristic. */
	deviceByQuantization?: Record<string, string> | null;
}

/** Routed device for one STT (model, quant): the server's pin-matrix verdict
 * when available, else today's `predictedTarget` heuristic. */
export function resolveQuantDevice(
	quant: string,
	input: DeviceResolutionInput,
): "gpu" | "cpu" {
	const pinned = input.deviceByQuantization?.[quant];
	if (pinned === "gpu" || pinned === "cpu") {
		return pinned;
	}
	return input.hasGpu && GPU_COMPATIBLE_QUANTIZATIONS.has(quant)
		? "gpu"
		: "cpu";
}

export interface SttQuantCandidatesInput extends DeviceResolutionInput {
	/** `ModelStateEntry.estimated_bytes` (fp32 baseline); `<= 0` = unknown. */
	estimatedBytes: number;
	/** `ModelInfo.availableQuantizations` — every published quant is checked. */
	availableQuantizations: readonly string[];
}

/** One fit candidate per published STT quant, bytes scaled from the fp32
 * baseline by `estimateForQuant` (the same scaling the fit badges use). */
export function sttQuantCandidates(
	input: SttQuantCandidatesInput,
): QuantCandidate[] {
	return input.availableQuantizations.map((quant) => ({
		quant,
		bytes:
			input.estimatedBytes > 0
				? estimateForQuant(input.estimatedBytes, quant)
				: 0,
		device: resolveQuantDevice(quant, input),
	}));
}

export interface TtsQuantCandidatesInput {
	/** `TtsModelInfo.sizeBytesByQuantization`; missing/zero entries = unknown. */
	sizeBytesByQuantization: Record<string, number>;
	availableQuantizations: readonly string[];
	/** TTS follows the global accelerator (see `ttsSection` in
	 * runtime-model-breakdown): "gpu" when the accelerator is a GPU. */
	device: "gpu" | "cpu";
}

/** One fit candidate per published TTS quant: disk size × headroom (disk ≈
 * resident for ONNX), routed to the global accelerator's pool. */
export function ttsQuantCandidates(
	input: TtsQuantCandidatesInput,
): QuantCandidate[] {
	return input.availableQuantizations.map((quant) => {
		const sizeBytes = input.sizeBytesByQuantization[quant] ?? 0;
		return {
			quant,
			bytes: sizeBytes > 0 ? Math.round(sizeBytes * TTS_RUNTIME_HEADROOM) : 0,
			device: input.device,
		};
	});
}

/** One fit candidate for an Ollama tag: GGUF size + KV/activation headroom
 * (`ollamaRequiredRuntimeBytes`), either-pool rule. Zero/unknown size stays
 * lenient. */
export function ollamaQuantCandidate(
	quantLabel: string,
	sizeBytes: number,
): QuantCandidate {
	return {
		quant: quantLabel,
		bytes: sizeBytes > 0 ? ollamaRequiredRuntimeBytes(sizeBytes) : 0,
		device: "either",
	};
}

/** The subset of `candidates` that fits `budgets` — the model is suggestible
 * iff this set is non-empty. */
export function fittingQuantSet(
	candidates: readonly QuantCandidate[],
	budgets: MemoryBudgets,
): Set<string> {
	const fitting = new Set<string>();
	for (const candidate of candidates) {
		if (quantFits(candidate.bytes, candidate.device, budgets)) {
			fitting.add(candidate.quant);
		}
	}
	return fitting;
}
