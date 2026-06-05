import {
  AudioWave02Icon,
  CatIcon,
  FlashIcon,
  VoiceIcon,
  WaterfallUp01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import {
  FAVORITES_GROUP_VALUE,
  withFavoritesGroup as withCoreFavoritesGroup,
} from "../../core/favorites";

/**
 * TTS engine key — the `engine` discriminator on {@link TtsModelInfo}. The
 * catalog ships four engines (Kokoro / Kitten / Piper / Supertonic); the
 * `string` fallback keeps the picker forward-compatible with any engine the
 * server starts emitting before this config is updated (it falls back to the
 * neutral default config rather than throwing).
 */
export type TtsEngineKey = TtsModelInfo["engine"];

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
    chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  kitten: {
    icon: CatIcon,
    label: "Kitten",
    maker: "KittenML",
    logoSrc: "/provider-icons/kittenml.webp",
    chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  },
  piper: {
    icon: WaterfallUp01Icon,
    label: "Piper",
    maker: "Rhasspy",
    logoSrc: "/provider-icons/rhasspy.webp",
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  supertonic: {
    icon: FlashIcon,
    label: "Supertonic",
    maker: "Supertone",
    logoSrc: "/provider-icons/supertone.webp",
    chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  chatterbox: {
    icon: VoiceIcon,
    label: "Chatterbox",
    maker: "Resemble AI",
    logoSrc: "/provider-icons/resemble.webp",
    chip: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  },
};

const DEFAULT_ENGINE_CONFIG: TtsEngineConfig = {
  icon: VoiceIcon,
  label: "Speech",
  maker: "Unknown",
  chip: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
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
};

/**
 * Lowercase search corpus for a TTS model — display fields plus the engine
 * label / maker / aliases / languages. Centralised so the search input and any
 * future global search share one definition (mirrors `buildModelSearchCorpus`).
 */
export function buildTtsSearchCorpus(model: TtsModelInfo): string {
  const cfg = getEngineConfig(model.engine);
  const aliases = (ENGINE_SEARCH_ALIASES[model.engine] ?? []).join(" ");
  return [
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
    const sorted = [...items].sort((a, b) => a.paramCountM - b.paramCountM);
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
  value: TtsEngineKey | typeof FAVORITES_GROUP_VALUE;
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

/**
 * Human label for a model's voice-cloning capability. `'none'` returns `null`
 * (no chip rendered); the two zero-shot tiers spell out what the user can
 * provide so the affordance is legible at a glance.
 */
export function cloningLabel(cloning: TtsModelInfo["cloning"]): {
  label: string;
  tooltip: string;
} | null {
  if (cloning === "zero_shot_audio") {
    return {
      label: "Voice cloning",
      tooltip: "Zero-shot voice cloning from a short reference audio clip",
    };
  }
  if (cloning === "zero_shot_audio_transcript") {
    return {
      label: "Voice cloning",
      tooltip:
        "Zero-shot voice cloning from a short reference audio clip and its transcript",
    };
  }
  return null;
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
