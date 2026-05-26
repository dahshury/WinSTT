import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import {
	type FamilyKey,
	getFamilyConfig,
	groupByFamily,
	parseParameterSize,
} from "./family-helpers";

function model(id: string, family: FamilyKey, sizeLabel = "39M"): ModelInfo {
	return {
		id,
		displayName: id,
		family,
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel,
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		available: true,
		errorMessage: "",
		localPath: null,
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

	test("includes the custom family for user-provided ONNX bundles", () => {
		const cfg = getFamilyConfig("custom");
		expect(cfg.label).toBe("Custom");
		expect(cfg.icon).toBeDefined();
		// Custom drops are user-provided — no brand logo overrides the
		// HugeIcon fallback (the icon is what's rendered in the picker).
		expect(cfg.logoSrc).toBeUndefined();
	});
});

describe("parseParameterSize", () => {
	test("parses millions and billions", () => {
		expect(parseParameterSize("39M")).toBe(39_000_000);
		expect(parseParameterSize("1.5B")).toBe(1_500_000_000);
		expect(parseParameterSize("769M")).toBe(769_000_000);
		expect(parseParameterSize("1B")).toBe(1_000_000_000);
	});

	test("returns +Infinity for unparseable labels so they sort last", () => {
		expect(parseParameterSize("")).toBe(Number.POSITIVE_INFINITY);
		expect(parseParameterSize("unknown")).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("groupByFamily", () => {
	test("returns an empty array for no models", () => {
		expect(groupByFamily([])).toEqual([]);
	});

	test("sorts groups by smallest model in each, skipping empty families", () => {
		const grouped = groupByFamily([
			model("n1", "nemo", "600M"),
			model("w1", "whisper", "73M"),
			model("t1", "t-one", "72M"),
			model("w2", "whisper", "38M"),
		]);
		// whisper has the smallest model (38M tiny), t-one next (72M), nemo last (600M).
		expect(grouped.map(([fam]) => fam)).toEqual(["whisper", "t-one", "nemo"]);
		// Within each group: smallest-first.
		expect(grouped[0]?.[1].map((m) => m.id)).toEqual(["w2", "w1"]);
		expect(grouped[2]?.[1].map((m) => m.id)).toEqual(["n1"]);
	});

	test("sorts models within each family by parameter count ascending", () => {
		const grouped = groupByFamily([
			model("w-large", "whisper", "1.5B"),
			model("w-tiny", "whisper", "39M"),
			model("w-medium", "whisper", "769M"),
			model("w-small", "whisper", "244M"),
		]);
		expect(grouped[0]?.[1].map((m) => m.id)).toEqual(["w-tiny", "w-small", "w-medium", "w-large"]);
	});

	test("group order reflects each family's smallest-model entry point", () => {
		// Picks family-representative sizes drawn from the actual catalog so the
		// expected order matches what users will see in the picker.
		const grouped = groupByFamily([
			model("kaldi-small", "kaldi", "23M"),
			model("whisper-tiny", "whisper", "38M"),
			model("tone", "t-one", "72M"),
			model("nemo-fastconformer", "nemo", "109M"),
			model("gigaam-v2", "gigaam", "233M"),
			model("lite-fast", "lite-whisper", "474M"),
		]);
		expect(grouped.map(([fam]) => fam)).toEqual([
			"kaldi",
			"whisper",
			"t-one",
			"nemo",
			"gigaam",
			"lite-whisper",
		]);
	});

	test("custom family forms its own group when present", () => {
		const grouped = groupByFamily([
			model("custom-my-whisper", "custom", ""),
			model("whisper-tiny", "whisper", "38M"),
		]);
		const families = grouped.map(([fam]) => fam);
		expect(families).toContain("custom");
		expect(families).toContain("whisper");
	});
});
