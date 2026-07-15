import { describe, expect, test } from "bun:test";
import {
	type CommittedModel,
	computeBudgets,
	GPU_HEADROOM,
	largestGpuVram,
	RAM_USABLE_FRACTION,
} from "./memory-budget";

const GB = 1024 ** 3;

const SYS = { totalRamBytes: 32 * GB, largestGpuVramBytes: 12 * GB };
const BASE_RAM = Math.floor(32 * GB * RAM_USABLE_FRACTION);
const BASE_VRAM = Math.floor((12 * GB) / GPU_HEADROOM);

/** ~310 MB — the fixed CPU-only encoder dictionary footprint. */
const DICT_BYTES = 310 * 1024 * 1024;

describe("computeBudgets", () => {
	test("no committed models: base pools with the existing headroom constants", () => {
		const budgets = computeBudgets(SYS, [], "stt");
		expect(budgets.hasGpu).toBe(true);
		expect(budgets.ramBytes).toBe(BASE_RAM);
		expect(budgets.vramBytes).toBe(BASE_VRAM);
	});

	test("TTS + LLM enabled reduce the STT budget in the correct pools", () => {
		const committed: CommittedModel[] = [
			{ bytes: 1 * GB, device: "gpu", modality: "tts" },
			{ bytes: 5 * GB, device: "cpu", modality: "llm" }, // CPU-pinned LLM
		];
		const budgets = computeBudgets(SYS, committed, "stt");
		// CPU-pinned LLM reduces RAM, not VRAM.
		expect(budgets.ramBytes).toBe(BASE_RAM - 5 * GB);
		expect(budgets.vramBytes).toBe(BASE_VRAM - 1 * GB);
	});

	test("the picked modality is excluded from its own subtraction (swap semantics)", () => {
		const committed: CommittedModel[] = [
			{ bytes: 2 * GB, device: "gpu", modality: "stt" },
			{ bytes: 1 * GB, device: "gpu", modality: "tts" },
		];
		const budgets = computeBudgets(SYS, committed, "stt");
		expect(budgets.vramBytes).toBe(BASE_VRAM - 1 * GB);
		// Picking TTS instead: the STT footprint counts, the TTS one doesn't.
		const ttsBudgets = computeBudgets(SYS, committed, "tts");
		expect(ttsBudgets.vramBytes).toBe(BASE_VRAM - 2 * GB);
	});

	test("encoder dictionary reduces RAM only, never VRAM", () => {
		const budgets = computeBudgets(
			SYS,
			[{ bytes: DICT_BYTES, device: "cpu", modality: "dictionary" }],
			"stt",
		);
		expect(budgets.ramBytes).toBe(BASE_RAM - DICT_BYTES);
		expect(budgets.vramBytes).toBe(BASE_VRAM);
	});

	test("no GPU: vram budget is 0 and hasGpu is false", () => {
		const budgets = computeBudgets(
			{ totalRamBytes: 32 * GB, largestGpuVramBytes: 0 },
			[],
			"stt",
		);
		expect(budgets.hasGpu).toBe(false);
		expect(budgets.vramBytes).toBe(0);
	});

	test("disabled/cloud modalities contribute 0 (caller passes no entry)", () => {
		// A modality that is off or cloud-routed simply has no CommittedModel —
		// the budgets equal the base pools.
		const budgets = computeBudgets(SYS, [], "tts");
		expect(budgets.ramBytes).toBe(BASE_RAM);
		expect(budgets.vramBytes).toBe(BASE_VRAM);
	});

	test("budgets clamp at 0 when committed footprints exceed a pool", () => {
		const budgets = computeBudgets(
			SYS,
			[{ bytes: 64 * GB, device: "cpu", modality: "llm" }],
			"stt",
		);
		expect(budgets.ramBytes).toBe(0);
		expect(budgets.vramBytes).toBe(BASE_VRAM);
	});
});

describe("largestGpuVram", () => {
	test("iGPU + dGPU host: the largest GPU wins (never .all())", () => {
		expect(
			largestGpuVram([
				{ total_vram_bytes: 1 * GB }, // iGPU
				{ total_vram_bytes: 12 * GB }, // dGPU
			]),
		).toBe(12 * GB);
	});

	test("no GPUs: 0", () => {
		expect(largestGpuVram([])).toBe(0);
	});
});
