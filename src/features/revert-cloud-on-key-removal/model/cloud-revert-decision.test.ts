import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import { DEFAULT_SETTINGS } from "@/entities/setting";
import {
	affectedProviders,
	clearableProviderLabel,
	detectClearedKeys,
	type KeySnapshot,
	planHasWork,
	planReverts,
	type RevertPlan,
	resolveLocalSttTarget,
	type SurfaceSnapshot,
} from "./cloud-revert-decision";

function keys(over: Partial<KeySnapshot> = {}): KeySnapshot {
	return { elevenlabs: "", openrouter: "", ...over };
}

function surfaces(over: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot {
	return {
		model: "tiny",
		dictationProvider: "ollama",
		transformsProvider: "ollama",
		ttsSource: "local",
		...over,
	};
}

function model(over: Partial<ModelInfo> & Pick<ModelInfo, "id">): ModelInfo {
	const previewCapable = over.previewCapable ?? over.supportsRealtime ?? false;
	return {
		displayName: over.displayName ?? over.id,
		backend: over.backend ?? "onnx_asr",
		family: over.family ?? "whisper",
		languages: [],
		supportsLanguageDetection: false,
		sizeLabel: "",
		previewCapable,
		nativeStreaming: over.nativeStreaming ?? false,
		finalReuseSafe: over.finalReuseSafe ?? previewCapable,
		supportsRealtime: previewCapable,
		onnxModelName: null,
		description: "",
		availableQuantizations: [],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
		...over,
	};
}

describe("detectClearedKeys", () => {
	test("no transition → empty set", () => {
		const cleared = detectClearedKeys(
			keys({ elevenlabs: "el" }),
			keys({ elevenlabs: "el" }),
		);
		expect(cleared.size).toBe(0);
	});

	test("non-empty → empty flags the provider", () => {
		const cleared = detectClearedKeys(keys({ elevenlabs: "el" }), keys());
		expect([...cleared]).toEqual(["elevenlabs"]);
	});

	test("whitespace-only previous key is not a real removal", () => {
		const cleared = detectClearedKeys(keys({ elevenlabs: "   " }), keys());
		expect(cleared.size).toBe(0);
	});

	test("clearing to whitespace still counts (next trims to empty)", () => {
		const cleared = detectClearedKeys(
			keys({ elevenlabs: "el" }),
			keys({ elevenlabs: "  " }),
		);
		expect([...cleared]).toEqual(["elevenlabs"]);
	});

	test("detects several providers cleared at once", () => {
		const before = keys({ elevenlabs: "b", openrouter: "c" });
		const cleared = detectClearedKeys(before, keys());
		expect(cleared.size).toBe(2);
	});
});

describe("planReverts", () => {
	test("no cleared keys → no work", () => {
		const plan = planReverts(
			new Set(),
			surfaces({ model: "elevenlabs:scribe_v1" }),
		);
		expect(planHasWork(plan)).toBe(false);
	});

	test("openrouter cleared while the active model is openrouter reverts STT", () => {
		const plan = planReverts(
			new Set(["openrouter"]),
			surfaces({ model: "openrouter:openai/whisper-1" }),
		);
		expect(plan.stt).toBe(true);
	});

	test("openrouter cleared while on a local model does NOT revert STT", () => {
		const plan = planReverts(
			new Set(["openrouter"]),
			surfaces({ model: "tiny" }),
		);
		expect(plan.stt).toBe(false);
	});

	test("openrouter cleared while on an elevenlabs model does NOT revert STT", () => {
		const plan = planReverts(
			new Set(["openrouter"]),
			surfaces({ model: "elevenlabs:scribe_v1" }),
		);
		expect(plan.stt).toBe(false);
	});

	test("openrouter cleared reverts only the features using it", () => {
		const plan = planReverts(
			new Set(["openrouter"]),
			surfaces({
				dictationProvider: "openrouter",
				transformsProvider: "ollama",
			}),
		);
		expect(plan.llmDictation).toBe(true);
		expect(plan.llmTransforms).toBe(false);
	});

	test("elevenlabs cleared reverts both STT and cloud TTS when both are active", () => {
		const plan = planReverts(
			new Set(["elevenlabs"]),
			surfaces({ model: "elevenlabs:scribe_v1", ttsSource: "cloud" }),
		);
		expect(plan.stt).toBe(true);
		expect(plan.ttsCloud).toBe(true);
	});
});

describe("affectedProviders", () => {
	function plan(over: Partial<RevertPlan>): RevertPlan {
		return {
			stt: false,
			llmDictation: false,
			llmTransforms: false,
			ttsCloud: false,
			...over,
		};
	}

	test("STT revert maps to the active model's provider", () => {
		const set = affectedProviders(
			plan({ stt: true }),
			"openrouter:openai/whisper-1",
		);
		expect([...set]).toEqual(["openrouter"]);
	});

	test("LLM reverts map to openrouter", () => {
		const set = affectedProviders(plan({ llmTransforms: true }), "tiny");
		expect([...set]).toEqual(["openrouter"]);
	});

	test("elevenlabs STT + cloud TTS dedupe to a single notice", () => {
		const set = affectedProviders(
			plan({ stt: true, ttsCloud: true }),
			"elevenlabs:scribe_v1",
		);
		expect([...set]).toEqual(["elevenlabs"]);
	});
});

describe("resolveLocalSttTarget", () => {
	test("falls back to the schema default when the catalog is empty", () => {
		expect(resolveLocalSttTarget([], {})).toEqual({
			model: DEFAULT_SETTINGS.model.model,
			backend: DEFAULT_SETTINGS.model.backend,
		});
	});

	test("picks a catalog model and pairs its backend", () => {
		const target = resolveLocalSttTarget(
			[model({ id: "tiny", backend: "onnx_asr" })],
			{},
		);
		expect(target).toEqual({ model: "tiny", backend: "onnx_asr" });
	});
});

describe("clearableProviderLabel", () => {
	test("maps each provider to its display name", () => {
		expect(clearableProviderLabel("elevenlabs")).toBe("ElevenLabs");
		expect(clearableProviderLabel("openrouter")).toBe("OpenRouter");
	});
});
