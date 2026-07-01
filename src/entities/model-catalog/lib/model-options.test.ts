import { describe, expect, test } from "bun:test";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { ModelInfo } from "../model/catalog-store";
import {
	buildModelOpts,
	formatCacheBadge,
	hasEstimatedFootprint,
	hasGpu,
	isCanonicalRealtimeModel,
	isRescuedByGpu,
	isSelectableRealtimeModel,
	isUncomfortable,
	isVisibleSttModel,
	modelsHaveLanguageOverlap,
	needsModelFallback,
	pickCachedSttModel,
	pickDefaultSttModel,
	supportsTranslateToEnglish,
} from "./model-options";

const fixture: ModelInfo[] = [
	{
		id: "tiny",
		displayName: "Tiny",
		family: "whisper",
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		previewCapable: true,
		nativeStreaming: true,
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
	},
	{
		id: "large",
		displayName: "Large v3",
		family: "whisper",
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "1.5B",
		previewCapable: false,
		nativeStreaming: false,
		finalReuseSafe: false,
		supportsRealtime: false,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
	},
	{
		id: "nemo-en",
		displayName: "NeMo EN",
		family: "nemo",
		backend: "onnx_asr",
		languages: ["en"],
		supportsLanguageDetection: false,
		sizeLabel: "300M",
		previewCapable: true,
		nativeStreaming: true,
		finalReuseSafe: true,
		supportsRealtime: true,
		onnxModelName: "model.onnx",
		description: "",
		availableQuantizations: ["", "int8"],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
	},
];

function makeEntry(overrides: Partial<ModelStateEntry> = {}): ModelStateEntry {
	return {
		id: "tiny",
		estimated_bytes: 1_000_000,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		available_quantizations: [""],
		cache_by_quantization: {},
		cache: {
			state: "not_cached",
			downloaded_bytes: 0,
			progress: 0,
			total_bytes: 1_000_000,
		},
		...overrides,
	};
}

function makeSys(gpuCount = 0): SystemInfoEntry {
	return {
		total_ram_bytes: 16_000_000_000,
		gpus: Array.from({ length: gpuCount }, (_, i) => ({
			name: `GPU${i}`,
			total_vram_bytes: 8_000_000_000,
		})),
	};
}

describe("buildModelOpts", () => {
	test("groups models by family with the family label as a prefix", () => {
		const opts = buildModelOpts(fixture);
		const tinyOpt = opts.find((o) => o.id === "tiny");
		const nemoOpt = opts.find((o) => o.id === "nemo-en");
		expect(tinyOpt?.label).toBe("[Whisper] Tiny (39M)");
		expect(nemoOpt?.label).toBe("[NeMo] NeMo EN (300M)");
	});

	test("falls back to the family slug when no label is mapped", () => {
		const custom: ModelInfo[] = [
			{
				...fixture[0],
				id: "x",
				displayName: "X",
				family: "kaldi",
			} as ModelInfo,
		];
		const opts = buildModelOpts(custom);
		expect(opts[0]?.label).toBe("[Kaldi] X (39M)");
	});

	test("renders the canonical label for gigaam family", () => {
		// Locks down the FAMILY_LABELS["gigaam"] = "GigaAM" entry — mutating
		// to "" would label the model "[] X (39M)" instead of "[GigaAM] ...".
		const custom: ModelInfo[] = [
			{
				...fixture[0],
				id: "g",
				displayName: "G",
				family: "gigaam",
			} as ModelInfo,
		];
		expect(buildModelOpts(custom)[0]?.label).toBe("[GigaAM] G (39M)");
	});

	test("renders the canonical label for t-one family", () => {
		// Locks down FAMILY_LABELS["t-one"] = "T-One".
		const custom: ModelInfo[] = [
			{
				...fixture[0],
				id: "t",
				displayName: "T",
				family: "t-one",
			} as ModelInfo,
		];
		expect(buildModelOpts(custom)[0]?.label).toBe("[T-One] T (39M)");
	});

	test("returns an empty array for empty input", () => {
		expect(buildModelOpts([])).toEqual([]);
	});

	test("preserves all input models in the output (no filtering)", () => {
		expect(buildModelOpts(fixture)).toHaveLength(fixture.length);
	});

	test("appends a ✓ Downloaded badge when state lookup reports cached", () => {
		const ctx = {
			statesById: {
				tiny: makeEntry({ cache: { ...makeEntry().cache, state: "cached" } }),
			},
			systemInfo: null,
		};
		const opts = buildModelOpts(fixture, ctx);
		expect(opts.find((o) => o.id === "tiny")?.label).toBe(
			"[Whisper] Tiny (39M) ✓ Downloaded",
		);
	});

	test("appends the warn glyph when the model is uncomfortable everywhere", () => {
		const ctx = {
			statesById: {
				tiny: makeEntry({
					comfortable_on_cpu: false,
					comfortable_on_gpu: false,
				}),
			},
			systemInfo: makeSys(1),
		};
		const opts = buildModelOpts(fixture, ctx);
		expect(opts.find((o) => o.id === "tiny")?.label).toContain(" ⚠");
	});
});

describe("modelsHaveLanguageOverlap", () => {
	test("accepts models with at least one explicit language in common", () => {
		expect(
			modelsHaveLanguageOverlap(
				{ ...fixture[0], languages: ["en", "fr"] } as ModelInfo,
				{ ...fixture[2], languages: ["de", "fr"] } as ModelInfo,
			),
		).toBe(true);
	});

	test("rejects disjoint explicit language sets", () => {
		expect(
			modelsHaveLanguageOverlap(
				{ ...fixture[0], languages: ["en"] } as ModelInfo,
				{ ...fixture[2], languages: ["ru"] } as ModelInfo,
			),
		).toBe(false);
	});

	test("treats an empty language list as universal", () => {
		expect(
			modelsHaveLanguageOverlap(
				{ ...fixture[0], languages: [] } as ModelInfo,
				{ ...fixture[2], languages: ["ru"] } as ModelInfo,
			),
		).toBe(true);
		expect(
			modelsHaveLanguageOverlap(
				{ ...fixture[0], languages: ["en"] } as ModelInfo,
				{ ...fixture[2], languages: [] } as ModelInfo,
			),
		).toBe(true);
	});
});

describe("isSelectableRealtimeModel", () => {
	const realtime = (id: string, nativeStreaming = true): ModelInfo => ({
		...fixture[2]!,
		id,
		nativeStreaming,
	});

	test("keeps native-streaming models that are not duplicated export variants", () => {
		expect(isSelectableRealtimeModel(realtime("streaming-zipformer-en"))).toBe(
			true,
		);
		expect(isSelectableRealtimeModel(realtime("t-tech/t-one"))).toBe(true);
	});

	test("requires native streaming even for a canonical id", () => {
		expect(
			isSelectableRealtimeModel(
				realtime("streaming-nemo-rnnt-en-1040ms-int8", false),
			),
		).toBe(false);
	});

	test("marks only the high-latency published duplicate exports as canonical", () => {
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemo-ctc-en-1040ms")),
		).toBe(true);
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemo-ctc-en-1040ms-int8")),
		).toBe(true);
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemo-rnnt-en-1040ms")),
		).toBe(true);
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemo-rnnt-en-1040ms-int8")),
		).toBe(true);
		expect(
			isCanonicalRealtimeModel(
				realtime("streaming-parakeet-unified-en-1120ms"),
			),
		).toBe(true);
		expect(
			isCanonicalRealtimeModel(
				realtime("streaming-parakeet-unified-en-1120ms-int8"),
			),
		).toBe(true);
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemotron-en-1120ms")),
		).toBe(true);
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemotron-en-1120ms-int8")),
		).toBe(true);

		expect(isCanonicalRealtimeModel(realtime("streaming-nemo-rnnt-en"))).toBe(
			false,
		);
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemo-rnnt-en-80ms-int8")),
		).toBe(false);
		expect(
			isCanonicalRealtimeModel(
				realtime("streaming-parakeet-unified-en-560ms-int8"),
			),
		).toBe(false);
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemotron-en-560ms")),
		).toBe(false);
		expect(
			isCanonicalRealtimeModel(realtime("streaming-nemotron-en-80ms-int8")),
		).toBe(false);
	});
});

describe("isVisibleSttModel", () => {
	test("hides duplicate streaming export variants without requiring native streaming", () => {
		const hidden = {
			...fixture[2],
			id: "streaming-nemo-rnnt-en-80ms-int8",
			nativeStreaming: false,
		} as ModelInfo;
		const normal = {
			...fixture[1],
			id: "large-v3",
			nativeStreaming: false,
		} as ModelInfo;
		expect(isVisibleSttModel(hidden)).toBe(false);
		expect(isVisibleSttModel(normal)).toBe(true);
	});
});

describe("formatCacheBadge", () => {
	test("returns empty string when entry is undefined", () => {
		expect(formatCacheBadge(undefined)).toBe("");
	});

	test("returns ✓ Downloaded for cached state", () => {
		expect(
			formatCacheBadge(
				makeEntry({ cache: { ...makeEntry().cache, state: "cached" } }),
			),
		).toBe(" ✓ Downloaded");
	});

	test("returns ⏬ percent for partial state, rounding the progress fraction", () => {
		const entry = makeEntry({
			cache: {
				state: "partial",
				downloaded_bytes: 426,
				progress: 0.426,
				total_bytes: 1000,
			},
		});
		expect(formatCacheBadge(entry)).toBe(" ⏬ 43%");
	});

	test("rounds 0% partial progress correctly", () => {
		const entry = makeEntry({
			cache: {
				state: "partial",
				downloaded_bytes: 0,
				progress: 0,
				total_bytes: 1000,
			},
		});
		expect(formatCacheBadge(entry)).toBe(" ⏬ 0%");
	});

	test("returns ⬇ Not downloaded for not_cached state", () => {
		expect(
			formatCacheBadge(
				makeEntry({ cache: { ...makeEntry().cache, state: "not_cached" } }),
			),
		).toBe(" ⬇ Not downloaded");
	});
});

describe("hasEstimatedFootprint", () => {
	test("returns false for undefined entry", () => {
		expect(hasEstimatedFootprint(undefined)).toBe(false);
	});

	test("returns false when estimated_bytes is zero", () => {
		expect(hasEstimatedFootprint(makeEntry({ estimated_bytes: 0 }))).toBe(
			false,
		);
	});

	test("returns false when estimated_bytes is negative", () => {
		expect(hasEstimatedFootprint(makeEntry({ estimated_bytes: -1 }))).toBe(
			false,
		);
	});

	test("returns true when estimated_bytes is positive", () => {
		expect(hasEstimatedFootprint(makeEntry({ estimated_bytes: 100 }))).toBe(
			true,
		);
	});
});

describe("hasGpu", () => {
	test("returns false when sys is null", () => {
		expect(hasGpu(null)).toBe(false);
	});

	test("returns false when sys has zero gpus", () => {
		expect(hasGpu(makeSys(0))).toBe(false);
	});

	test("returns true when sys has one or more gpus", () => {
		expect(hasGpu(makeSys(1))).toBe(true);
		expect(hasGpu(makeSys(2))).toBe(true);
	});
});

describe("isRescuedByGpu", () => {
	test("returns false when no gpu present (even if comfortable_on_gpu is true)", () => {
		expect(isRescuedByGpu(makeEntry({ comfortable_on_gpu: true }), null)).toBe(
			false,
		);
		expect(
			isRescuedByGpu(makeEntry({ comfortable_on_gpu: true }), makeSys(0)),
		).toBe(false);
	});

	test("returns false when gpu present but model is not comfortable on gpu", () => {
		expect(
			isRescuedByGpu(makeEntry({ comfortable_on_gpu: false }), makeSys(1)),
		).toBe(false);
	});

	test("returns true when gpu present and model is comfortable on gpu", () => {
		expect(
			isRescuedByGpu(makeEntry({ comfortable_on_gpu: true }), makeSys(1)),
		).toBe(true);
	});
});

describe("isUncomfortable", () => {
	test("returns false when entry is undefined", () => {
		expect(isUncomfortable(undefined, null)).toBe(false);
		expect(isUncomfortable(undefined, makeSys(1))).toBe(false);
	});

	test("returns false when estimated_bytes is zero (no fitness data)", () => {
		expect(isUncomfortable(makeEntry({ estimated_bytes: 0 }), makeSys(1))).toBe(
			false,
		);
	});

	test("returns false when the model is comfortable on cpu and there is no gpu", () => {
		expect(
			isUncomfortable(
				makeEntry({ comfortable_on_cpu: true, comfortable_on_gpu: false }),
				null,
			),
		).toBe(false);
	});

	test("returns true when uncomfortable on cpu and there is no gpu", () => {
		expect(
			isUncomfortable(
				makeEntry({ comfortable_on_cpu: false, comfortable_on_gpu: true }),
				null,
			),
		).toBe(true);
	});

	test("returns false when uncomfortable on cpu but rescued by a comfortable gpu", () => {
		expect(
			isUncomfortable(
				makeEntry({ comfortable_on_cpu: false, comfortable_on_gpu: true }),
				makeSys(1),
			),
		).toBe(false);
	});

	test("returns true when uncomfortable on cpu and gpu present but not comfortable on gpu", () => {
		expect(
			isUncomfortable(
				makeEntry({ comfortable_on_cpu: false, comfortable_on_gpu: false }),
				makeSys(1),
			),
		).toBe(true);
	});

	test("returns false when comfortable on cpu, regardless of gpu state", () => {
		expect(
			isUncomfortable(
				makeEntry({ comfortable_on_cpu: true, comfortable_on_gpu: false }),
				makeSys(1),
			),
		).toBe(false);
	});
});

describe("needsModelFallback", () => {
	test("returns true for empty string", () => {
		expect(needsModelFallback("", fixture)).toBe(true);
	});

	test("returns true for null/undefined", () => {
		expect(needsModelFallback(null, fixture)).toBe(true);
		expect(needsModelFallback(undefined, fixture)).toBe(true);
	});

	test("returns true when the saved id is not in the catalog", () => {
		expect(needsModelFallback("ghost-model", fixture)).toBe(true);
	});

	test("returns false when the saved id is in the catalog", () => {
		expect(needsModelFallback("tiny", fixture)).toBe(false);
		expect(needsModelFallback("large", fixture)).toBe(false);
	});
});

describe("pickDefaultSttModel", () => {
	test("returns null when no models are eligible", () => {
		expect(pickDefaultSttModel([], {})).toBeNull();
		// Filter rules out every entry.
		expect(pickDefaultSttModel(fixture, {}, () => false)).toBeNull();
	});

	test("prefers the smallest cached model over an uncached but smaller one", () => {
		const statesById: Record<string, ModelStateEntry> = {
			tiny: makeEntry({
				id: "tiny",
				estimated_bytes: 39_000_000,
				cache: {
					state: "not_cached",
					downloaded_bytes: 0,
					progress: 0,
					total_bytes: 0,
				},
			}),
			large: makeEntry({
				id: "large",
				estimated_bytes: 1_500_000_000,
				cache: {
					state: "cached",
					downloaded_bytes: 0,
					progress: 1,
					total_bytes: 0,
				},
			}),
			"nemo-en": makeEntry({
				id: "nemo-en",
				estimated_bytes: 300_000_000,
				cache: {
					state: "cached",
					downloaded_bytes: 0,
					progress: 1,
					total_bytes: 0,
				},
			}),
		};
		// nemo-en (300M, cached) wins over large (1.5B, cached) and tiny (39M, not cached).
		expect(pickDefaultSttModel(fixture, statesById)).toBe("nemo-en");
	});

	test("falls back to smallest in catalog when nothing is cached", () => {
		const statesById: Record<string, ModelStateEntry> = {
			tiny: makeEntry({ id: "tiny", estimated_bytes: 39_000_000 }),
			large: makeEntry({ id: "large", estimated_bytes: 1_500_000_000 }),
			"nemo-en": makeEntry({ id: "nemo-en", estimated_bytes: 300_000_000 }),
		};
		expect(pickDefaultSttModel(fixture, statesById)).toBe("tiny");
	});

	test("honors the filter when narrowing to native-streaming entries", () => {
		const statesById: Record<string, ModelStateEntry> = {
			tiny: makeEntry({ id: "tiny", estimated_bytes: 39_000_000 }),
			large: makeEntry({ id: "large", estimated_bytes: 1_500_000_000 }),
			"nemo-en": makeEntry({ id: "nemo-en", estimated_bytes: 300_000_000 }),
		};
		// `large` has nativeStreaming=false in the fixture, so it must not be chosen.
		expect(
			pickDefaultSttModel(fixture, statesById, (m) => m.nativeStreaming),
		).toBe("tiny");
	});

	test("handles missing state entries by treating estimated size as infinite", () => {
		// With no state entries at all, every model has Infinity size — first stays first.
		const out = pickDefaultSttModel(fixture, {});
		expect(out).toBe("tiny");
	});
});

describe("pickCachedSttModel", () => {
	test("picks the smallest cached model after applying the filter", () => {
		const statesById: Record<string, ModelStateEntry> = {
			tiny: makeEntry({
				id: "tiny",
				estimated_bytes: 39_000_000,
				cache: {
					state: "not_cached",
					downloaded_bytes: 0,
					progress: 0,
					total_bytes: 0,
				},
			}),
			large: makeEntry({
				id: "large",
				estimated_bytes: 1_500_000_000,
				cache: {
					state: "cached",
					downloaded_bytes: 0,
					progress: 1,
					total_bytes: 0,
				},
			}),
			"nemo-en": makeEntry({
				id: "nemo-en",
				estimated_bytes: 300_000_000,
				cache: {
					state: "cached",
					downloaded_bytes: 0,
					progress: 1,
					total_bytes: 0,
				},
			}),
		};
		expect(
			pickCachedSttModel(fixture, statesById, (m) => m.nativeStreaming),
		).toBe("nemo-en");
	});

	test("returns null when no eligible model is cached", () => {
		const statesById: Record<string, ModelStateEntry> = {
			tiny: makeEntry({ id: "tiny", estimated_bytes: 39_000_000 }),
			large: makeEntry({ id: "large", estimated_bytes: 1_500_000_000 }),
			"nemo-en": makeEntry({ id: "nemo-en", estimated_bytes: 300_000_000 }),
		};
		expect(
			pickCachedSttModel(fixture, statesById, (m) => m.nativeStreaming),
		).toBeNull();
	});
});

describe("supportsTranslateToEnglish", () => {
	const withModel = (overrides: Partial<ModelInfo>): ModelInfo =>
		({ ...fixture[0], ...overrides }) as ModelInfo;

	test("is true for multilingual Whisper and Canary", () => {
		expect(
			supportsTranslateToEnglish(
				withModel({ family: "whisper", supportsLanguageDetection: true }),
			),
		).toBe(true);
		expect(
			supportsTranslateToEnglish(
				withModel({
					id: "nemo-canary-180m-flash",
					family: "nemo",
					supportsLanguageDetection: false,
				}),
			),
		).toBe(true);
	});

	test("is false for English-only Whisper and non-Canary NeMo rows", () => {
		expect(
			supportsTranslateToEnglish(
				withModel({ family: "whisper", supportsLanguageDetection: false }),
			),
		).toBe(false);
		expect(
			supportsTranslateToEnglish(
				withModel({
					id: "nemo-parakeet-tdt-0.6b-v3",
					family: "nemo",
					supportsLanguageDetection: false,
				}),
			),
		).toBe(false);
	});
});
