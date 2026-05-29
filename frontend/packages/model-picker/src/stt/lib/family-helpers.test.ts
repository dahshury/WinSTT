import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import {
	bundleVariants,
	type FamilyKey,
	getFamilyConfig,
	groupByFamily,
	parseParameterSize,
	variantDisplayName,
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

	test("includes the SenseVoice family (the only Handy family WinSTT was missing)", () => {
		const cfg = getFamilyConfig("sense_voice");
		expect(cfg.label).toBe("SenseVoice");
		expect(cfg.icon).toBeDefined();
		// FunAudioLLM (Alibaba) brand logo bundled under public/provider-icons/.
		expect(cfg.logoSrc).toBe("/provider-icons/funaudiollm.png");
	});

	test("includes the Dolphin family with the DataoceanAI brand logo", () => {
		const cfg = getFamilyConfig("dolphin");
		expect(cfg.label).toBe("Dolphin");
		expect(cfg.icon).toBeDefined();
		expect(cfg.logoSrc).toBe("/provider-icons/dataoceanai.png");
	});
});

describe("SenseVoice family bundling", () => {
	test("SenseVoice models group into their own family card", () => {
		const grouped = groupByFamily([
			model("sense-voice-small", "sense_voice", "234M"),
			model("tiny", "whisper", "39M"),
		]);
		const families = grouped.map(([fam]) => fam);
		expect(families).toContain("sense_voice");
		expect(families).toContain("whisper");
	});

	test("SenseVoice singleton bundles cleanly (one variant, one card)", () => {
		const bundles = bundleVariants([model("sense-voice-small", "sense_voice", "234M")]);
		expect(bundles).toHaveLength(1);
		expect(bundles[0]?.baseId).toBe("sense-voice-small");
		expect(bundles[0]?.variants).toHaveLength(1);
	});
});

describe("variantDisplayName", () => {
	function named(displayName: string, family: FamilyKey): ModelInfo {
		return { ...model("id", family), displayName };
	}

	test("strips the redundant parameter-count token from the name", () => {
		expect(variantDisplayName(named("NeMo Canary 180M Flash", "nemo"))).toBe("Canary Flash");
		expect(variantDisplayName(named("NeMo Canary 1B v2", "nemo"))).toBe("Canary v2");
		expect(variantDisplayName(named("NeMo Parakeet CTC 0.6B", "nemo"))).toBe("Parakeet CTC");
		// Token mid-name leaves no double space behind.
		expect(variantDisplayName(named("NeMo Parakeet TDT 0.6B v3", "nemo"))).toBe("Parakeet TDT v3");
	});

	test("strips the leading family label (the chip already conveys it)", () => {
		expect(variantDisplayName(named("Whisper Large v3", "whisper"))).toBe("Large v3");
		expect(variantDisplayName(named("Lite-Whisper Large v3 Turbo", "lite-whisper"))).toBe(
			"Large v3 Turbo"
		);
	});

	test("leaves version tokens and product numbers without an M/B suffix intact", () => {
		// "v3" / "25" are not parameter counts — they must survive.
		expect(variantDisplayName(named("GigaAM v3 E2E CTC", "gigaam"))).toBe("v3 E2E CTC");
		expect(variantDisplayName(named("Breeze ASR 25", "whisper"))).toBe("Breeze ASR 25");
	});

	test("keeps language / flavour qualifiers", () => {
		expect(variantDisplayName(named("Whisper Tiny (EN)", "whisper"))).toBe("Tiny (EN)");
		expect(
			variantDisplayName(named("Lite-Whisper Large v3 Turbo (Accelerated)", "lite-whisper"))
		).toBe("Large v3 Turbo (Accelerated)");
	});

	test("falls back to the raw name if stripping would empty it", () => {
		// Pathological: name is nothing but the family label + a size token.
		expect(variantDisplayName(named("Whisper 39M", "whisper"))).toBe("Whisper 39M");
	});

	test("keeps the size token when dropping it would collide with a peer", () => {
		const flash180 = {
			...model("nemo-canary-180m-flash", "nemo"),
			displayName: "NeMo Canary 180M Flash",
		};
		const flash1b = {
			...model("nemo-canary-1b-flash", "nemo"),
			displayName: "NeMo Canary 1B Flash",
		};
		const v2 = { ...model("nemo-canary-1b-v2", "nemo"), displayName: "NeMo Canary 1B v2" };
		const peers = [flash180, flash1b, v2];
		// Both flashes collapse to "Canary Flash" → each keeps its size to disambiguate.
		expect(variantDisplayName(flash180, peers)).toBe("Canary 180M Flash");
		expect(variantDisplayName(flash1b, peers)).toBe("Canary 1B Flash");
		// v2 has no same-name collision → size still stripped.
		expect(variantDisplayName(v2, peers)).toBe("Canary v2");
		// Without peers (collision unknown) the size is always stripped.
		expect(variantDisplayName(flash180)).toBe("Canary Flash");
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
