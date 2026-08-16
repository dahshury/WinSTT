import { z } from "zod";
import { create } from "zustand";
import {
	fetchTtsModelsWithState,
	onTtsModelCacheChanged,
	type TtsModelStateEntry,
} from "@/shared/api/ipc-client";
import { hasNativeRuntime } from "@/shared/api/native-boundary";

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

/**
 * Delimiter style for a model's inline paralinguistic tags, mirroring the
 * server's ``tag_syntax`` discriminant:
 *   - ``none``    the model has no tag vocabulary
 *   - ``angle``   `<laugh>` (Orpheus)
 *   - ``square``  `[laugh]` (Chatterbox Turbo)
 *
 * The two styles are NOT interchangeable — a `[laugh]` fed to Orpheus is spoken
 * out loud. Always render a tag through `formatInlineTag(syntax, tag)` rather
 * than typing a delimiter into a component.
 */
export type TtsTagSyntax = "none" | "angle" | "square";

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
	/**
	 * `true` for a voice-design model (Qwen3-TTS-VoiceDesign): the voice is
	 *described* with a free-text prompt rather than picked from a bank or
	 * cloned from a clip. Drives the "Voice design" badge on the card and the
	 * "Design voice" prompt affordance in TTS settings. `false` for every other
	 * engine — the field defaults to `false` server-side so older servers that
	 * don't emit it stay compatible.
	 */
	voiceDesign: boolean;
	/**
	 * Character budget for the voice-design prompt, straight from the catalog
	 * row. `0` whenever `voiceDesign` is false (and on servers that predate the
	 * field) — consumers must treat `0` as "no cap known" rather than "no
	 * characters allowed". The number is a product decision that lives in
	 * `catalog.rs`; never re-type it in the UI.
	 */
	voiceDesignMaxChars: number;
	/**
	 * The model takes a natural-language style instruction ALONGSIDE its voice
	 * (OmniVoice's dedicated instruct span), stored in `tts.voiceInstruct`.
	 * Distinct from `voiceDesign`, where the prompt IS the voice and overloads
	 * `tts.voice` — a cloning row needs that field for the reference-clip path,
	 * so the editor renders as an EXTRA control instead of replacing the voice.
	 */
	voiceInstruct: boolean;
	/**
	 * Longest reference clip (in seconds) the model's cloning path accepts —
	 * longer clips are trimmed server-side. `0` whenever the model does not
	 * clone (and on servers that predate the field), which consumers must read
	 * as "no limit known", never as "zero seconds allowed". The number is a
	 * product decision that lives in `catalog.rs`; never re-type it in the UI.
	 */
	maxRefClipSecs: number;
	/**
	 * Delimiter style for {@link TtsModelInfo.tags} — see {@link TtsTagSyntax}.
	 * `"none"` for every model without a tag vocabulary.
	 */
	tagSyntax: TtsTagSyntax;
	/**
	 * BARE inline paralinguistic tag names (`laugh`, `sigh`, …) with NO
	 * delimiters — the delimiters come from {@link TtsModelInfo.tagSyntax}, so
	 * the two shipped syntaxes never get hardcoded at a call site. Empty when
	 * the model supports no inline tags.
	 */
	tags: string[];
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
	/**
	 * The model cannot synthesize AT ALL until a reference clip (and, when
	 * `cloning === "zero_shot_audio_transcript"`, its transcript) is supplied —
	 * its sentinel voice is an error, not a bundled fallback. Distinct from
	 * `cloning !== "none"`, which only says the model CAN clone: Chatterbox,
	 * Spark and OmniVoice all clone AND ship something usable out of the box.
	 */
	requiresReferenceClip: boolean;
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

const TtsTagSyntaxSchema = z.enum(["none", "angle", "square"]);

/**
 * Exported ONLY for the Rust↔zod wire-key parity gate
 * (`tts-model-info.parity.test.ts`). Runtime consumers go through
 * `useTtsCatalogStore`, never this schema directly: `applyRaw` is the one place
 * allowed to decide what a failed row means (it drops it).
 */
export const rawTtsModelSchema = z.object({
	id: z.string(),
	engine: z.string(),
	display_name: z.string(),
	maker: z.string().default(""),
	languages: z.array(z.string()).default([]),
	num_voices: z.number().default(0),
	cloning: TtsCloningSchema.default("none"),
	// The row cannot synthesize at all until a reference clip is supplied. Default
	// false = "the server didn't tell us", i.e. assume the model works out of the
	// box — the same old-server compat contract every other field here honors, and
	// the safe direction: a missing warning beats a false one.
	requires_reference_clip: z.boolean().default(false),
	// Voice-design capability flag (Qwen3-TTS-VoiceDesign). Default false keeps
	// the picker compatible with older servers that predate the field.
	voice_design: z.boolean().default(false),
	// Per-model character budget for the design prompt. Default 0 = "the server
	// didn't tell us", which the UI reads as "no cap" — the same old-server
	// compat contract every other field in this schema honors.
	voice_design_max_chars: z.number().default(0),
	// Style instruction alongside the voice. Default false = "the server didn't
	// tell us", i.e. no instruct field, matching the old-server compat contract.
	voice_instruct: z.boolean().default(false),
	// Cloning reference-clip budget, `0` = "the server didn't tell us". Same
	// old-server compat contract as every other field in this schema.
	max_ref_clip_secs: z.number().default(0),
	// Inline paralinguistic tag vocabulary + its delimiter style. Defaults keep
	// pre-field servers parsing (no tags → no badge).
	tag_syntax: TtsTagSyntaxSchema.default("none"),
	tags: z.array(z.string()).default([]),
	sample_rate: z.number().default(24_000),
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
		requiresReferenceClip: raw.requires_reference_clip,
		voiceDesign: raw.voice_design,
		voiceDesignMaxChars: raw.voice_design_max_chars,
		voiceInstruct: raw.voice_instruct,
		maxRefClipSecs: raw.max_ref_clip_secs,
		tagSyntax: raw.tag_syntax,
		tags: raw.tags,
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

// Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,StringLiteral,BlockStatement: guard for non-native environments (SSR / browser preview).
if (hasNativeRuntime()) {
	initTtsCatalogStore();
}
