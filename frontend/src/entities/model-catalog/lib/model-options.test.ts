import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../model/catalog-store";
import { buildModelOpts, buildRealtimeOpts } from "./model-options";

const fixture: ModelInfo[] = [
	{
		id: "tiny",
		displayName: "Tiny",
		family: "whisper",
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
	},
	{
		id: "large",
		displayName: "Large v3",
		family: "whisper",
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "1.5B",
		supportsRealtime: false,
		onnxModelName: null,
		description: "",
	},
	{
		id: "nemo-en",
		displayName: "NeMo EN",
		family: "nemo",
		backend: "onnx_asr",
		languages: ["en"],
		supportsLanguageDetection: false,
		sizeLabel: "300M",
		supportsRealtime: true,
		onnxModelName: "model.onnx",
		description: "",
	},
];

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

	test("returns an empty array for empty input", () => {
		expect(buildModelOpts([])).toEqual([]);
	});

	test("preserves all input models in the output (no filtering)", () => {
		expect(buildModelOpts(fixture)).toHaveLength(fixture.length);
	});
});

describe("buildRealtimeOpts", () => {
	test("filters out models that do not support realtime", () => {
		const opts = buildRealtimeOpts(fixture);
		expect(opts.map((o) => o.id).sort()).toEqual(["nemo-en", "tiny"].sort());
	});

	test("returns empty array when no models support realtime", () => {
		const noRealtime = fixture.map((m) => ({ ...m, supportsRealtime: false }));
		expect(buildRealtimeOpts(noRealtime)).toEqual([]);
	});
});
