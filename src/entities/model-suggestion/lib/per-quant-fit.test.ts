import { describe, expect, test } from "bun:test";
import type { MemoryBudgets } from "./memory-budget";
import {
	fittingQuantSet,
	ollamaQuantCandidate,
	quantFits,
	resolveQuantDevice,
	sttQuantCandidates,
	TTS_RUNTIME_HEADROOM,
	ttsQuantCandidates,
} from "./per-quant-fit";

const GB = 1024 ** 3;

function budgetsOf(opts: Partial<MemoryBudgets> = {}): MemoryBudgets {
	return {
		hasGpu: true,
		ramBytes: 16 * GB,
		vramBytes: 8 * GB,
		...opts,
	};
}

describe("quantFits", () => {
	test("gpu-routed quants are judged against VRAM only", () => {
		const budgets = budgetsOf({ vramBytes: 4 * GB, ramBytes: 32 * GB });
		expect(quantFits(6 * GB, "gpu", budgets)).toBe(false);
		expect(quantFits(3 * GB, "gpu", budgets)).toBe(true);
	});

	test("cpu-routed quants are judged against RAM only — never VRAM, even on GPU hosts", () => {
		const budgets = budgetsOf({ vramBytes: 24 * GB, ramBytes: 4 * GB });
		expect(quantFits(6 * GB, "cpu", budgets)).toBe(false);
		expect(quantFits(3 * GB, "cpu", budgets)).toBe(true);
	});

	test("either-pool (Ollama): fits when RAM covers it even though VRAM does not", () => {
		const budgets = budgetsOf({ vramBytes: 4 * GB, ramBytes: 40 * GB });
		expect(quantFits(20 * GB, "either", budgets)).toBe(true);
	});

	test("either-pool without a GPU falls back to RAM alone", () => {
		const budgets = budgetsOf({
			hasGpu: false,
			vramBytes: 0,
			ramBytes: 8 * GB,
		});
		expect(quantFits(6 * GB, "either", budgets)).toBe(true);
		expect(quantFits(10 * GB, "either", budgets)).toBe(false);
	});

	test("unknown footprint (<= 0 bytes) is lenient: fits", () => {
		const budgets = budgetsOf({ ramBytes: 0, vramBytes: 0, hasGpu: false });
		expect(quantFits(0, "cpu", budgets)).toBe(true);
		expect(quantFits(-1, "gpu", budgets)).toBe(true);
	});
});

describe("resolveQuantDevice", () => {
	test("heuristic fallback: GPU-compatible quants route to GPU when one exists", () => {
		expect(resolveQuantDevice("", { hasGpu: true })).toBe("gpu");
		expect(resolveQuantDevice("fp16", { hasGpu: true })).toBe("gpu");
		expect(resolveQuantDevice("fp16w", { hasGpu: true })).toBe("gpu");
	});

	test("heuristic fallback: int8/q4 quants are CPU-routed even on GPU hosts", () => {
		expect(resolveQuantDevice("int8", { hasGpu: true })).toBe("cpu");
		expect(resolveQuantDevice("q4", { hasGpu: true })).toBe("cpu");
	});

	test("heuristic fallback: everything is CPU without a GPU", () => {
		expect(resolveQuantDevice("fp16", { hasGpu: false })).toBe("cpu");
	});

	test("server pin matrix wins over the heuristic when present", () => {
		// CPU-pinned engine (e.g. CohereAsr): fp16 runs on CPU despite the GPU.
		expect(
			resolveQuantDevice("fp16", {
				hasGpu: true,
				deviceByQuantization: { fp16: "cpu" },
			}),
		).toBe("cpu");
	});

	test("unknown map values fall back to the heuristic", () => {
		expect(
			resolveQuantDevice("fp16", {
				hasGpu: true,
				deviceByQuantization: { fp16: "npu" },
			}),
		).toBe("gpu");
	});
});

describe("sttQuantCandidates", () => {
	test("headline bug fixed: unfit at fp32 but fit at int8 -> int8-only fitting set", () => {
		// 4 GB fp32 baseline: fp32 needs 4 GB VRAM (> 2 GB), int8 needs
		// 4 GB x (1.2/4) = 1.2 GB RAM (< 8 GB).
		const candidates = sttQuantCandidates({
			estimatedBytes: 4 * GB,
			availableQuantizations: ["", "int8"],
			hasGpu: true,
		});
		const budgets = budgetsOf({ vramBytes: 2 * GB, ramBytes: 8 * GB });
		const fitting = fittingQuantSet(candidates, budgets);
		expect(fitting.has("")).toBe(false);
		expect(fitting.has("int8")).toBe(true);
		expect(fitting.size).toBe(1);
	});

	test("int8 is never budgeted against VRAM even on GPU hosts", () => {
		const candidates = sttQuantCandidates({
			estimatedBytes: 4 * GB,
			availableQuantizations: ["int8"],
			hasGpu: true,
		});
		expect(candidates[0]?.device).toBe("cpu");
		// Huge VRAM, tiny RAM: the int8 candidate must NOT fit.
		const budgets = budgetsOf({ vramBytes: 48 * GB, ramBytes: 1 * GB });
		expect(fittingQuantSet(candidates, budgets).has("int8")).toBe(false);
	});

	test("unknown estimated_bytes (<= 0): lenient, all quants fit", () => {
		const candidates = sttQuantCandidates({
			estimatedBytes: 0,
			availableQuantizations: ["", "int8", "fp16"],
			hasGpu: true,
		});
		const budgets = budgetsOf({ vramBytes: 0, ramBytes: 0, hasGpu: false });
		expect(fittingQuantSet(candidates, budgets).size).toBe(3);
	});

	test("device_by_quantization absent (older server) uses the heuristic path", () => {
		const candidates = sttQuantCandidates({
			estimatedBytes: 1 * GB,
			availableQuantizations: ["", "fp16", "int8"],
			hasGpu: true,
		});
		expect(candidates.map((c) => c.device)).toEqual(["gpu", "gpu", "cpu"]);
	});

	test("device_by_quantization present pins CPU-only engines to RAM", () => {
		const candidates = sttQuantCandidates({
			estimatedBytes: 1 * GB,
			availableQuantizations: ["", "fp16"],
			hasGpu: true,
			deviceByQuantization: { "": "cpu", fp16: "cpu" },
		});
		expect(candidates.every((c) => c.device === "cpu")).toBe(true);
	});
});

describe("ttsQuantCandidates", () => {
	test("bytes = disk size x runtime headroom, routed to the accelerator device", () => {
		const candidates = ttsQuantCandidates({
			sizeBytesByQuantization: { "": 2 * GB },
			availableQuantizations: [""],
			device: "gpu",
		});
		expect(candidates[0]?.bytes).toBe(
			Math.round(2 * GB * TTS_RUNTIME_HEADROOM),
		);
		expect(candidates[0]?.device).toBe("gpu");
	});

	test("missing size entry stays unknown (lenient zero bytes)", () => {
		const candidates = ttsQuantCandidates({
			sizeBytesByQuantization: {},
			availableQuantizations: ["int8"],
			device: "cpu",
		});
		expect(candidates[0]?.bytes).toBe(0);
	});
});

describe("ollamaQuantCandidate", () => {
	test("applies the GGUF runtime headroom formula and either-pool rule", () => {
		const candidate = ollamaQuantCandidate("Q4_K_M", 5 * GB);
		expect(candidate.device).toBe("either");
		expect(candidate.bytes).toBe(Math.round(5 * GB * 1.2 + 1_000_000_000));
	});

	test("zero-size tag stays lenient: fits any budget", () => {
		const candidate = ollamaQuantCandidate("latest", 0);
		expect(candidate.bytes).toBe(0);
		const budgets = budgetsOf({ ramBytes: 0, vramBytes: 0, hasGpu: false });
		expect(quantFits(candidate.bytes, candidate.device, budgets)).toBe(true);
	});
});
