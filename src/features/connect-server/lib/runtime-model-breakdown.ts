import { resolveEffectiveQuant } from "@/entities/model-catalog";
import { estimateForQuant } from "@/entities/system-resources";
import type { ModelStateEntry, OllamaModel } from "@/shared/api/ipc-client";

/** The catalog fields the breakdown needs — a structural subset of both the
 *  STT `ModelInfo` and the TTS `TtsModelInfo`, so either can be passed in. */
interface CatalogSizeInfo {
	displayName: string;
	sizeBytesByQuantization: Record<string, number>;
	/** Public path to the model maker's brand logo, already resolved for the
	 *  current window (dev server vs packaged `file://`). The hook layer fills
	 *  this in; `null`/absent = no bundled mark for this model. */
	logoSrc?: string | null;
	/** Human-readable maker/author label (e.g. "DataoceanAI") — the logo's
	 *  hover hint. Filled by the hook layer alongside `logoSrc`. */
	maker?: string | null;
}

/**
 * Assembles the per-model footprint breakdown shown when hovering the
 * status-bar GPU/CPU chip. Pure + side-effect-free so it can be unit-tested
 * against fixed store snapshots — the hook layer feeds it live store data.
 *
 * "Memory" is the model's estimated runtime consumption (RAM on CPU, VRAM on
 * GPU): for STT we reuse the picker's `estimated_bytes × bytes-per-param`
 * scaling so the number matches the fit badges; for the other engines the
 * on-disk weights are the best available proxy (an ONNX/GGUF model loads
 * roughly its file size into memory). "Disk" is the catalog download size.
 */

/** Which resource a model's weights live in — drives the VRAM vs RAM tag. */
export type BreakdownDevice = "gpu" | "cpu";

/** Status word rendered (translated) in place of a model name. */
export type BreakdownStatus = "off" | "cloud" | "onDevice";

export interface BreakdownRow {
	/** Stable React key within the section. */
	key: string;
	/** Model display name, or `null` when the row is a status word. */
	name: string | null;
	/** Translated status word to show when `name` is `null` (off/cloud/on-device). */
	status: BreakdownStatus | null;
	/** Small muted qualifier — quantization, provider, or cloud model id. */
	detail: string | null;
	/** Marks the realtime/live-preview slot so the UI can label it. */
	live: boolean;
	/** Estimated runtime memory in bytes; `null` = unknown or no local footprint. */
	memBytes: number | null;
	/** On-disk download size in bytes; `null` = unknown or no local footprint. */
	diskBytes: number | null;
	/** Resource the memory lives in; `null` for cloud / off (no local weights). */
	device: BreakdownDevice | null;
	/** Maker/author brand logo, resolved to a ready-to-use public URL. `null`
	 *  for status rows and engines without a bundled mark. */
	logoSrc?: string | null;
	/** Maker/author label, the logo's hover hint (e.g. "OpenAI"). */
	maker?: string | null;
}

export interface BreakdownSection {
	key: "stt" | "tts" | "dictionary" | "post";
	rows: BreakdownRow[];
}

/** mmBERT-base int8 encoder dictionary — fixed on-device model (~310 MB),
 *  always loaded on CPU. Sized from the managed download in
 *  `winstt/encoder_dict/` (see `project_encoder_dict_fallback_and_toggle`). */
const ENCODER_DICT_BYTES = 310 * 1024 * 1024;

export interface BreakdownInput {
	isGpu: boolean;
	/** Loaded main STT model id (runtimeInfo.model ?? settings.model.model). */
	mainModelId: string | null;
	/** Loaded realtime/preview STT model id (runtimeInfo.realtime_model). */
	realtimeModelId: string | null;
	/** Selected STT quantization (settings.model.onnxQuantization). */
	sttQuant: string;
	getSttModel: (id: string) => CatalogSizeInfo | undefined;
	getSttState: (id: string) => ModelStateEntry | undefined;
	tts: {
		enabled: boolean;
		source: "local" | "cloud";
		modelId: string;
		cloudProvider: string;
	};
	getTtsModel: (id: string) => CatalogSizeInfo | undefined;
	encoderDictEnabled: boolean;
	llmCleanup: {
		enabled: boolean;
		provider: string;
		model: string;
		openrouterModel: string;
	};
	getOllamaModel: (name: string) => OllamaModel | undefined;
}

/** Pick a quantization's byte size, falling back across the effective pick,
 *  the raw selection, the fp32 base, then any available entry. */
function pickQuantBytes(
	sizes: Record<string, number> | undefined,
	effectiveQuant: string,
	selectedQuant: string,
): number | null {
	if (!sizes) {
		return null;
	}
	const candidates = [sizes[effectiveQuant], sizes[selectedQuant], sizes[""]];
	for (const value of candidates) {
		if (typeof value === "number" && value > 0) {
			return value;
		}
	}
	const firstPositive = Object.values(sizes).find((v) => v > 0);
	return firstPositive ?? null;
}

function sttRow(
	key: string,
	modelId: string,
	live: boolean,
	input: BreakdownInput,
): BreakdownRow {
	const catalog = input.getSttModel(modelId);
	const state = input.getSttState(modelId);
	const effectiveQuant = resolveEffectiveQuant(state, input.sttQuant);
	const diskBytes = pickQuantBytes(
		catalog?.sizeBytesByQuantization,
		effectiveQuant,
		input.sttQuant,
	);
	const estimated =
		state && state.estimated_bytes > 0
			? estimateForQuant(state.estimated_bytes, effectiveQuant)
			: null;
	return {
		key,
		name: catalog?.displayName ?? modelId,
		status: null,
		detail: effectiveQuant === "" ? "fp32" : effectiveQuant || null,
		live,
		memBytes: estimated ?? diskBytes,
		diskBytes,
		device: input.isGpu ? "gpu" : "cpu",
		logoSrc: catalog?.logoSrc ?? null,
		maker: catalog?.maker ?? null,
	};
}

function sttSection(input: BreakdownInput): BreakdownSection {
	const rows: BreakdownRow[] = [];
	if (input.mainModelId) {
		rows.push(sttRow("stt-main", input.mainModelId, false, input));
	}
	// Only surface the realtime slot when it's a distinct loaded model — sharing
	// the main weights (useMainModelForRealtime) would double-count the footprint.
	if (input.realtimeModelId && input.realtimeModelId !== input.mainModelId) {
		rows.push(sttRow("stt-realtime", input.realtimeModelId, true, input));
	}
	return { key: "stt", rows };
}

function offRow(key: string): BreakdownRow {
	return {
		key,
		name: null,
		status: "off",
		detail: null,
		live: false,
		memBytes: null,
		diskBytes: null,
		device: null,
	};
}

function ttsSection(input: BreakdownInput): BreakdownSection {
	const { tts } = input;
	if (!tts.enabled) {
		return { key: "tts", rows: [offRow("tts")] };
	}
	if (tts.source === "cloud") {
		return {
			key: "tts",
			rows: [
				{
					key: "tts",
					name: null,
					status: "cloud",
					detail: tts.cloudProvider || null,
					live: false,
					memBytes: null,
					diskBytes: null,
					device: null,
				},
			],
		};
	}
	const catalog = input.getTtsModel(tts.modelId);
	const diskBytes = pickQuantBytes(catalog?.sizeBytesByQuantization, "", "");
	return {
		key: "tts",
		rows: [
			{
				key: "tts",
				name: catalog?.displayName ?? tts.modelId,
				status: null,
				detail: null,
				live: false,
				memBytes: diskBytes,
				diskBytes,
				device: input.isGpu ? "gpu" : "cpu",
				logoSrc: catalog?.logoSrc ?? null,
				maker: catalog?.maker ?? null,
			},
		],
	};
}

function dictionarySection(input: BreakdownInput): BreakdownSection {
	if (!input.encoderDictEnabled) {
		return { key: "dictionary", rows: [offRow("dictionary")] };
	}
	return {
		key: "dictionary",
		rows: [
			{
				key: "dictionary",
				name: "mmBERT",
				status: null,
				detail: "int8",
				live: false,
				memBytes: ENCODER_DICT_BYTES,
				diskBytes: ENCODER_DICT_BYTES,
				// The encoder dictionary always runs as a CPU ONNX session, even
				// when STT is on the GPU — so its footprint is RAM, not VRAM.
				device: "cpu",
			},
		],
	};
}

function postSection(input: BreakdownInput): BreakdownSection {
	const { llmCleanup } = input;
	const hasModel =
		llmCleanup.provider === "openrouter"
			? llmCleanup.openrouterModel !== ""
			: llmCleanup.provider === "apple-intelligence" || llmCleanup.model !== "";
	if (!llmCleanup.enabled || !hasModel) {
		return { key: "post", rows: [offRow("post")] };
	}
	if (llmCleanup.provider === "openrouter") {
		return {
			key: "post",
			rows: [
				{
					key: "post",
					name: null,
					status: "cloud",
					detail: llmCleanup.openrouterModel || null,
					live: false,
					memBytes: null,
					diskBytes: null,
					device: null,
				},
			],
		};
	}
	if (llmCleanup.provider === "apple-intelligence") {
		return {
			key: "post",
			rows: [
				{
					key: "post",
					name: null,
					status: "onDevice",
					detail: "Apple Intelligence",
					live: false,
					memBytes: null,
					diskBytes: null,
					device: null,
				},
			],
		};
	}
	// Ollama (local). Its model size — reported by the Ollama API — is the GGUF
	// on-disk size, which is also roughly what it maps into memory. Best-effort:
	// the size is only known when the LLM catalog has been scanned this session.
	const ollama = input.getOllamaModel(llmCleanup.model);
	const sizeBytes =
		typeof ollama?.size === "number" && ollama.size > 0 ? ollama.size : null;
	return {
		key: "post",
		rows: [
			{
				key: "post",
				name: llmCleanup.model,
				status: null,
				detail: "Ollama",
				live: false,
				memBytes: sizeBytes,
				diskBytes: sizeBytes,
				device: input.isGpu ? "gpu" : "cpu",
			},
		],
	};
}

/** Build the full STT / TTS / Dictionary / Post-processing breakdown. */
export function buildRuntimeBreakdown(
	input: BreakdownInput,
): BreakdownSection[] {
	return [
		sttSection(input),
		ttsSection(input),
		dictionarySection(input),
		postSection(input),
	];
}
