import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import {
	activeLatencyModel,
	backingModelIdForQuant,
	findDisplayModelByBackingId,
	latencyVariantsForModel,
	mergeStreamingLatencyModels,
	mergeStreamingLatencyStates,
	mergeStreamingPrecisionModels,
	mergeStreamingPrecisionStates,
	nativeStreamingLatencyMs,
} from "./streaming-precision-merge";

function model(id: string): ModelInfo {
	return {
		accuracyScore: 0.8,
		available: true,
		availableQuantizations: ["int8"],
		backend: "onnx_asr",
		description: "Native streaming test model",
		displayName: "Streaming Nemotron",
		errorMessage: "",
		family: "nemo",
		finalReuseSafe: true,
		id,
		languages: ["en"],
		localPath: null,
		nativeStreaming: true,
		onnxModelName: id,
		previewCapable: true,
		sizeBytesByQuantization: { int8: 123 },
		sizeLabel: "600M",
		speedScore: 0.8,
		supportsLanguageDetection: false,
		supportsRealtime: true,
	};
}

function state(id: string, cacheState: ModelStateEntry["cache"]["state"]) {
	return {
		available_quantizations: ["int8"],
		cache: {
			downloaded_bytes: cacheState === "cached" ? 1 : 0,
			progress: cacheState === "partial" ? 0.5 : 0,
			state: cacheState,
			total_bytes: 1,
		},
		cache_by_quantization: {
			int8: {
				downloaded_bytes: cacheState === "cached" ? 1 : 0,
				progress: cacheState === "partial" ? 0.5 : 0,
				state: cacheState,
				total_bytes: 1,
			},
		},
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		effective_quantization: "int8",
		estimated_bytes: 1,
		id,
	} satisfies ModelStateEntry;
}

describe("streaming latency model merge", () => {
	test("keeps native streaming latency parsed from ids", () => {
		expect(
			nativeStreamingLatencyMs(model("streaming-nemotron-en-80ms-int8")),
		).toBe(80);
		expect(
			nativeStreamingLatencyMs(model("streaming-nemotron-en-1120ms-int8")),
		).toBe(1120);
	});

	test("groups latency variants behind one display card", () => {
		const precision = mergeStreamingPrecisionModels([
			model("streaming-nemotron-en-80ms-int8"),
			model("streaming-nemotron-en-160ms-int8"),
			model("streaming-nemotron-en-560ms-int8"),
			model("streaming-nemotron-en-1120ms-int8"),
		]);
		const merged = mergeStreamingLatencyModels(precision);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.id).toBe("streaming-nemotron-en-1120ms-int8");
		expect(
			latencyVariantsForModel(merged[0] ?? model("missing")).map(
				(v) => v.latencyMs,
			),
		).toEqual([80, 160, 560, 1120]);
	});

	test("routes selected low-latency backing ids to the grouped card", () => {
		const [grouped] = mergeStreamingLatencyModels(
			mergeStreamingPrecisionModels([
				model("streaming-nemotron-en-80ms-int8"),
				model("streaming-nemotron-en-1120ms-int8"),
			]),
		);
		if (!grouped) {
			throw new Error("group did not render");
		}

		expect(
			findDisplayModelByBackingId([grouped], "streaming-nemotron-en-80ms-int8")
				?.id,
		).toBe("streaming-nemotron-en-1120ms-int8");
		expect(
			activeLatencyModel(grouped, "streaming-nemotron-en-80ms-int8").id,
		).toBe("streaming-nemotron-en-80ms-int8");
		expect(
			backingModelIdForQuant(
				grouped,
				"int8",
				"streaming-nemotron-en-80ms-int8",
			),
		).toBe("streaming-nemotron-en-80ms-int8");
	});

	test("merged latency cache is cached when any latency variant is cached", () => {
		const precision = mergeStreamingPrecisionModels([
			model("streaming-nemotron-en-80ms-int8"),
			model("streaming-nemotron-en-1120ms-int8"),
		]);
		const merged = mergeStreamingLatencyModels(precision);
		const precisionStates = mergeStreamingPrecisionStates(precision, {
			"streaming-nemotron-en-80ms-int8": state(
				"streaming-nemotron-en-80ms-int8",
				"cached",
			),
			"streaming-nemotron-en-1120ms-int8": state(
				"streaming-nemotron-en-1120ms-int8",
				"not_cached",
			),
		});
		const latencyStates = mergeStreamingLatencyStates(merged, precisionStates);

		expect(
			latencyStates["streaming-nemotron-en-1120ms-int8"]?.cache.state,
		).toBe("cached");
	});
});
