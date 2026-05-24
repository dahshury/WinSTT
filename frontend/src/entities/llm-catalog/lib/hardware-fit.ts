import type { SystemInfoEntry } from "@/shared/api/ipc-client";

/**
 * Where the model would be expected to run if it fits, or what's missing
 * if it doesn't. "gpu" / "cpu" are positive outcomes; "vram" / "ram" name
 * the resource that's the bottleneck when `fits` is false.
 */
export type OllamaFitTarget = "gpu" | "cpu";
export type OllamaFitShortfall = "vram" | "ram" | "unknown";

export interface OllamaFitAssessment {
	/** Bytes available on the resource we'd try first (GPU VRAM if present, else RAM budget). */
	availableBytes: number;
	/** True when we believe the model will run without thrashing. */
	fits: boolean;
	/** Estimated runtime bytes the model would consume (file size + headroom). */
	requiredBytes: number;
	/** When `fits` is false: which resource is too small. Otherwise undefined. */
	shortfall: OllamaFitShortfall | undefined;
	/** Where we expect the model to run when `fits` is true. Otherwise undefined. */
	target: OllamaFitTarget | undefined;
}

// Headroom on top of the raw GGUF file size:
//  - KV-cache + activations grow roughly with context length; ~1GB is a
//    realistic floor for Ollama's 4k–8k default context window.
//  - Q4 quantization is the most common Ollama download path; the runtime
//    weight footprint is close to the file size but not identical.
// 20% of file + 1GB matches what we see for the recommended-model list.
const HEADROOM_FACTOR = 1.2;
const HEADROOM_FLOOR_BYTES = 1_000_000_000;

// Reserve some RAM for the OS and other apps so the prediction doesn't
// say "fits" right up to OOM. 30% reservation is conservative but matches
// the behavior of Ollama's own CPU-fallback heuristic.
const CPU_RAM_USABLE_FRACTION = 0.7;

function requiredRuntimeBytes(sizeBytes: number): number {
	return Math.round(sizeBytes * HEADROOM_FACTOR + HEADROOM_FLOOR_BYTES);
}

function largestGpuVramBytes(sys: SystemInfoEntry): number {
	let max = 0;
	for (const gpu of sys.gpus) {
		if (gpu.total_vram_bytes > max) {
			max = gpu.total_vram_bytes;
		}
	}
	return max;
}

function hasGpu(sys: SystemInfoEntry): boolean {
	return sys.gpus.length > 0;
}

function gpuFits(available: number, required: number): boolean {
	return available >= required;
}

/** Early-exit assessment for zero size or missing system info — caller has
 *  no enough data to flag a problem, so we report "fits" with undefined target. */
function unknownAssessment(sizeBytes: number): OllamaFitAssessment {
	return {
		fits: true,
		target: undefined,
		shortfall: sizeBytes <= 0 ? undefined : "unknown",
		requiredBytes: 0,
		availableBytes: 0,
	};
}

/** Assess the GPU branch — fits if VRAM covers requirement, otherwise flags
 *  VRAM shortfall (we don't silently fall back to RAM because Ollama would
 *  partially offload with a major speed cliff that the warning is meant to flag). */
function assessOnGpu(required: number, vram: number): OllamaFitAssessment {
	if (gpuFits(vram, required)) {
		return {
			fits: true,
			target: "gpu",
			shortfall: undefined,
			requiredBytes: required,
			availableBytes: vram,
		};
	}
	return {
		fits: false,
		target: undefined,
		shortfall: "vram",
		requiredBytes: required,
		availableBytes: vram,
	};
}

/** Assess the CPU branch — fits if 70% of total RAM covers requirement,
 *  otherwise flags RAM shortfall. */
function assessOnCpu(required: number, ramBudget: number): OllamaFitAssessment {
	if (ramBudget >= required) {
		return {
			fits: true,
			target: "cpu",
			shortfall: undefined,
			requiredBytes: required,
			availableBytes: ramBudget,
		};
	}
	return {
		fits: false,
		target: undefined,
		shortfall: "ram",
		requiredBytes: required,
		availableBytes: ramBudget,
	};
}

function cpuRamBudget(sys: SystemInfoEntry): number {
	return Math.floor(sys.total_ram_bytes * CPU_RAM_USABLE_FRACTION);
}

/** Pick GPU vs CPU strategy for a host with known system info. */
function assessOnHost(required: number, systemInfo: SystemInfoEntry): OllamaFitAssessment {
	if (hasGpu(systemInfo)) {
		return assessOnGpu(required, largestGpuVramBytes(systemInfo));
	}
	return assessOnCpu(required, cpuRamBudget(systemInfo));
}

/**
 * Decide whether `sizeBytes` of Ollama model will run comfortably on `systemInfo`.
 *
 * Strategy:
 *  1. If the host has a GPU, check whether the largest GPU's VRAM covers
 *     the model + headroom. If yes → fits on GPU.
 *  2. Otherwise (or as a fallback when no GPU fits), check whether 70% of
 *     total RAM covers the model + headroom. If yes → fits on CPU.
 *  3. Neither → `fits: false`, and `shortfall` names the bottleneck on the
 *     resource we'd have tried (VRAM if there's a GPU, else RAM).
 *
 * Returns `fits: true` with `target: undefined` when sizeBytes is 0 or
 * systemInfo is missing — we don't have enough information to flag.
 */
export function assessOllamaFit(
	sizeBytes: number,
	systemInfo: SystemInfoEntry | null
): OllamaFitAssessment {
	if (sizeBytes <= 0 || systemInfo === null) {
		return unknownAssessment(sizeBytes);
	}
	return assessOnHost(requiredRuntimeBytes(sizeBytes), systemInfo);
}

/** Convenience predicate matching the STT selector's `isUncomfortable` shape. */
export function isOllamaUncomfortable(
	sizeBytes: number,
	systemInfo: SystemInfoEntry | null
): boolean {
	return !assessOllamaFit(sizeBytes, systemInfo).fits;
}
