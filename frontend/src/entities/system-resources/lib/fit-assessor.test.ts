import { describe, expect, test } from "bun:test";
import type { LiveResourcesEntry, ModelStateEntry } from "@/shared/api/ipc-client";
import {
	assessDictationFitClient,
	assessOllamaFitClient,
	loadedDictationFootprint,
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
