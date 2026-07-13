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

	test("groups nemotron-3.5-multi latency rows behind one card", () => {
		const merged = mergeStreamingLatencyModels(
			mergeStreamingPrecisionModels([
				model("streaming-nemotron-3.5-multi-240ms-int8"),
				model("streaming-nemotron-3.5-multi-560ms-int8"),
				model("streaming-nemotron-3.5-multi-1120ms-int8"),
			]),
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.id).toBe("streaming-nemotron-3.5-multi-1120ms-int8");
		expect(
			latencyVariantsForModel(merged[0] ?? model("missing")).map(
				(v) => v.latencyMs,
			),
		).toEqual([240, 560, 1120]);
	});

	test("collapses same-latency fp32/fp16 + int8 rows into ONE latency chip", () => {
		// Parakeet-unified ships a fp32+fp16 repo (`-1120ms`) and a SEPARATE int8 repo
		// (`-1120ms-int8`). The precision-merge can't fuse them (the fp32 row already has two
		// precisions), so without the same-latency collapse the shelf showed two 1.12 s chips.
		const fp32fp16: ModelInfo = {
			...model("streaming-parakeet-unified-en-1120ms"),
			displayName: "Streaming Parakeet Unified",
			availableQuantizations: ["", "fp16"],
			sizeBytesByQuantization: { "": 1000, fp16: 500 },
		};
		const int8: ModelInfo = {
			...model("streaming-parakeet-unified-en-1120ms-int8"),
			displayName: "Streaming Parakeet Unified",
			availableQuantizations: ["int8"],
			sizeBytesByQuantization: { int8: 250 },
		};
		const [merged] = mergeStreamingLatencyModels([fp32fp16, int8]);
		const variants = latencyVariantsForModel(merged ?? model("missing"));

		// One 1120 ms chip — not two.
		expect(variants.map((v) => v.latencyMs)).toEqual([1120]);
		const v = variants[0]?.model ?? model("missing");
		// Its precision sub-shelf carries all three, each routed to its backing repo.
		expect(v.availableQuantizations).toEqual(["", "fp16", "int8"]);
		expect(backingModelIdForQuant(v, "")).toBe(
			"streaming-parakeet-unified-en-1120ms",
		);
		expect(backingModelIdForQuant(v, "fp16")).toBe(
			"streaming-parakeet-unified-en-1120ms",
		);
		expect(backingModelIdForQuant(v, "int8")).toBe(
			"streaming-parakeet-unified-en-1120ms-int8",
		);
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
