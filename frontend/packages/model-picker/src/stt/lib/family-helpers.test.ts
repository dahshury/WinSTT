import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import {
	bundleVariants,
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
});

describe("bundleVariants", () => {
	test("collapses .en sibling into its multilingual base", () => {
		const bundles = bundleVariants([model("tiny", "whisper"), model("tiny.en", "whisper")]);
		expect(bundles).toHaveLength(1);
		expect(bundles[0]?.baseId).toBe("tiny");
		expect(bundles[0]?.variants.map((m) => m.id)).toEqual(["tiny", "tiny.en"]);
	});

	test("collapses -turbo distillation into the base architecture bundle", () => {
		// Inputs are catalog-realistic: large-v3 (1.55B) + large-v3-turbo (809M).
		// Sort-key orders variants within the bundle so the canonical base lands first.
		const bundles = bundleVariants([
			model("large-v3-turbo", "whisper", "809M"),
			model("large-v3", "whisper", "1.55B"),
		]);
		expect(bundles).toHaveLength(1);
		expect(bundles[0]?.baseId).toBe("large-v3");
		expect(bundles[0]?.variants.map((m) => m.id)).toEqual(["large-v3", "large-v3-turbo"]);
	});

	test("collapses lite-whisper-* compressions into the base bundle even when bridged through -turbo", () => {
		const bundles = bundleVariants([
			model("large-v3", "whisper", "1.55B"),
			model("large-v3-turbo", "whisper", "809M"),
			model("lite-whisper-large-v3-turbo", "whisper", "534M"),
			model("lite-whisper-large-v3-turbo-acc", "whisper", "534M"),
			model("lite-whisper-large-v3-turbo-fast", "whisper", "534M"),
		]);
		expect(bundles).toHaveLength(1);
		expect(bundles[0]?.baseId).toBe("large-v3");
		expect(bundles[0]?.variants.map((m) => m.id)).toEqual([
			"large-v3",
			"large-v3-turbo",
			"lite-whisper-large-v3-turbo",
			"lite-whisper-large-v3-turbo-acc",
			"lite-whisper-large-v3-turbo-fast",
		]);
	});

	test("singletons stay as 1-item bundles", () => {
		const bundles = bundleVariants([model("medium", "whisper", "769M")]);
		expect(bundles).toHaveLength(1);
		expect(bundles[0]?.variants).toHaveLength(1);
	});

	test("NeMo Canary 1B-v2 and 180M-flash collapse into a single canary bundle (1B primary)", () => {
		// Input order mirrors family-sort (smallest-first), so flash appears
		// before 1B in the input. The bundle's variantSortKey still surfaces
		// 1B as the primary since it's the bigger / more capable variant.
		const bundles = bundleVariants([
			model("nemo-canary-180m-flash", "nemo", "180M"),
			model("nemo-canary-1b-v2", "nemo", "1B"),
		]);
		expect(bundles).toHaveLength(1);
		expect(bundles[0]?.baseId).toBe("nemo-canary");
		expect(bundles[0]?.variants.map((m) => m.id)).toEqual([
			"nemo-canary-1b-v2",
			"nemo-canary-180m-flash",
		]);
	});

	test("NeMo Parakeet CTC / RNN-T / TDT are SEPARATE cards (different decoders, not variants of one model)", () => {
		// CTC, RNN-T, and TDT are different decoder architectures. They
		// transcribe with materially different speed/accuracy tradeoffs and
		// must stay separately selectable — bundling them would hide that
		// choice behind a chevron the user has no way to interpret.
		const bundles = bundleVariants([
			model("nemo-parakeet-ctc-0.6b", "nemo", "600M"),
			model("nemo-parakeet-rnnt-0.6b", "nemo", "600M"),
			model("nemo-parakeet-tdt-0.6b-v3", "nemo", "600M"),
		]);
		expect(bundles).toHaveLength(3);
		expect(bundles.map((b) => b.baseId).sort()).toEqual([
			"nemo-parakeet-ctc-0.6b",
			"nemo-parakeet-rnnt-0.6b",
			"nemo-parakeet-tdt-0.6b-v3",
		]);
	});

	test("Moonshine tiny + language tunes (-zh / -ja / -ko) collapse, base + zh stay separate from tiny", () => {
		const bundles = bundleVariants([
			model("moonshine-tiny", "moonshine", "28M"),
			model("moonshine-tiny-zh", "moonshine", "28M"),
			model("moonshine-tiny-ja", "moonshine", "28M"),
			model("moonshine-base", "moonshine", "74M"),
			model("moonshine-base-zh", "moonshine", "74M"),
		]);
		expect(bundles).toHaveLength(2);
		expect(bundles[0]?.baseId).toBe("moonshine-tiny");
		expect(bundles[0]?.variants.map((m) => m.id)).toEqual([
			"moonshine-tiny", // id === baseId, sort key 0 → primary
			"moonshine-tiny-zh",
			"moonshine-tiny-ja",
		]);
		expect(bundles[1]?.baseId).toBe("moonshine-base");
		expect(bundles[1]?.variants.map((m) => m.id)).toEqual(["moonshine-base", "moonshine-base-zh"]);
	});

	test("GigaAM ctc / rnnt / e2e variants stay as SEPARATE cards (different decoders)", () => {
		// Same rule as Parakeet: CTC vs RNN-T vs e2e are different decoder
		// architectures, not variants of one base model.
		const bundles = bundleVariants([
			model("gigaam-v3-ctc", "gigaam", "243M"),
			model("gigaam-v3-rnnt", "gigaam", "243M"),
			model("gigaam-v3-e2e-ctc", "gigaam", "243M"),
			model("gigaam-v3-e2e-rnnt", "gigaam", "243M"),
		]);
		expect(bundles).toHaveLength(4);
		expect(bundles.map((b) => b.baseId).sort()).toEqual([
			"gigaam-v3-ctc",
			"gigaam-v3-e2e-ctc",
			"gigaam-v3-e2e-rnnt",
			"gigaam-v3-rnnt",
		]);
	});
});
