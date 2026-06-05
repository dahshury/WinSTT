import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import {
	canDeleteSttQuant,
	resolveSttDeleteRecovery,
} from "./stt-quant-delete-policy";

const cached = {
	downloaded_bytes: 10,
	progress: 1,
	state: "cached",
	total_bytes: 10,
} as const;
const partial = {
	downloaded_bytes: 5,
	progress: 0.5,
	state: "partial",
	total_bytes: 10,
} as const;
const notCached = {
	downloaded_bytes: 0,
	progress: 0,
	state: "not_cached",
	total_bytes: 10,
} as const;

function model(
	id: string,
	family = "whisper",
	languages: readonly string[] = ["en"],
	nativeStreaming = false,
): ModelInfo {
	return {
		available: true,
		backend: "onnx_asr",
		displayName: id,
		family,
		id,
		languages: [...languages],
		nativeStreaming,
	} as ModelInfo;
}

function state(
	id: string,
	cache_by_quantization: ModelStateEntry["cache_by_quantization"],
	estimated_bytes = 100,
): ModelStateEntry {
	return {
		available_quantizations: Object.keys(cache_by_quantization),
		cache: Object.values(cache_by_quantization)[0] ?? notCached,
		cache_by_quantization,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		estimated_bytes,
		id,
	} as ModelStateEntry;
}

describe("canDeleteSttQuant", () => {
	test("allows discarding a partial download even when it is the only visible model", () => {
		const models = [model("tiny")];
		const statesById = { tiny: state("tiny", { int8: partial }) };
		expect(canDeleteSttQuant(models, statesById, "tiny", "int8")).toBe(true);
	});

	test("blocks deleting the last cached visible STT precision", () => {
		const models = [model("tiny")];
		const statesById = { tiny: state("tiny", { int8: cached }) };
		expect(canDeleteSttQuant(models, statesById, "tiny", "int8")).toBe(false);
	});
});

describe("resolveSttDeleteRecovery", () => {
	test("switches active main deletion to a cached similar model first", () => {
		const models = [
			model("nemo-current", "nemo"),
			model("whisper-cached", "whisper"),
			model("nemo-cached", "nemo"),
		];
		const statesById = {
			"nemo-current": state("nemo-current", { int8: cached }, 300),
			"whisper-cached": state("whisper-cached", { int8: cached }, 10),
			"nemo-cached": state("nemo-cached", { int8: cached }, 200),
		};
		expect(
			resolveSttDeleteRecovery({
				currentMainModel: "nemo-current",
				currentQuantization: "int8",
				modelId: "nemo-current",
				models,
				quantization: "int8",
				statesById,
			}).mainTarget,
		).toEqual({ modelId: "nemo-cached", quantization: "int8" });
	});

	test("keeps realtime recovery language-compatible with the main model", () => {
		const main = model("main-en", "whisper", ["en"]);
		const models = [
			main,
			model("rt-current", "nemo", ["en"], true),
			model("rt-ru", "nemo", ["ru"], true),
			model("rt-en", "nemo", ["en"], true),
		];
		const statesById = {
			"main-en": state("main-en", { int8: cached }, 100),
			"rt-current": state("rt-current", { int8: cached }, 200),
			"rt-ru": state("rt-ru", { int8: cached }, 10),
			"rt-en": state("rt-en", { int8: cached }, 50),
		};
		expect(
			resolveSttDeleteRecovery({
				currentMainModel: "main-en",
				currentQuantization: "int8",
				currentRealtimeModel: "rt-current",
				mainModelInfo: main,
				modelId: "rt-current",
				models,
				quantization: "int8",
				statesById,
			}).realtimeTarget,
		).toEqual({ modelId: "rt-en", quantization: "int8" });
	});
});
