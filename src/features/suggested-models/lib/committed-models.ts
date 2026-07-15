import { isCloudModelId } from "@/entities/cloud-stt-provider";
import { ollamaRequiredRuntimeBytes } from "@/entities/llm-catalog";
import { resolveEffectiveQuant } from "@/entities/model-catalog";
import {
	type CommittedModel,
	resolveQuantDevice,
} from "@/entities/model-suggestion";
import {
	ENCODER_DICT_MODEL_BYTES,
	estimateForQuant,
} from "@/entities/system-resources";
import type {
	ModelStateEntry,
	OllamaModel,
	TtsModelStateEntry,
} from "@/shared/api/ipc-client";

/**
 * Assembles the enabled modalities' committed runtime footprints
 * (`CommittedModel[]`) for the shared suggestion budget calculator
 * (`computeBudgets` in `@/entities/model-suggestion`).
 *
 * Pure + side-effect-free so it can be unit-tested against fixed store
 * snapshots — the hook layer (`use-committed-models.ts`) feeds it live store
 * data. Mirrors EXACTLY the per-modality input assembly of the status-bar
 * breakdown (`buildRuntimeBreakdown` in connect-server): the same settings
 * decide which modalities are on, and the same byte sources size them.
 *
 * Modalities with no local footprint contribute NOTHING: disabled toggles,
 * cloud sources (cloud STT ids, `tts.source === "cloud"`, non-Ollama LLM
 * providers), and models whose size is unknown (never guess — an absent entry
 * simply doesn't shrink the budget).
 */

/** The TTS catalog fields the builder needs — a structural subset of
 *  `TtsModelInfo` (same trick as `CatalogSizeInfo` in the breakdown). */
interface TtsCatalogSizeInfo {
	sizeBytesByQuantization: Record<string, number>;
}

export interface CommittedModelsInput {
	/** Machine has a GPU (largest-GPU VRAM > 0) — drives the STT routing
	 * heuristic fallback and the Ollama "GPU if present" rule. */
	hasGpu: boolean;
	/** The runtime accelerator is a GPU EP (server `runtime_info.is_gpu`,
	 * falling back to `hasGpu` when unknown) — TTS follows it (matches
	 * `ttsSection` in the breakdown). */
	isGpuAccelerator: boolean;
	/** Loaded main STT model id (runtimeInfo.model ?? settings.model.model). */
	mainModelId: string | null;
	/** Loaded realtime/preview STT model id (runtimeInfo.realtime_model). */
	realtimeModelId: string | null;
	/** Selected STT quantization (settings.model.onnxQuantization). */
	sttQuant: string;
	getSttState: (id: string) => ModelStateEntry | undefined;
	tts: {
		enabled: boolean;
		source: "local" | "cloud";
		modelId: string;
	};
	getTtsState: (id: string) => TtsModelStateEntry | undefined;
	getTtsModel: (id: string) => TtsCatalogSizeInfo | undefined;
	encoderDictEnabled: boolean;
	llmCleanup: {
		enabled: boolean;
		provider: string;
		model: string;
	};
	getOllamaModel: (name: string) => OllamaModel | undefined;
}

/** One STT slot's footprint: runtime bytes at the EFFECTIVE quant (the same
 * `estimated_bytes × bytes-per-param` scaling the fit badges use), routed to
 * the pool the quant actually runs in — the server's per-quant pin verdict
 * (`device_by_quantization`) when present, else the GPU-compatible-quant
 * heuristic. Cloud ids and unknown estimates contribute nothing. */
function sttCommitted(
	modelId: string,
	input: CommittedModelsInput,
): CommittedModel | null {
	if (isCloudModelId(modelId)) {
		return null;
	}
	const state = input.getSttState(modelId);
	if (!state || state.estimated_bytes <= 0) {
		return null;
	}
	const effectiveQuant = resolveEffectiveQuant(state, input.sttQuant);
	return {
		bytes: estimateForQuant(state.estimated_bytes, effectiveQuant),
		device: resolveQuantDevice(effectiveQuant, {
			hasGpu: input.hasGpu,
			deviceByQuantization: state.device_by_quantization ?? null,
		}),
		modality: "stt",
	};
}

function pushSttSlots(
	out: CommittedModel[],
	input: CommittedModelsInput,
): void {
	if (input.mainModelId) {
		pushIfPresent(out, sttCommitted(input.mainModelId, input));
	}
	// Only count the realtime slot when it's a distinct loaded model — sharing
	// the main weights (useMainModelForRealtime) would double-count the footprint.
	if (input.realtimeModelId && input.realtimeModelId !== input.mainModelId) {
		pushIfPresent(out, sttCommitted(input.realtimeModelId, input));
	}
}

/** First positive byte size across the effective quant, the fp32 base, then
 * any published entry — the same fallback ladder as `pickQuantBytes` in the
 * breakdown. */
function ttsCatalogBytes(
	sizes: Record<string, number> | undefined,
	effectiveQuant: string,
): number {
	if (!sizes) {
		return 0;
	}
	const candidates = [sizes[effectiveQuant], sizes[""]];
	for (const value of candidates) {
		if (typeof value === "number" && value > 0) {
			return value;
		}
	}
	return Object.values(sizes).find((v) => v > 0) ?? 0;
}

/** The local TTS voice's footprint: the runtime estimate when the state store
 * has one, else the catalog disk size (disk ≈ resident for ONNX). TTS follows
 * the global accelerator's pool. Off / cloud / unsized ⇒ nothing. */
function ttsCommitted(input: CommittedModelsInput): CommittedModel | null {
	const { tts } = input;
	if (!(tts.enabled && tts.source === "local" && tts.modelId)) {
		return null;
	}
	const state = input.getTtsState(tts.modelId);
	const bytes =
		state && state.estimatedBytes > 0
			? state.estimatedBytes
			: ttsCatalogBytes(
					input.getTtsModel(tts.modelId)?.sizeBytesByQuantization,
					state?.effectiveQuantization ?? "",
				);
	if (bytes <= 0) {
		return null;
	}
	return {
		bytes,
		device: input.isGpuAccelerator ? "gpu" : "cpu",
		modality: "tts",
	};
}

/** The local cleanup LLM's footprint: installed GGUF size plus Ollama's
 * KV-cache/activation headroom (`ollamaRequiredRuntimeBytes` — the same
 * formula as the warning chip's `assessOllamaFit`). Ollama offloads to the
 * GPU whenever one exists, independent of our app's accelerator. */
function llmCommitted(input: CommittedModelsInput): CommittedModel | null {
	const { llmCleanup } = input;
	if (
		!(
			llmCleanup.enabled &&
			llmCleanup.provider === "ollama" &&
			llmCleanup.model
		)
	) {
		return null;
	}
	const ollama = input.getOllamaModel(llmCleanup.model);
	if (typeof ollama?.size !== "number" || ollama.size <= 0) {
		return null;
	}
	return {
		bytes: ollamaRequiredRuntimeBytes(ollama.size),
		device: input.hasGpu ? "gpu" : "cpu",
		modality: "llm",
	};
}

/** The encoder dictionary's fixed footprint. It always runs as a CPU ONNX
 * session — even when STT is on the GPU — so its bytes are RAM, never VRAM. */
function dictionaryCommitted(
	input: CommittedModelsInput,
): CommittedModel | null {
	if (!input.encoderDictEnabled) {
		return null;
	}
	return {
		bytes: ENCODER_DICT_MODEL_BYTES,
		device: "cpu",
		modality: "dictionary",
	};
}

function pushIfPresent(
	out: CommittedModel[],
	model: CommittedModel | null,
): void {
	if (model !== null) {
		out.push(model);
	}
}

/** Build the full committed-footprint list (STT main + realtime, TTS,
 * cleanup LLM, encoder dictionary) for `computeBudgets`. */
export function buildCommittedModels(
	input: CommittedModelsInput,
): CommittedModel[] {
	const out: CommittedModel[] = [];
	pushSttSlots(out, input);
	pushIfPresent(out, ttsCommitted(input));
	pushIfPresent(out, llmCommitted(input));
	pushIfPresent(out, dictionaryCommitted(input));
	return out;
}

/** Match an Ollama model by exact name, tolerating an implicit `:latest` tag
 * on either side (the settings store and the API may disagree on the tag) —
 * the same matcher the breakdown hook uses. */
export function findOllamaModel(
	models: readonly OllamaModel[],
	name: string,
): OllamaModel | undefined {
	if (name === "") {
		return;
	}
	return models.find(
		(m) =>
			m.name === name ||
			m.name === `${name}:latest` ||
			`${m.name}:latest` === name,
	);
}
