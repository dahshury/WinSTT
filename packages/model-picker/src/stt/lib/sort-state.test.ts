import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import { sortSttModels } from "./sort-state";

const BASE: ModelInfo = {
	id: "base",
	displayName: "Base",
	backend: "onnx_asr",
	family: "whisper",
	languages: [],
	supportsLanguageDetection: true,
	sizeLabel: "39M",
	previewCapable: true,
	nativeStreaming: false,
	finalReuseSafe: false,
	supportsRealtime: true,
	onnxModelName: null,
	description: "",
	availableQuantizations: [""],
	sizeBytesByQuantization: {},
	available: true,
	errorMessage: "",
	localPath: null,
	speedScore: 0.5,
	accuracyScore: 0.5,
};

function model(overrides: Partial<ModelInfo>): ModelInfo {
	return { ...BASE, ...overrides };
}

const ids = (models: readonly ModelInfo[]): string[] => models.map((m) => m.id);

describe("sortSttModels", () => {
	it("sorts by speed, fastest (highest speedScore) first", () => {
		const models = [
			model({ id: "slow", speedScore: 0.2 }),
			model({ id: "fast", speedScore: 0.9 }),
			model({ id: "mid", speedScore: 0.5 }),
		];
		expect(ids(sortSttModels(models, "speed"))).toEqual([
			"fast",
			"mid",
			"slow",
		]);
	});

	it("sorts by accuracy, most accurate (highest accuracyScore) first", () => {
		const models = [
			model({ id: "low", accuracyScore: 0.1 }),
			model({ id: "high", accuracyScore: 0.95 }),
			model({ id: "mid", accuracyScore: 0.6 }),
		];
		expect(ids(sortSttModels(models, "accuracy"))).toEqual([
			"high",
			"mid",
			"low",
		]);
	});

	it("sorts by download size using the smallest published quant, smallest first", () => {
		const models = [
			model({ id: "big", sizeBytesByQuantization: { "": 900 } }),
			// min positive across quants is 100, not the larger fp32 entry
			model({ id: "small", sizeBytesByQuantization: { "": 500, int8: 100 } }),
			model({ id: "mid", sizeBytesByQuantization: { "": 400 } }),
		];
		expect(ids(sortSttModels(models, "size"))).toEqual(["small", "mid", "big"]);
	});

	it("sorts models with unknown size (empty/all-zero) to the end", () => {
		const models = [
			model({ id: "unknown", sizeBytesByQuantization: {} }),
			model({ id: "zeroes", sizeBytesByQuantization: { "": 0 } }),
			model({ id: "known", sizeBytesByQuantization: { "": 300 } }),
		];
		const sorted = ids(sortSttModels(models, "size"));
		expect(sorted[0]).toBe("known");
		expect(sorted.slice(1).sort()).toEqual(["unknown", "zeroes"]);
	});

	it("sorts by name A→Z, case-insensitively", () => {
		const models = [
			model({ id: "c", displayName: "cohere" }),
			model({ id: "a", displayName: "Apple" }),
			model({ id: "b", displayName: "balsa" }),
		];
		expect(ids(sortSttModels(models, "name"))).toEqual(["a", "b", "c"]);
	});

	it("breaks ties on every score key with an A→Z name compare", () => {
		const models = [
			model({ id: "z", displayName: "Zeta", speedScore: 0.7 }),
			model({ id: "a", displayName: "Alpha", speedScore: 0.7 }),
		];
		expect(ids(sortSttModels(models, "speed"))).toEqual(["a", "z"]);
	});

	it("never mutates the input array", () => {
		const models = [
			model({ id: "b", speedScore: 0.2 }),
			model({ id: "a", speedScore: 0.9 }),
		];
		const before = ids(models);
		sortSttModels(models, "speed");
		expect(ids(models)).toEqual(before);
	});
});
