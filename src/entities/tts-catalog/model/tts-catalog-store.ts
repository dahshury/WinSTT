import { z } from "zod";
import { create } from "zustand";
import {
	fetchTtsModelsWithState,
	onTtsModelCacheChanged,
	type TtsModelStateEntry,
} from "@/shared/api/ipc-client";

/**
 * How the model handles voice cloning, mirroring the server's
 * ``cloning`` discriminant:
 *   - ``none``                          fixed voice bank only (Kokoro, Piper, …)
 *   - ``zero_shot_audio``               clone from a reference clip alone
 *   - ``zero_shot_audio_transcript``    clone from a reference clip + its transcript
 */
export type TtsCloning =
	| "none"
	| "zero_shot_audio"
	| "zero_shot_audio_transcript";

export interface TtsModelInfo {
	/**
	 * `true` for shipped catalog rows. `false` only for models the server
	 * couldn't resolve (engine pack missing on this platform, etc.). The
	 * picker greys these out so the user can't select an unusable engine.
	 */
	available: boolean;
	availableQuantizations: string[];
	/** Voice-cloning capability — see {@link TtsCloning}. */
	cloning: TtsCloning;
	description: string;
	displayName: string;
	/** Stable catalog id (e.g. `kokoro-82m`). Matches `settings.tts.model`. */
	id: string;
	/** Engine family the model runs on (`kokoro`, `kitten`, `piper`, `supertonic`). */
	engine: string;
	languages: string[];
	maker: string;
	numVoices: number;
	/** Author-published parameter count in millions; `0` when unknown. */
	paramCountM: number;
	/**
	 * Normalized 0..1 perceived-quality score. ``0.5`` is the "unknown"
	 * sentinel — the picker hides the bar in that case.
	 */
	qualityScore: number;
	sampleRate: number;
	/**
	 * Exact on-HF download size in bytes for each available quantization.
	 * Empty for catalog rows the refresh hasn't covered; consumers fall back
	 * to `sizeLabel` (the param-derived human label) in that case.
	 */
	sizeBytesByQuantization: Record<string, number>;
	sizeLabel: string;
	/**
	 * Normalized 0..1 synthesis-speed score. ``0.5`` = unknown → hidden bar.
	 */
	speedScore: number;
}

/** Zod schema for server-sent TTS model catalog items (snake_case). */
const TtsCloningSchema = z.enum([
	"none",
	"zero_shot_audio",
	"zero_shot_audio_transcript",
]);

const rawTtsModelSchema = z.object({
	id: z.string(),
	engine: z.string(),
	display_name: z.string(),
	maker: z.string().default(""),
	languages: z.array(z.string()).default([]),
	num_voices: z.number().default(0),
	cloning: TtsCloningSchema.default("none"),
	sample_rate: z.number().default(24000),
	param_count_m: z.number().default(0),
	size_label: z.string().default(""),
	available_quantizations: z.array(z.string()).default([""]),
	// Per-quantization HF download size in bytes. Catalog rows refreshed
	// before this field shipped will be missing it; default to empty so the
	// dialog falls back to `size_label` for them.
	size_bytes_by_quantization: z.record(z.string(), z.number()).default({}),
	// Normalized perf scores from the server. Default 0.5 keeps the picker
	// compatible with older servers that haven't started emitting these yet
	// — the PerfBars component treats 0.5 as the "unknown" hide-bar sentinel.
	quality_score: z.number().default(0.5),
	speed_score: z.number().default(0.5),
	description: z.string().default(""),
	// Older servers that haven't started emitting `available` yet preserve the
	// pre-multi-provider shape ("every entry is available").
	available: z.boolean().default(true),
});

type RawTtsModelInfo = z.infer<typeof rawTtsModelSchema>;

function mapTtsModel(raw: RawTtsModelInfo): TtsModelInfo {
	return {
		id: raw.id,
		engine: raw.engine,
		displayName: raw.display_name,
		maker: raw.maker,
		languages: raw.languages,
		numVoices: raw.num_voices,
		cloning: raw.cloning,
		sampleRate: raw.sample_rate,
		paramCountM: raw.param_count_m,
		sizeLabel: raw.size_label,
		availableQuantizations: raw.available_quantizations,
		sizeBytesByQuantization: raw.size_bytes_by_quantization,
		qualityScore: raw.quality_score,
		speedScore: raw.speed_score,
		description: raw.description,
		available: raw.available,
	};
}

interface TtsCatalogState {
	getEngines: () => string[];
	getModel: (id: string) => TtsModelInfo | undefined;
	isLoaded: boolean;
	models: TtsModelInfo[];
	setModels: (raw: unknown[]) => void;
}

function applyRaw(raw: unknown[]): {
	models: TtsModelInfo[];
	isLoaded: boolean;
} {
	const models: TtsModelInfo[] = [];
	for (const item of raw) {
		const parsed = rawTtsModelSchema.safeParse(item);
		if (parsed.success) {
			models.push(mapTtsModel(parsed.data));
		}
	}
	return { models, isLoaded: true };
}

export const useTtsCatalogStore = create<TtsCatalogState>()((set, get) => ({
	models: [],
	isLoaded: false,
	setModels: (raw) => set(applyRaw(raw)),
	getModel: (id) => get().models.find((m) => m.id === id),
	getEngines: () => [...new Set(get().models.map((m) => m.engine))],
}));

/**
 * Per-model cache state from the server, keyed by model id.
 *
 * Backs the TTS picker's badges: "Downloaded" / "47%" / "Not downloaded"
 * per quantization. Refreshed on picker mount via
 * ``fetchTtsModelsWithState``; live updates come through
 * ``tts:model-cache-changed`` (push) so badges flip without polling after a
 * download finishes.
 */
interface TtsModelStateStore {
	getState: (id: string) => TtsModelStateEntry | undefined;
	isLoaded: boolean;
	refresh: () => Promise<void>;
	setAll: (entries: TtsModelStateEntry[]) => void;
	statesById: Record<string, TtsModelStateEntry>;
}

function toMap(
	entries: TtsModelStateEntry[],
): Record<string, TtsModelStateEntry> {
	const out: Record<string, TtsModelStateEntry> = {};
	for (const e of entries) {
		out[e.id] = e;
	}
	return out;
}

// In-flight refresh promise — collapses bursts (picker mount + cache-changed
// pushes) into one round-trip without changing the contract (every caller
// still awaits a fresh result). Mirrors the STT model-state store.
let pendingRefresh: Promise<void> | null = null;

export const useTtsModelStateStore = create<TtsModelStateStore>()(
	(set, get) => ({
		statesById: {},
		isLoaded: false,
		setAll: (entries) => set({ statesById: toMap(entries), isLoaded: true }),
		refresh: () => {
			if (pendingRefresh) {
				return pendingRefresh;
			}
			const run = async () => {
				const payload = await fetchTtsModelsWithState();
				if (
					payload &&
					Array.isArray(payload.models) &&
					payload.models.length > 0
				) {
					useTtsCatalogStore.getState().setModels(payload.models);
				}
				if (payload && Array.isArray(payload.states)) {
					set({ statesById: toMap(payload.states), isLoaded: true });
				}
			};
			pendingRefresh = run().finally(() => {
				pendingRefresh = null;
			});
			return pendingRefresh;
		},
		getState: (id) => get().statesById[id],
	}),
);

/** Fetches the TTS catalog state and subscribes to live cache invalidations. */
function initTtsCatalogStore(): () => void {
	useTtsModelStateStore.getState().refresh();
	const unsubCache = onTtsModelCacheChanged(() => {
		useTtsModelStateStore.getState().refresh();
	});
	return () => {
		unsubCache();
	};
}

// Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,StringLiteral,BlockStatement: guard for non-bridge environments (SSR / tests w/o nativeBridge).
if (typeof window !== "undefined" && window.nativeBridge != null) {
	initTtsCatalogStore();
}
