import { z } from "zod";
import { create } from "zustand";
import { fetchModelCatalog, onModelCatalog } from "@/shared/api/ipc-client";
import {
	type ModelFamily,
	ModelFamilySchema,
	type TranscriberBackend,
	TranscriberBackendSchema,
} from "@/shared/api/schema.zod";

export interface ModelInfo {
	/**
	 * Normalized 0..1 accuracy score derived from published WER. ``0.5`` is
	 * the "unknown" sentinel — the picker hides the bar in that case. For
	 * shipped catalog rows this comes from the server's :func:`_accuracy_score`
	 * (WER on the HF Open ASR Leaderboard or upstream model-card claims).
	 */
	accuracyScore: number;
	/**
	 * `true` for shipped catalog rows. `false` only for user-provided custom
	 * model folders that failed the discovery contract (missing encoder /
	 * decoder / tokenizer / config). The picker greys these out and shows
	 * {@link errorMessage} as a tooltip so the user knows what's wrong with
	 * their drop without having to inspect the folder by hand.
	 */
	available: boolean;
	availableQuantizations: string[];
	backend: TranscriberBackend;
	description: string;
	displayName: string;
	/** Non-empty only for broken custom-model entries; renders as a tooltip. */
	errorMessage: string;
	family: ModelFamily;
	id: string;
	languages: string[];
	/**
	 * Absolute path to the user-provided model folder when the entry is a
	 * custom drop. `null` for every shipped catalog row. Driven by the
	 * server-side scanner under `{userData}/models/custom/`.
	 */
	localPath: string | null;
	onnxModelName: string | null;
	/**
	 * Exact on-HF download size in bytes for each available quantization.
	 * Baked into `catalog.json` by `refresh_catalog.py` from
	 * `HfApi.model_info(files_metadata=True)`. Empty for custom-model entries
	 * and catalog rows the refresh hasn't covered; consumers fall back to
	 * `sizeLabel` (the param-derived human label) in that case. The
	 * download-confirmation dialog reads this to show "Need to download:
	 * 78 MB" instead of the legacy "Size: unknown until headers fetched".
	 */
	sizeBytesByQuantization: Record<string, number>;
	sizeLabel: string;
	/**
	 * Normalized 0..1 speed score derived from published RTFx (log-scaled
	 * because the catalog spans 100×–2000×). ``0.5`` = unknown → hidden bar.
	 */
	speedScore: number;
	supportsLanguageDetection: boolean;
	/** Can drive live preview, possibly through rolling/window re-decode. */
	previewCapable: boolean;
	/** Uses a stateful decoder that accepts only new audio chunks. */
	nativeStreaming: boolean;
	/** Live preview can be reused as the final paste without re-decoding. */
	finalReuseSafe: boolean;
	/** @deprecated Use `previewCapable`; this legacy field is a compatibility alias. */
	supportsRealtime: boolean;
}

/** Zod schema for server-sent model catalog items (snake_case). */
const rawModelInfoSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	backend: TranscriberBackendSchema,
	family: ModelFamilySchema,
	languages: z.array(z.string()),
	supports_language_detection: z.boolean(),
	size_label: z.string(),
	supports_realtime: z.boolean().optional(),
	preview_capable: z.boolean().optional(),
	native_streaming: z.boolean().default(false),
	final_reuse_safe: z.boolean().default(false),
	onnx_model_name: z.string().nullable(),
	description: z.string(),
	available_quantizations: z.array(z.string()).default([""]),
	// Per-quantization HF download size in bytes. Catalog rows refreshed
	// before this field shipped will be missing it; default to empty so the
	// dialog falls back to `size_label` for them.
	size_bytes_by_quantization: z.record(z.string(), z.number()).default({}),
	// `available` / `error_message` / `local_path` are additive fields the
	// server started emitting alongside the custom-model scanner. Older
	// servers that haven't been redeployed yet won't send them; the defaults
	// preserve the pre-custom-models shape ("every entry is available").
	available: z.boolean().default(true),
	error_message: z.string().default(""),
	local_path: z.string().nullable().default(null),
	// Normalized perf scores from the server. Default 0.5 keeps the picker
	// compatible with older servers that haven't started emitting these yet
	// — the PerfBars component treats 0.5 as the "unknown" hide-bar sentinel.
	speed_score: z.number().default(0.5),
	accuracy_score: z.number().default(0.5),
});

type RawModelInfo = z.infer<typeof rawModelInfoSchema>;

const STREAMING_LATENCY_TOKEN_RE = /^\d+ms$/i;
const STREAMING_LATENCY_QUANT_TOKEN_RE = /^(?:int8|fp16|fp32)$/i;

function displayNameWithoutStreamingLatency(displayName: string): string {
	const tokens = displayName.trim().split(/\s+/);
	const out: string[] = [];
	let skipQuantAfterLatency = false;
	for (const token of tokens) {
		if (skipQuantAfterLatency && STREAMING_LATENCY_QUANT_TOKEN_RE.test(token)) {
			skipQuantAfterLatency = false;
			continue;
		}
		skipQuantAfterLatency = false;
		if (STREAMING_LATENCY_TOKEN_RE.test(token)) {
			skipQuantAfterLatency = true;
			continue;
		}
		out.push(token);
	}
	return out.join(" ");
}

function mapModel(raw: RawModelInfo): ModelInfo {
	const previewCapable = raw.preview_capable ?? raw.supports_realtime ?? false;
	return {
		id: raw.id,
		displayName: displayNameWithoutStreamingLatency(raw.display_name),
		backend: raw.backend,
		family: raw.family,
		languages: raw.languages,
		supportsLanguageDetection: raw.supports_language_detection,
		sizeLabel: raw.size_label,
		previewCapable,
		nativeStreaming: raw.native_streaming,
		finalReuseSafe: raw.final_reuse_safe,
		supportsRealtime: previewCapable,
		onnxModelName: raw.onnx_model_name,
		description: raw.description,
		availableQuantizations: raw.available_quantizations,
		sizeBytesByQuantization: raw.size_bytes_by_quantization,
		available: raw.available,
		errorMessage: raw.error_message,
		localPath: raw.local_path,
		speedScore: raw.speed_score,
		accuracyScore: raw.accuracy_score,
	};
}

interface CatalogState {
	getFamilies: () => string[];
	getModel: (id: string) => ModelInfo | undefined;
	isLoaded: boolean;
	models: ModelInfo[];
	setModels: (raw: unknown[]) => void;
}

function applyRaw(raw: unknown[]): { models: ModelInfo[]; isLoaded: boolean } {
	const models: ModelInfo[] = [];
	for (const item of raw) {
		const parsed = rawModelInfoSchema.safeParse(item);
		if (parsed.success) {
			models.push(mapModel(parsed.data));
		}
	}
	return { models, isLoaded: true };
}

function applyNonEmptyRaw(raw: unknown[]): void {
	const next = applyRaw(raw);
	if (next.models.length > 0) {
		useCatalogStore.setState(next);
	}
}

let catalogStoreInitialized = false;
let unsubscribeModelCatalog: (() => void) | null = null;

export const useCatalogStore = create<CatalogState>()((set, get) => ({
	models: [],
	isLoaded: false,
	setModels: (raw) => set(applyRaw(raw)),
	getModel: (id) => get().models.find((m) => m.id === id),
	getFamilies: () => [...new Set(get().models.map((m) => m.family))],
}));

/**
 * Fetches the cached model catalog from the main process and subscribes to
 * live catalog updates. Safe to retry after bootstrap installs `nativeBridge`.
 * Exported for unit tests that need to trigger initialization manually.
 */
export function initCatalogStore(): void {
	if (
		typeof window === "undefined" ||
		window.nativeBridge == null ||
		catalogStoreInitialized
	) {
		return;
	}
	catalogStoreInitialized = true;
	fetchModelCatalog().then((raw) => {
		if (Array.isArray(raw)) {
			applyNonEmptyRaw(raw);
		}
	});
	unsubscribeModelCatalog = onModelCatalog(applyNonEmptyRaw);
}

export function _resetCatalogStoreInitForTests(): void {
	unsubscribeModelCatalog?.();
	unsubscribeModelCatalog = null;
	catalogStoreInitialized = false;
}

// Self-initializing: fetch cached catalog from main process on import,
// and subscribe to live updates when the bridge already exists. Window bootstraps
// also call initCatalogStore() after installing the bridge, covering early imports.
// Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,StringLiteral,BlockStatement: guard for non-bridge environments (SSR / tests w/o nativeBridge). Mutating this branch is an equivalent mutant in unit tests since initCatalogStore() is also called explicitly elsewhere.
if (typeof window !== "undefined" && window.nativeBridge != null) {
	initCatalogStore();
}
