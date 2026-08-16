import {
	AudioWave02Icon,
	CatIcon,
	FlashIcon,
	VoiceIcon,
	WaterfallUp01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { TtsModelInfo, TtsTagSyntax } from "../model/tts-catalog-store";
import type { ModelPickerTranslateFn } from "@/shared/i18n/translation-types";
import {
	type FAVORITES_GROUP_VALUE,
	withFavoritesGroup as withCoreFavoritesGroup,
} from "@/shared/ui/model-picker/core/favorites";

/**
 * TTS engine key — the `engine` discriminator on {@link TtsModelInfo}. The
 * catalog ships four engines (Kokoro / Kitten / Piper / Supertonic); the
 * `string` fallback keeps the picker forward-compatible with any engine the
 * server starts emitting before this config is updated (it falls back to the
 * neutral default config rather than throwing).
 */
export type TtsEngineKey = TtsModelInfo["engine"];

/** Synthetic group used when an explicit sort flattens all engine sections. */
export const TTS_SORTED_GROUP_VALUE = "__tts-sorted__" as const;

interface TtsEngineConfig {
	/** Tailwind classes for the engine chip (background + foreground). Kept for
	 *  parity with the STT family config even though the muted FF palette uses
	 *  it sparingly. */
	chip: string;
	/** HugeIcons glyph shown when no brand `logoSrc` is bundled. */
	icon: IconSvgElement;
	/** Display label for the engine (group header + trigger chip). */
	label: string;
	/** The org / maker behind the engine — drives the group header subtitle. */
	maker: string;
	/** Public path to a brand-logo image (the maker's official mark, bundled in
	 *  `public/provider-icons/`). Rendered via {@link getEngineLogoSrc} on every
	 *  card, the group header, and the trigger; falls back to the HugeIcon glyph
	 *  when absent (an unknown future engine). */
	logoSrc?: string;
}

/**
 * Per-engine presentation — the TTS analogue of the STT family config. New
 * engines fall through to {@link DEFAULT_ENGINE_CONFIG} so an unknown engine
 * still renders (with a neutral chip + generic voice glyph) instead of
 * crashing the picker.
 */
const ENGINE_CONFIG: Record<string, TtsEngineConfig> = {
	kokoro: {
		icon: AudioWave02Icon,
		label: "Kokoro",
		maker: "hexgrad",
		logoSrc: "/provider-icons/hexgrad.webp",
		chip: "bg-tts-engine-kokoro/15 text-tts-engine-kokoro",
	},
	kitten: {
		icon: CatIcon,
		label: "Kitten",
		maker: "KittenML",
		logoSrc: "/provider-icons/kittenml.webp",
		chip: "bg-tts-engine-kitten/15 text-tts-engine-kitten",
	},
	piper: {
		icon: WaterfallUp01Icon,
		label: "Piper",
		maker: "Rhasspy",
		logoSrc: "/provider-icons/rhasspy.svg",
		chip: "bg-tts-engine-piper/15 text-tts-engine-piper",
	},
	supertonic: {
		icon: FlashIcon,
		label: "Supertonic",
		maker: "Supertone",
		logoSrc: "/provider-icons/supertone.svg",
		chip: "bg-tts-engine-supertonic/15 text-tts-engine-supertonic",
	},
	chatterbox: {
		icon: VoiceIcon,
		label: "Chatterbox",
		maker: "Resemble AI",
		logoSrc: "/provider-icons/resemble.svg",
		chip: "bg-tts-engine-chatterbox/15 text-tts-engine-chatterbox",
	},
	qwen3tts: {
		icon: VoiceIcon,
		label: "Qwen3-TTS",
		maker: "Qwen",
		logoSrc: "/provider-icons/qwen.svg",
		chip: "bg-tts-engine-qwen3tts/15 text-tts-engine-qwen3tts",
	},
	orpheus: {
		icon: VoiceIcon,
		label: "Orpheus",
		maker: "Canopy Labs",
		logoSrc: "/provider-icons/canopylabs.svg",
		chip: "bg-tts-engine-orpheus/15 text-tts-engine-orpheus",
	},
	spark: {
		icon: FlashIcon,
		label: "Spark-TTS",
		maker: "SparkAudio",
		logoSrc: "/provider-icons/sparkaudio.jpg",
		chip: "bg-tts-engine-spark/15 text-tts-engine-spark",
	},
	// Neither vendor publishes an SVG mark (checked neuphonic.com, k2-fsa.github.io and
	// both GitHub orgs), so these are the canonical Hugging Face org avatars — the same
	// PNG fallback `funaudiollm`/`alpindale` already use.
	neutts: {
		icon: VoiceIcon,
		label: "NeuTTS",
		maker: "Neuphonic",
		logoSrc: "/provider-icons/neuphonic.png",
		chip: "bg-tts-engine-neutts/15 text-tts-engine-neutts",
	},
	omnivoice: {
		icon: VoiceIcon,
		label: "OmniVoice",
		maker: "k2-fsa",
		logoSrc: "/provider-icons/k2-fsa.png",
		chip: "bg-tts-engine-omnivoice/15 text-tts-engine-omnivoice",
	},
	// Audio8 publishes no standalone SVG mark — this is the canonical Hugging Face
	// org avatar (a webp despite the CDN's .jpeg URL), like neuphonic/k2-fsa.
	audio8: {
		icon: VoiceIcon,
		label: "Audio8",
		maker: "Audio8",
		// Same traced SVG the STT Audio8 family uses — the vendor avatar renders as a solid tile.
		logoSrc: "/provider-icons/audio8.svg",
		chip: "bg-tts-engine-audio8/15 text-tts-engine-audio8",
	},
};

const DEFAULT_ENGINE_CONFIG: TtsEngineConfig = {
	icon: VoiceIcon,
	label: "Speech",
	maker: "Unknown",
	chip: "bg-tts-engine-unknown/15 text-tts-engine-unknown",
};

export function getEngineConfig(
	engine: TtsEngineKey | string,
): TtsEngineConfig {
	return ENGINE_CONFIG[engine] ?? DEFAULT_ENGINE_CONFIG;
}

/** Engine label (e.g. "Kokoro") for group headers and trigger chips. */
export function getEngineLabel(engine: TtsEngineKey | string): string {
	return getEngineConfig(engine).label;
}

/** Org / maker behind the engine (e.g. "hexgrad") for the group-header subtitle. */
export function getEngineMaker(engine: TtsEngineKey | string): string {
	return getEngineConfig(engine).maker;
}

/** Public path to the engine maker's brand logo, or `null` when none is bundled
 *  (an unknown future engine — call sites fall back to the HugeIcon glyph). */
export function getEngineLogoSrc(engine: TtsEngineKey | string): string | null {
	return getEngineConfig(engine).logoSrc ?? null;
}

/**
 * Extra synonyms that should also match the engine in search — covers brand
 * nicknames so users can type whatever they know (e.g. "hexgrad" for Kokoro,
 * "rhasspy"/"vits" for Piper).
 */
const ENGINE_SEARCH_ALIASES: Record<string, string[]> = {
	kokoro: ["hexgrad", "kokoro-82m", "82m"],
	kitten: ["kittenml", "kitten ml", "nano"],
	piper: ["rhasspy", "vits", "lessac", "en-us"],
	supertonic: ["supertone", "supertonic-3", "multilingual", "webgpu"],
	chatterbox: ["resemble", "resemble ai", "voice cloning", "multilingual"],
	qwen3tts: [
		"qwen",
		"qwen3",
		"qwen3-tts",
		"alibaba",
		"voice design",
		"multilingual",
	],
	orpheus: ["canopy", "canopy labs", "llama", "emotion", "expressive", "snac"],
	spark: [
		"sparkaudio",
		"spark tts",
		"bicodec",
		"qwen",
		"voice creation",
		"clone",
	],
	neutts: [
		"neuphonic",
		"neutts",
		"neutts-2e",
		"neucodec",
		"emotion",
		"emotional",
		"expressive",
		"qwen3",
	],
	omnivoice: [
		"k2-fsa",
		"k2fsa",
		"sherpa",
		"omni",
		"omnivoice",
		"voice cloning",
		"voice design",
		"multilingual",
	],
	audio8: [
		"audio8",
		"audio 8",
		"ark",
		"arktts",
		"dualar",
		"fish",
		"voice cloning",
		"zero-shot",
		"multilingual",
	],
};

const ttsSearchCorpusCache = new WeakMap<TtsModelInfo, string>();

/**
 * Lowercase search corpus for a TTS model — display fields plus the engine
 * label / maker / aliases / languages. Centralised so the search input and any
 * future global search share one definition (mirrors `buildModelSearchCorpus`).
 */
export function buildTtsSearchCorpus(model: TtsModelInfo): string {
	const cached = ttsSearchCorpusCache.get(model);
	if (cached !== undefined) {
		return cached;
	}
	const cfg = getEngineConfig(model.engine);
	const aliases = (ENGINE_SEARCH_ALIASES[model.engine] ?? []).join(" ");
	const corpus = [
		model.displayName,
		model.id,
		model.engine,
		model.maker,
		cfg.label,
		cfg.maker,
		aliases,
		model.languages.join(" "),
	]
		.join(" ")
		.toLowerCase();
	ttsSearchCorpusCache.set(model, corpus);
	return corpus;
}

/**
 * Base UI Combobox grouped-items shape: one entry per engine with its member
 * models. `value` is the engine key (group identity); the visible heading is
 * derived via {@link getEngineLabel} / {@link getEngineMaker}.
 */
export interface TtsEngineGroup {
	items: TtsModelInfo[];
	value: TtsEngineKey;
}

/**
 * Group models by engine, smallest-param first within each group and the
 * lightest-leading engine first overall — so the picker surfaces the cheapest
 * entry-point first, mirroring the STT picker's `groupModelsByAuthor` ordering.
 * Empty engines are dropped. (TTS models are NOT bundled into variant cards the
 * way Whisper `.en` siblings are — each engine ships distinct models.)
 */
export function groupModelsByEngine(
	models: readonly TtsModelInfo[],
): TtsEngineGroup[] {
	const buckets = new Map<TtsEngineKey, TtsModelInfo[]>();
	const order: TtsEngineKey[] = [];
	for (const model of models) {
		const bucket = buckets.get(model.engine);
		if (bucket === undefined) {
			buckets.set(model.engine, [model]);
			order.push(model.engine);
		} else {
			bucket.push(model);
		}
	}
	const groups: TtsEngineGroup[] = [];
	for (const engine of order) {
		const items = buckets.get(engine);
		if (items === undefined || items.length === 0) {
			continue;
		}
		const sorted = items.toSorted((a, b) => a.paramCountM - b.paramCountM);
		groups.push({ value: engine, items: sorted });
	}
	groups.sort(
		(a, b) => (a.items[0]?.paramCountM ?? 0) - (b.items[0]?.paramCountM ?? 0),
	);
	return groups;
}

/** A picker list group is a real engine group or the synthetic "favorites"
 *  aggregate pinned to the top. Widens {@link TtsEngineGroup} to admit it. */
export interface TtsListGroup {
	items: TtsModelInfo[];
	value:
		| TtsEngineKey
		| typeof FAVORITES_GROUP_VALUE
		| typeof TTS_SORTED_GROUP_VALUE;
}

/**
 * Prepend a synthetic "Favorites" group to the per-engine groups — the TTS
 * analogue of the STT picker's `withFavoritesGroup`, sharing the same
 * {@link collectFavorites} walk so the starred models read in the same
 * maker-sorted, de-duplicated order. Returns the engine groups unchanged
 * (widened) when nothing is starred, so the Favorites group / rail tile only
 * appear once the user has favorited at least one model.
 */
export function withTtsFavoritesGroup(
	groups: readonly TtsEngineGroup[],
	isFavorite: (modelId: string) => boolean,
): TtsListGroup[] {
	return withCoreFavoritesGroup(groups, isFavorite, (model) => model.id);
}

/** Label + tooltip for one voice capability. `null` from a builder means the
 *  model does not advertise that capability, so no chip is rendered. */
export interface TtsCapabilityCopy {
	label: string;
	tooltip: string;
}

/**
 * Human label for a model's voice-cloning capability. `'none'` returns `null`
 * (no chip rendered); the two zero-shot tiers are labelled DIFFERENTLY because
 * they change what the user has to supply — a clip alone (Chatterbox) versus a
 * clip *and* its exact transcript (Spark). The reference-clip budget comes from
 * the catalog row (`maxRefClipSecs`), never from a number typed into the UI.
 */
export function cloningLabel(
	model: Pick<TtsModelInfo, "cloning" | "maxRefClipSecs">,
	t: ModelPickerTranslateFn,
): TtsCapabilityCopy | null {
	if (model.cloning === "none") {
		return null;
	}
	const needsTranscript = model.cloning === "zero_shot_audio_transcript";
	const base = needsTranscript
		? t("ttsCloningTranscriptTip")
		: t("ttsCloningTip");
	// The trim budget is a second, self-contained sentence so translators are
	// never handed a fragment to splice.
	const tooltip =
		model.maxRefClipSecs > 0
			? `${base} ${t("ttsCloningClipLimitTip", { seconds: model.maxRefClipSecs })}`
			: base;
	return {
		label: needsTranscript ? t("ttsCloningTranscript") : t("ttsCloning"),
		tooltip,
	};
}

/**
 * Human label for a model's voice-design capability — the free-text-prompt
 * analogue of {@link cloningLabel}. Voice-design models (Qwen3-TTS-VoiceDesign)
 * synthesize a voice from a described prompt instead of a fixed bank or a cloned
 * clip, so the chip advertises that the voice is customizable by text. Returned
 * shape mirrors `cloningLabel` so `TtsModelCard` composes both chips uniformly.
 */
export function voiceDesignLabel(t: ModelPickerTranslateFn): TtsCapabilityCopy {
	return {
		label: t("ttsVoiceDesign"),
		tooltip: t("ttsVoiceDesignTip"),
	};
}

/** Delimiters per {@link TtsTagSyntax}. The ONE place either style is written
 *  down — Orpheus's `<laugh>` and Chatterbox Turbo's `[laugh]` are not
 *  interchangeable, so no call site may hardcode a bracket. */
const TAG_DELIMITERS: Record<TtsTagSyntax, readonly [string, string] | null> = {
	none: null,
	angle: ["<", ">"],
	square: ["[", "]"],
};

/** Render one BARE tag name in the model's own syntax (`laugh` → `<laugh>` /
 *  `[laugh]`). A `none`-syntax model has no delimiters, so the bare name is
 *  returned unchanged. Deliberately module-private: every surface that shows a
 *  tag goes through {@link inlineTagsLabel}, which is what keeps the two
 *  incompatible syntaxes from being picked apart at a call site. */
function formatInlineTag(syntax: TtsTagSyntax, tag: string): string {
	const delimiters = TAG_DELIMITERS[syntax];
	return delimiters ? `${delimiters[0]}${tag}${delimiters[1]}` : tag;
}

/**
 * The model's whole tag vocabulary rendered in ITS OWN delimiters, space
 * separated (`"<laugh> <sigh> <gasp>"`), or `""` when the row ships no tags.
 *
 * The one exported way to show a tag outside the picker chip: every surface that
 * quotes the vocabulary — the card tooltip via {@link inlineTagsLabel}, the
 * read-aloud "Inline tags" setting — reads it from here, so neither syntax is
 * ever spelled out at a call site.
 */
export function formatInlineTagList(
	model: Pick<TtsModelInfo, "tagSyntax" | "tags">,
): string {
	if (model.tagSyntax === "none" || model.tags.length === 0) {
		return "";
	}
	return model.tags
		.map((tag) => formatInlineTag(model.tagSyntax, tag))
		.join(" ");
}

/**
 * Human label for a model's inline paralinguistic-tag support — the third voice
 * capability alongside cloning and design. `null` (no chip) unless the row ships
 * BOTH a syntax and a vocabulary; the tooltip spells the tags out in the model's
 * own delimiters so the user can copy one straight into their text.
 */
export function inlineTagsLabel(
	model: Pick<TtsModelInfo, "tagSyntax" | "tags">,
	t: ModelPickerTranslateFn,
): TtsCapabilityCopy | null {
	const rendered = formatInlineTagList(model);
	if (rendered === "") {
		return null;
	}
	return {
		label: t("ttsInlineTags"),
		tooltip: t("ttsInlineTagsTip", { tags: rendered }),
	};
}

/**
 * Languages as a single meta fact. Collapses to "Multilingual (N)" with the
 * roster in the tooltip when the model spans several languages, an explicit
 * upper-cased code list when it's a handful, and "English" for the common
 * en-only case — mirroring the STT card's `languageMeta`.
 */
export function ttsLanguageMeta(languages: readonly string[]): {
	label: string;
	tooltip: string;
} {
	if (languages.length === 0) {
		return { label: "—", tooltip: "Language support not reported" };
	}
	if (languages.length === 1 && languages[0]?.toLowerCase() === "en") {
		return { label: "English", tooltip: "English only" };
	}
	const codes = languages.map((l) => l.toUpperCase());
	if (languages.length > 4) {
		return {
			label: `Multilingual (${languages.length})`,
			tooltip: `Supports ${languages.length} languages: ${codes.join(", ")}`,
		};
	}
	return { label: codes.join("/"), tooltip: `Supports: ${codes.join(", ")}` };
}
