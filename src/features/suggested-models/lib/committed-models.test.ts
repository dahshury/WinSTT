import { describe, expect, test } from "bun:test";
import { ollamaRequiredRuntimeBytes } from "@/entities/llm-catalog";
import {
	computeBudgets,
	GPU_HEADROOM,
	RAM_USABLE_FRACTION,
} from "@/entities/model-suggestion";
import { ENCODER_DICT_MODEL_BYTES } from "@/entities/system-resources";
import type {
	ModelStateEntry,
	OllamaModel,
	TtsModelStateEntry,
} from "@/shared/api/ipc-client";
import {
	buildCommittedModels,
	type CommittedModelsInput,
	findOllamaModel,
} from "./committed-models";

const GIB = 1024 ** 3;

function state(overrides: Partial<ModelStateEntry> = {}): ModelStateEntry {
	return {
		id: "m",
		estimated_bytes: 0,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		available_quantizations: [""],
		cache_by_quantization: {},
		cache: {
			state: "cached",
			downloaded_bytes: 0,
			progress: 0,
			total_bytes: 0,
		},
		...overrides,
	};
}

function ttsState(
	overrides: Partial<TtsModelStateEntry> = {},
): TtsModelStateEntry {
	return {
		id: "kokoro-82m",
		estimatedBytes: 0,
		effectiveQuantization: "",
		cacheByQuantization: {},
		...overrides,
	};
}

function baseInput(
	overrides: Partial<CommittedModelsInput> = {},
): CommittedModelsInput {
	return {
		hasGpu: true,
		isGpuAccelerator: true,
		mainModelId: null,
		realtimeModelId: null,
		sttQuant: "auto",
		getSttState: () => undefined,
		tts: { enabled: false, source: "local", modelId: "" },
		getTtsState: () => undefined,
		getTtsModel: () => undefined,
		encoderDictEnabled: false,
		llmCleanup: { enabled: false, provider: "ollama", model: "" },
		getOllamaModel: () => undefined,
		...overrides,
	};
}

describe("buildCommittedModels — STT", () => {
	test("main slot: bytes scaled to the effective quant, pool from the server pin matrix", () => {
		const models = buildCommittedModels(
			baseInput({
				mainModelId: "cohere",
				// fp32 baseline 4 bytes/param; int8 = 1.2 → 30% of 4000.
				getSttState: () =>
					state({
						estimated_bytes: 4000,
						effective_quantization: "int8",
						device_by_quantization: { int8: "cpu" },
					}),
			}),
		);
		expect(models).toEqual([{ bytes: 1200, device: "cpu", modality: "stt" }]);
	});

	test("heuristic fallback (no pin matrix): GPU-compatible quant → VRAM on GPU hosts, RAM otherwise", () => {
		const gpuFp16 = baseInput({
			mainModelId: "whisper",
			getSttState: () =>
				state({ estimated_bytes: 4000, effective_quantization: "fp16" }),
		});
		expect(buildCommittedModels(gpuFp16)[0]?.device).toBe("gpu");
		expect(buildCommittedModels({ ...gpuFp16, hasGpu: false })[0]?.device).toBe(
			"cpu",
		);

		// int8 is never GPU-routable — RAM even on GPU hosts.
		const gpuInt8 = baseInput({
			mainModelId: "whisper",
			getSttState: () =>
				state({ estimated_bytes: 4000, effective_quantization: "int8" }),
		});
		expect(buildCommittedModels(gpuInt8)[0]?.device).toBe("cpu");
	});

	test("counts the realtime slot only when it's a distinct model", () => {
		const shared = baseInput({
			mainModelId: "whisper",
			realtimeModelId: "whisper",
			getSttState: () => state({ estimated_bytes: 4000 }),
		});
		expect(buildCommittedModels(shared)).toHaveLength(1);

		const distinct = buildCommittedModels({
			...shared,
			realtimeModelId: "moonshine",
		});
		expect(distinct).toHaveLength(2);
		expect(distinct.every((m) => m.modality === "stt")).toBe(true);
	});

	test("cloud STT ids and unknown estimates contribute nothing", () => {
		expect(
			buildCommittedModels(
				baseInput({ mainModelId: "openrouter:openai/whisper-1" }),
			),
		).toEqual([]);
		expect(
			buildCommittedModels(
				baseInput({
					mainModelId: "whisper",
					getSttState: () => state({ estimated_bytes: 0 }),
				}),
			),
		).toEqual([]);
	});
});

describe("buildCommittedModels — TTS", () => {
	const enabledTts = { enabled: true, source: "local" as const, modelId: "k" };

	test("uses the runtime estimate, routed to the accelerator's pool", () => {
		const models = buildCommittedModels(
			baseInput({
				tts: enabledTts,
				getTtsState: () => ttsState({ estimatedBytes: 200_000_000 }),
			}),
		);
		expect(models).toEqual([
			{ bytes: 200_000_000, device: "gpu", modality: "tts" },
		]);
	});

	test("CPU accelerator routes the footprint to RAM", () => {
		const models = buildCommittedModels(
			baseInput({
				isGpuAccelerator: false,
				tts: enabledTts,
				getTtsState: () => ttsState({ estimatedBytes: 200_000_000 }),
			}),
		);
		expect(models[0]?.device).toBe("cpu");
	});

	test("falls back to the catalog size at the effective quant, then fp32, then any entry", () => {
		const input = baseInput({
			tts: enabledTts,
			getTtsState: () => ttsState({ effectiveQuantization: "int8" }),
			getTtsModel: () => ({
				sizeBytesByQuantization: { int8: 90_000_000, "": 190_000_000 },
			}),
		});
		expect(buildCommittedModels(input)[0]?.bytes).toBe(90_000_000);

		const noQuantMatch = {
			...input,
			getTtsState: () => ttsState({ effectiveQuantization: "fp16" }),
		};
		expect(buildCommittedModels(noQuantMatch)[0]?.bytes).toBe(190_000_000);
	});

	test("disabled, cloud-sourced, or unsized TTS contributes nothing", () => {
		expect(buildCommittedModels(baseInput())).toEqual([]);
		expect(
			buildCommittedModels(
				baseInput({ tts: { ...enabledTts, source: "cloud" } }),
			),
		).toEqual([]);
		expect(buildCommittedModels(baseInput({ tts: enabledTts }))).toEqual([]);
	});
});

describe("buildCommittedModels — cleanup LLM", () => {
	const enabledLlm = {
		enabled: true,
		provider: "ollama",
		model: "llama3.1:8b",
	};
	const installed: OllamaModel = { name: "llama3.1:8b", size: 4_700_000_000 };

	test("installed Ollama model costs GGUF size plus the shared runtime headroom", () => {
		const models = buildCommittedModels(
			baseInput({
				llmCleanup: enabledLlm,
				getOllamaModel: (name) =>
					name === installed.name ? installed : undefined,
			}),
		);
		expect(models).toEqual([
			{
				bytes: ollamaRequiredRuntimeBytes(4_700_000_000),
				device: "gpu",
				modality: "llm",
			},
		]);
	});

	test("no GPU routes Ollama to RAM", () => {
		const models = buildCommittedModels(
			baseInput({
				hasGpu: false,
				llmCleanup: enabledLlm,
				getOllamaModel: () => installed,
			}),
		);
		expect(models[0]?.device).toBe("cpu");
	});

	test("disabled, non-Ollama provider, or unknown size contributes nothing", () => {
		expect(
			buildCommittedModels(
				baseInput({
					llmCleanup: { ...enabledLlm, enabled: false },
					getOllamaModel: () => installed,
				}),
			),
		).toEqual([]);
		expect(
			buildCommittedModels(
				baseInput({
					llmCleanup: { ...enabledLlm, provider: "openrouter" },
					getOllamaModel: () => installed,
				}),
			),
		).toEqual([]);
		expect(buildCommittedModels(baseInput({ llmCleanup: enabledLlm }))).toEqual(
			[],
		);
	});
});

describe("buildCommittedModels — encoder dictionary", () => {
	test("enabled dictionary is the fixed shared constant, CPU-only", () => {
		const models = buildCommittedModels(
			baseInput({ encoderDictEnabled: true }),
		);
		expect(models).toEqual([
			{
				bytes: ENCODER_DICT_MODEL_BYTES,
				device: "cpu",
				modality: "dictionary",
			},
		]);
	});
});

describe("committed models × computeBudgets (memory-budget integration)", () => {
	const sys = { totalRamBytes: 32 * GIB, largestGpuVramBytes: 12 * GIB };
	const baseRam = Math.floor(sys.totalRamBytes * RAM_USABLE_FRACTION);
	const baseVram = Math.floor(sys.largestGpuVramBytes / GPU_HEADROOM);
	const installedSize = 4_000_000_000;
	const installed: OllamaModel = { name: "llama3.1:8b", size: installedSize };

	function fullHouse(overrides: Partial<CommittedModelsInput> = {}) {
		return buildCommittedModels(
			baseInput({
				mainModelId: "whisper",
				getSttState: () =>
					state({ estimated_bytes: 1 * GIB, effective_quantization: "fp16" }),
				tts: { enabled: true, source: "local", modelId: "k" },
				getTtsState: () => ttsState({ estimatedBytes: 300_000_000 }),
				encoderDictEnabled: true,
				llmCleanup: {
					enabled: true,
					provider: "ollama",
					model: installed.name,
				},
				getOllamaModel: () => installed,
				...overrides,
			}),
		);
	}

	test("TTS + LLM enabled reduce the STT budget in the correct pools", () => {
		const budgets = computeBudgets(sys, fullHouse(), "stt");
		// TTS (GPU accelerator) and Ollama (GPU present) both land in VRAM;
		// the encoder dictionary lands in RAM. The STT slot itself is excluded.
		const llmBytes = ollamaRequiredRuntimeBytes(installedSize);
		expect(budgets.vramBytes).toBe(baseVram - 300_000_000 - llmBytes);
		expect(budgets.ramBytes).toBe(baseRam - ENCODER_DICT_MODEL_BYTES);
	});

	test("CPU-routed LLM reduces RAM, not VRAM", () => {
		const committed = fullHouse({
			hasGpu: false,
			isGpuAccelerator: false,
			getSttState: () =>
				state({ estimated_bytes: 1 * GIB, effective_quantization: "int8" }),
		});
		const budgets = computeBudgets(
			{ ...sys, largestGpuVramBytes: 0 },
			committed,
			"stt",
		);
		expect(budgets.vramBytes).toBe(0);
		expect(budgets.ramBytes).toBe(
			baseRam -
				300_000_000 -
				ollamaRequiredRuntimeBytes(installedSize) -
				ENCODER_DICT_MODEL_BYTES,
		);
	});

	test("the picked modality is excluded from its own subtraction (swap semantics)", () => {
		const committed = fullHouse({
			realtimeModelId: "moonshine",
		});
		// Picking STT: neither the main nor the realtime slot shrinks the pools —
		// only the other modalities (TTS + LLM in VRAM) do.
		const sttBudgets = computeBudgets(sys, committed, "stt");
		const sttEstimate = Math.round(1 * GIB * (2 / 4)); // fp16 = half of fp32.
		expect(sttBudgets.vramBytes).toBe(
			baseVram - 300_000_000 - ollamaRequiredRuntimeBytes(installedSize),
		);
		// Picking TTS: STT slots DO count, the TTS slot doesn't.
		const ttsBudgets = computeBudgets(sys, committed, "tts");
		expect(ttsBudgets.vramBytes).toBe(
			baseVram - sttEstimate * 2 - ollamaRequiredRuntimeBytes(installedSize),
		);
	});

	test("encoder dictionary subtracts 310 MB from RAM only, never VRAM", () => {
		const committed = buildCommittedModels(
			baseInput({ encoderDictEnabled: true }),
		);
		const budgets = computeBudgets(sys, committed, "stt");
		expect(budgets.ramBytes).toBe(baseRam - 310 * 1024 * 1024);
		expect(budgets.vramBytes).toBe(baseVram);
	});

	test("disabled / cloud modalities contribute 0 — budgets equal the base pools", () => {
		const committed = buildCommittedModels(
			baseInput({
				mainModelId: "elevenlabs:scribe_v1",
				tts: { enabled: true, source: "cloud", modelId: "eleven" },
				llmCleanup: { enabled: true, provider: "openrouter", model: "" },
			}),
		);
		expect(committed).toEqual([]);
		const budgets = computeBudgets(sys, committed, "stt");
		expect(budgets.ramBytes).toBe(baseRam);
		expect(budgets.vramBytes).toBe(baseVram);
	});
});

describe("findOllamaModel", () => {
	const models: OllamaModel[] = [
		{ name: "llama3.1:8b", size: 1 },
		{ name: "qwen3:latest", size: 2 },
	];

	test("matches exactly and tolerates an implicit :latest on either side", () => {
		expect(findOllamaModel(models, "llama3.1:8b")?.size).toBe(1);
		expect(findOllamaModel(models, "qwen3")?.size).toBe(2);
		expect(
			findOllamaModel([{ name: "qwen3", size: 3 }], "qwen3:latest")?.size,
		).toBe(3);
	});

	test("empty name never matches", () => {
		expect(findOllamaModel(models, "")).toBeUndefined();
	});
});
