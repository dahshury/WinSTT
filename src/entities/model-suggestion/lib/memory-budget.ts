/**
 * Shared cross-modality memory budget calculator — the single source of truth
 * for "how much RAM/VRAM is left for the modality being picked" used by all
 * three local pickers (STT / TTS / Ollama).
 *
 * Deliberately TOTALS-based, not live-free-based: the Suggested list answers
 * the static capability question ("can this machine run it well") and must be
 * stable while the picker is open. Live free readings would also double-count
 * already-resident models — the committed list below subtracts each enabled
 * modality's footprint explicitly instead. The existing live per-row badges
 * (`assessDictationFitClient` + `useSystemResourcesStore`) stay unchanged and
 * complementary.
 */

/** Fraction of total RAM a model may occupy — mirrors `RAM_USABLE_FRACTION`
 * in `fit-assessor.ts` / `fit_assessment` (leave 30% for the OS + apps). */
export const RAM_USABLE_FRACTION = 0.7;

/** VRAM headroom divisor — mirrors `GPU_HEADROOM = 1.5` in
 * `catalog_data.rs::is_comfortable_on_gpu`, expressed as a budget so the fit
 * test is a plain `bytes <= budget`. */
export const GPU_HEADROOM = 1.5;

export type SuggestionModality = "stt" | "tts" | "llm" | "dictionary";

/** One enabled model's runtime footprint, already resolved to the pool it
 * lives in (`device` decides RAM vs VRAM — CPU-pinned engines and non-fp
 * quants consume RAM even on GPU hosts). */
export interface CommittedModel {
	bytes: number;
	device: "gpu" | "cpu";
	modality: SuggestionModality;
}

export interface MemoryBudgets {
	hasGpu: boolean;
	/** RAM bytes available to the picked modality; a plain `bytes <= ramBytes` fit test. */
	ramBytes: number;
	/** VRAM bytes available to the picked modality; 0 when no GPU. */
	vramBytes: number;
}

export interface SystemMemory {
	totalRamBytes: number;
	/** VRAM of the LARGEST GPU (never `.all()` — an iGPU must not veto the dGPU). */
	largestGpuVramBytes: number;
}

/** Largest-GPU VRAM from a raw GPU list (structural: works for both
 * `SystemInfoEntry.gpus` and `LiveResourcesEntry.gpus`). iGPU + dGPU hosts
 * must budget against the biggest card, matching `largestGpu` in
 * `fit-assessor.ts` and fixing the backend's `.all()` aggregation bug. */
export function largestGpuVram(
	gpus: readonly { total_vram_bytes: number }[],
): number {
	let max = 0;
	for (const gpu of gpus) {
		if (gpu.total_vram_bytes > max) {
			max = gpu.total_vram_bytes;
		}
	}
	return max;
}

/**
 * Compute the RAM/VRAM budgets left for `excludeModality` after subtracting
 * every OTHER enabled modality's committed footprint from its own pool.
 * The picked modality is excluded so swapping REPLACES its footprint rather
 * than stacking on top of it (mirrors `freedSlotFootprint` in fit-assessor).
 */
export function computeBudgets(
	sys: SystemMemory,
	committed: readonly CommittedModel[],
	excludeModality: SuggestionModality,
): MemoryBudgets {
	const hasGpu = sys.largestGpuVramBytes > 0;
	let ram = Math.floor(sys.totalRamBytes * RAM_USABLE_FRACTION);
	let vram = hasGpu ? Math.floor(sys.largestGpuVramBytes / GPU_HEADROOM) : 0;
	for (const model of committed) {
		if (model.modality === excludeModality) {
			continue;
		}
		if (model.device === "gpu") {
			vram -= model.bytes;
		} else {
			ram -= model.bytes;
		}
	}
	return {
		hasGpu,
		ramBytes: Math.max(0, ram),
		vramBytes: Math.max(0, vram),
	};
}
