import { describe, expect, test } from "bun:test";
import type { LiveResourcesEntry, ModelStateEntry } from "@/shared/api/ipc-client";
import {
	assessDictationFitClient,
	assessOllamaFitClient,
	loadedDictationFootprint,
	TEST_ONLY,
} from "./fit-assessor";

const GB = 1024 ** 3;

function liveOf(opts: Partial<LiveResourcesEntry> = {}): LiveResourcesEntry {
	return {
		ram_total_bytes: 32 * GB,
		ram_available_bytes: 16 * GB,
		cpu_count_logical: 8,
		cpu_count_physical: 4,
		cpu_percent: 10,
		gpus: [],
		...opts,
	};
}

function gpuOf(opts: { total?: number; free?: number } = {}) {
	const total = opts.total ?? 24 * GB;
	const free = opts.free ?? total;
	return {
		name: "Test GPU",
		total_vram_bytes: total,
		used_vram_bytes: total - free,
		free_vram_bytes: free,
		utilization_percent: 0,
	};
}

function entryOf(
	opts: Partial<ModelStateEntry> & { id: string; estimated_bytes: number }
): ModelStateEntry {
	return {
		id: opts.id,
		estimated_bytes: opts.estimated_bytes,
		comfortable_on_cpu: opts.comfortable_on_cpu ?? true,
		comfortable_on_gpu: opts.comfortable_on_gpu ?? true,
		available_quantizations: opts.available_quantizations ?? [""],
		cache: opts.cache ?? {
			state: "not_cached",
			downloaded_bytes: 0,
			progress: 0,
			total_bytes: 0,
		},
		cache_by_quantization: opts.cache_by_quantization ?? {},
	};
}

describe("assessDictationFitClient", () => {
	test("unknown model returns ok + unknown_footprint", () => {
		const result = assessDictationFitClient("missing", {
			statesById: {},
			candidateQuant: "",
			requestedDevice: null,
			loaded: { mainId: null, mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf(),
		});
		expect(result.severity).toBe("ok");
		expect(result.reasons).toContain("unknown_footprint");
	});

	test("fits on a roomy GPU", () => {
		const result = assessDictationFitClient("tiny", {
			statesById: { tiny: entryOf({ id: "tiny", estimated_bytes: 500_000_000 }) },
			candidateQuant: "",
			requestedDevice: null,
			loaded: { mainId: null, mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ gpus: [gpuOf({ total: 24 * GB, free: 24 * GB })] }),
		});
		expect(result.target).toBe("gpu");
		expect(result.severity).toBe("ok");
	});

	test("critical when candidate exceeds remaining VRAM", () => {
		const result = assessDictationFitClient("large", {
			statesById: {
				large: entryOf({ id: "large", estimated_bytes: 8 * GB }),
			},
			candidateQuant: "",
			requestedDevice: null,
			loaded: { mainId: null, mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ gpus: [gpuOf({ total: 4 * GB, free: 1 * GB })] }),
		});
		expect(result.severity).toBe("critical");
		expect(result.reasons).toContain("exceeds_vram");
	});

	test("routes int8 to CPU even on a GPU host", () => {
		const result = assessDictationFitClient("tiny", {
			statesById: { tiny: entryOf({ id: "tiny", estimated_bytes: 100_000_000 }) },
			candidateQuant: "int8",
			requestedDevice: null,
			loaded: { mainId: null, mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ gpus: [gpuOf()] }),
		});
		expect(result.target).toBe("cpu");
		expect(result.reasons).toContain("requires_cpu_quant");
	});

	test("subtracts another loaded model from CPU budget", () => {
		const result = assessDictationFitClient("small", {
			statesById: {
				small: entryOf({ id: "small", estimated_bytes: 3 * GB }),
				base: entryOf({ id: "base", estimated_bytes: 1 * GB }),
			},
			candidateQuant: "",
			requestedDevice: null,
			loaded: { mainId: null, mainQuant: "", realtimeId: "base", realtimeQuant: "" },
			live: liveOf({ ram_total_bytes: 8 * GB, ram_available_bytes: 6 * GB }),
		});
		expect(result.reasons).toContain("stt_already_uses_ram");
	});

	test("excludes outgoing model when swapping the same slot", () => {
		const result = assessDictationFitClient("tiny", {
			statesById: { tiny: entryOf({ id: "tiny", estimated_bytes: 500_000_000 }) },
			candidateQuant: "",
			requestedDevice: null,
			loaded: { mainId: "tiny", mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ ram_total_bytes: 8 * GB, ram_available_bytes: 4 * GB }),
		});
		expect(result.reasons).not.toContain("stt_already_uses_ram");
	});

	test("no GPU + non-CPU device adds no_gpu_available reason", () => {
		const result = assessDictationFitClient("tiny", {
			statesById: { tiny: entryOf({ id: "tiny", estimated_bytes: 500_000_000 }) },
			candidateQuant: "",
			requestedDevice: null,
			loaded: { mainId: null, mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ ram_total_bytes: 32 * GB, ram_available_bytes: 24 * GB }),
		});
		expect(result.target).toBe("cpu");
		expect(result.reasons).toContain("no_gpu_available");
	});
});

describe("assessOllamaFitClient", () => {
	test("zero size returns ok", () => {
		const result = assessOllamaFitClient(0, {
			statesById: {},
			loaded: { mainId: null, mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf(),
		});
		expect(result.severity).toBe("ok");
	});

	test("fits on a roomy GPU", () => {
		const result = assessOllamaFitClient(1 * GB, {
			statesById: {},
			loaded: { mainId: null, mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ gpus: [gpuOf({ total: 24 * GB, free: 24 * GB })] }),
		});
		expect(result.target).toBe("gpu");
		expect(result.severity).toBe("ok");
	});

	test("critical when exceeds VRAM", () => {
		const result = assessOllamaFitClient(8 * GB, {
			statesById: {},
			loaded: { mainId: null, mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ gpus: [gpuOf({ total: 4 * GB, free: 4 * GB })] }),
		});
		expect(result.severity).toBe("critical");
		expect(result.reasons).toContain("exceeds_vram");
	});

	test("flags STT GPU coexistence", () => {
		const result = assessOllamaFitClient(1 * GB, {
			statesById: {
				tiny: entryOf({ id: "tiny", estimated_bytes: 500_000_000 }),
			},
			loaded: { mainId: "tiny", mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ gpus: [gpuOf({ total: 24 * GB, free: 20 * GB })] }),
		});
		expect(result.reasons).toContain("stt_already_uses_gpu");
	});

	test("CPU path subtracts dictation model from RAM budget", () => {
		const result = assessOllamaFitClient(5 * GB, {
			statesById: {
				large: entryOf({ id: "large", estimated_bytes: 3 * GB }),
			},
			loaded: { mainId: "large", mainQuant: "", realtimeId: null, realtimeQuant: "" },
			live: liveOf({ ram_total_bytes: 16 * GB, ram_available_bytes: 16 * GB }),
		});
		expect(result.reasons).toContain("stt_already_uses_ram");
	});
});

describe("loadedDictationFootprint", () => {
	test("sums main + realtime, scaled by quantization", () => {
		const states = {
			a: entryOf({ id: "a", estimated_bytes: 1 * GB }),
			b: entryOf({ id: "b", estimated_bytes: 1 * GB }),
		};
		const total = loadedDictationFootprint(
			states,
			{ mainId: "a", mainQuant: "", realtimeId: "b", realtimeQuant: "" },
			null
		);
		// Both at default factor → 2x base estimate (×4/1.2 each)
		expect(total).toBeGreaterThan(0);
	});

	test("excluded id is not counted", () => {
		const states = {
			a: entryOf({ id: "a", estimated_bytes: 1 * GB }),
		};
		const total = loadedDictationFootprint(
			states,
			{ mainId: "a", mainQuant: "", realtimeId: null, realtimeQuant: "" },
			"a"
		);
		expect(total).toBe(0);
	});

	test("missing entries are skipped", () => {
		const total = loadedDictationFootprint(
			{},
			{ mainId: "ghost", mainQuant: "", realtimeId: null, realtimeQuant: "" },
			null
		);
		expect(total).toBe(0);
	});
});

describe("slotBytes", () => {
	const { slotBytes } = TEST_ONLY;
	const states: Record<string, ModelStateEntry> = {
		a: entryOf({ id: "a", estimated_bytes: 1 * GB }),
		zero: entryOf({ id: "zero", estimated_bytes: 0 }),
		neg: entryOf({ id: "neg", estimated_bytes: -1 }),
	};

	test("returns 0 when slot id is null", () => {
		expect(slotBytes({ id: null, quant: "" }, states, null)).toBe(0);
	});

	test("returns 0 when slot id matches excludeId", () => {
		expect(slotBytes({ id: "a", quant: "" }, states, "a")).toBe(0);
	});

	test("returns 0 when slot id is missing from statesById", () => {
		expect(slotBytes({ id: "missing", quant: "" }, states, null)).toBe(0);
	});

	test("returns 0 when entry estimated_bytes is non-positive (zero)", () => {
		expect(slotBytes({ id: "zero", quant: "" }, states, null)).toBe(0);
	});

	test("returns 0 when entry estimated_bytes is non-positive (negative)", () => {
		expect(slotBytes({ id: "neg", quant: "" }, states, null)).toBe(0);
	});

	test("returns scaled estimate for a real loaded entry", () => {
		const result = slotBytes({ id: "a", quant: "" }, states, null);
		// "" → fp32 baseline factor 4 / fp32 baseline 4 = 1x
		expect(result).toBe(1 * GB);
	});

	test("scales by quantization (fp16 → half the baseline)", () => {
		const result = slotBytes({ id: "a", quant: "fp16" }, states, null);
		// fp16 factor 2 / baseline 4 → 0.5x
		expect(result).toBe(Math.round(1 * GB * 0.5));
	});
});

describe("predictedTarget", () => {
	const { predictedTarget } = TEST_ONLY;

	test("returns 'neither' when host has no hardware", () => {
		const live = liveOf({ ram_total_bytes: 0, gpus: [] });
		expect(predictedTarget("", live, null)).toBe("neither");
	});

	test("returns 'cpu' when requestedDevice is 'cpu' (even on a GPU host)", () => {
		const live = liveOf({ gpus: [gpuOf()] });
		expect(predictedTarget("", live, "cpu")).toBe("cpu");
	});

	test("returns 'gpu' when GPU available and quant is GPU-compatible", () => {
		const live = liveOf({ gpus: [gpuOf()] });
		expect(predictedTarget("fp16", live, null)).toBe("gpu");
	});

	test("returns 'cpu' when quant is not GPU-compatible (e.g. int8)", () => {
		const live = liveOf({ gpus: [gpuOf()] });
		expect(predictedTarget("int8", live, null)).toBe("cpu");
	});

	test("returns 'cpu' when no GPUs but RAM exists and no device requested", () => {
		const live = liveOf({ ram_total_bytes: 32 * GB, gpus: [] });
		expect(predictedTarget("", live, null)).toBe("cpu");
	});
});
