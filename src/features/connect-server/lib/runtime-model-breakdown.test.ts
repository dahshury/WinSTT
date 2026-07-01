import { describe, expect, test } from "bun:test";
import type { ModelStateEntry, OllamaModel } from "@/shared/api/ipc-client";
import {
	type BreakdownInput,
	buildRuntimeBreakdown,
} from "./runtime-model-breakdown";

function state(overrides: Partial<ModelStateEntry> = {}): ModelStateEntry {
	return {
		id: "m",
		estimated_bytes: 0,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		available_quantizations: [""],
		cache_by_quantization: {},
		cache: {
			state: "cached",
			downloaded_bytes: 0,
			progress: 0,
			total_bytes: 0,
		},
		...overrides,
	};
}

function baseInput(overrides: Partial<BreakdownInput> = {}): BreakdownInput {
	return {
		isGpu: true,
		mainModelId: "whisper",
		realtimeModelId: null,
		sttQuant: "auto",
		getSttModel: () => undefined,
		getSttState: () => undefined,
		tts: { enabled: false, source: "local", modelId: "", cloudProvider: "" },
		getTtsModel: () => undefined,
		encoderDictEnabled: false,
		llmCleanup: {
			enabled: false,
			provider: "ollama",
			model: "",
			openrouterModel: "",
		},
		getOllamaModel: () => undefined,
		...overrides,
	};
}

function section(input: BreakdownInput, key: string) {
	const s = buildRuntimeBreakdown(input).find((sec) => sec.key === key);
	if (!s) {
		throw new Error(`missing section ${key}`);
	}
	return s;
}

function firstRow(input: BreakdownInput, key: string) {
	const row = section(input, key).rows[0];
	if (!row) {
		throw new Error(`section ${key} has no rows`);
	}
	return row;
}

describe("buildRuntimeBreakdown — STT", () => {
	test("uses the runtime estimate scaled by the effective quant and the catalog disk size", () => {
		const input = baseInput({
			sttQuant: "auto",
			getSttModel: () => ({
				displayName: "Whisper Large v3",
				sizeBytesByQuantization: { int8: 800, "": 3200 },
			}),
			// fp32 baseline 4 bytes/param; int8 = 1.2 → estimate scales to 30% of 4000.
			getSttState: () =>
				state({ estimated_bytes: 4000, effective_quantization: "int8" }),
		});
		const row = firstRow(input, "stt");
		expect(row.name).toBe("Whisper Large v3");
		expect(row.detail).toBe("int8");
		expect(row.memBytes).toBe(Math.round(4000 * (1.2 / 4)));
		expect(row.diskBytes).toBe(800);
		expect(row.device).toBe("gpu");
	});

	test("falls back to disk size when no runtime estimate exists", () => {
		const input = baseInput({
			sttQuant: "int8",
			getSttModel: () => ({
				displayName: "Tiny",
				sizeBytesByQuantization: { int8: 77 },
			}),
		});
		const row = firstRow(input, "stt");
		expect(row.memBytes).toBe(77);
		expect(row.diskBytes).toBe(77);
	});

	test("adds a live-preview row only for a distinct realtime model", () => {
		const sameModel = baseInput({ realtimeModelId: "whisper" });
		expect(section(sameModel, "stt").rows).toHaveLength(1);

		const distinct = baseInput({ realtimeModelId: "moonshine" });
		const rows = section(distinct, "stt").rows;
		expect(rows).toHaveLength(2);
		expect(rows[1]?.live).toBe(true);
	});

	test("CPU runtime tags the footprint as RAM", () => {
		const input = baseInput({ isGpu: false });
		expect(firstRow(input, "stt").device).toBe("cpu");
	});
});

describe("buildRuntimeBreakdown — TTS", () => {
	test("off when disabled", () => {
		expect(firstRow(baseInput(), "tts").status).toBe("off");
	});

	test("cloud source reports the provider with no local footprint", () => {
		const input = baseInput({
			tts: {
				enabled: true,
				source: "cloud",
				modelId: "x",
				cloudProvider: "elevenlabs",
			},
		});
		const row = firstRow(input, "tts");
		expect(row.status).toBe("cloud");
		expect(row.detail).toBe("elevenlabs");
		expect(row.memBytes).toBeNull();
	});

	test("local model reports disk size as the footprint", () => {
		const input = baseInput({
			tts: {
				enabled: true,
				source: "local",
				modelId: "kokoro-82m",
				cloudProvider: "",
			},
			getTtsModel: () => ({
				displayName: "Kokoro 82M",
				sizeBytesByQuantization: { "": 191_959_988 },
			}),
		});
		const row = firstRow(input, "tts");
		expect(row.name).toBe("Kokoro 82M");
		expect(row.memBytes).toBe(191_959_988);
		expect(row.diskBytes).toBe(191_959_988);
		expect(row.device).toBe("gpu");
	});
});

describe("buildRuntimeBreakdown — Dictionary", () => {
	test("off when the encoder dictionary is disabled", () => {
		expect(firstRow(baseInput(), "dictionary").status).toBe("off");
	});

	test("present as a CPU/RAM footprint when enabled", () => {
		const row = firstRow(baseInput({ encoderDictEnabled: true }), "dictionary");
		expect(row.name).toBe("mmBERT");
		expect(row.device).toBe("cpu");
		expect(row.memBytes).toBeGreaterThan(0);
	});
});

describe("buildRuntimeBreakdown — Post-processing", () => {
	test("off when the cleanup LLM is disabled", () => {
		expect(firstRow(baseInput(), "post").status).toBe("off");
	});

	test("off when enabled but no model is configured", () => {
		const input = baseInput({
			llmCleanup: {
				enabled: true,
				provider: "ollama",
				model: "",
				openrouterModel: "",
			},
		});
		expect(firstRow(input, "post").status).toBe("off");
	});

	test("local Ollama model reports its size as the footprint", () => {
		const ollama: OllamaModel = { name: "llama3.1:8b", size: 4_700_000_000 };
		const input = baseInput({
			isGpu: false,
			llmCleanup: {
				enabled: true,
				provider: "ollama",
				model: "llama3.1:8b",
				openrouterModel: "",
			},
			getOllamaModel: (name) => (name === ollama.name ? ollama : undefined),
		});
		const row = firstRow(input, "post");
		expect(row.name).toBe("llama3.1:8b");
		expect(row.detail).toBe("Ollama");
		expect(row.memBytes).toBe(4_700_000_000);
		expect(row.device).toBe("cpu");
	});

	test("local Ollama model with unknown size omits the footprint", () => {
		const input = baseInput({
			llmCleanup: {
				enabled: true,
				provider: "ollama",
				model: "llama3.1:8b",
				openrouterModel: "",
			},
			getOllamaModel: () => undefined,
		});
		const row = firstRow(input, "post");
		expect(row.name).toBe("llama3.1:8b");
		expect(row.memBytes).toBeNull();
	});

	test("OpenRouter cleanup is a cloud row", () => {
		const input = baseInput({
			llmCleanup: {
				enabled: true,
				provider: "openrouter",
				model: "",
				openrouterModel: "openai/gpt-4o-mini",
			},
		});
		const row = firstRow(input, "post");
		expect(row.status).toBe("cloud");
		expect(row.detail).toBe("openai/gpt-4o-mini");
	});

	test("Apple Intelligence cleanup is an on-device row", () => {
		const input = baseInput({
			llmCleanup: {
				enabled: true,
				provider: "apple-intelligence",
				model: "",
				openrouterModel: "",
			},
		});
		const row = firstRow(input, "post");
		expect(row.status).toBe("onDevice");
		expect(row.memBytes).toBeNull();
	});
});
