import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import { type FamilyKey, getFamilyConfig, groupByFamily } from "./family-helpers";

function model(id: string, family: FamilyKey): ModelInfo {
	return {
		id,
		displayName: id,
		family,
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
	} as ModelInfo;
}

describe("getFamilyConfig", () => {
	test("returns the canonical label/chip for each family", () => {
		expect(getFamilyConfig("whisper").label).toBe("Whisper");
		expect(getFamilyConfig("nemo").label).toBe("NeMo");
		expect(getFamilyConfig("gigaam").label).toBe("GigaAM");
		expect(getFamilyConfig("kaldi").label).toBe("Kaldi");
		expect(getFamilyConfig("t-one").label).toBe("T-One");
		expect(getFamilyConfig("whisper").icon).toBeDefined();
	});
});

describe("groupByFamily", () => {
	test("returns an empty array for no models", () => {
		expect(groupByFamily([])).toEqual([]);
	});

	test("orders families canonically (whisper first), skipping empty ones", () => {
		const grouped = groupByFamily([
			model("n1", "nemo"),
			model("w1", "whisper"),
			model("t1", "t-one"),
			model("w2", "whisper"),
		]);
		expect(grouped.map(([fam]) => fam)).toEqual(["whisper", "nemo", "t-one"]);
		expect(grouped[0]?.[1].map((m) => m.id)).toEqual(["w1", "w2"]);
		expect(grouped[1]?.[1].map((m) => m.id)).toEqual(["n1"]);
	});

	test("includes every family when all are present", () => {
		const grouped = groupByFamily([
			model("a", "whisper"),
			model("b", "nemo"),
			model("c", "gigaam"),
			model("d", "kaldi"),
			model("e", "t-one"),
		]);
		expect(grouped.map(([fam]) => fam)).toEqual(["whisper", "nemo", "gigaam", "kaldi", "t-one"]);
	});
});
