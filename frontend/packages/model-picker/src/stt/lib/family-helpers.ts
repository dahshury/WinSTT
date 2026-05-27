import {
	AiChipIcon,
	AudioWave02Icon,
	CpuIcon,
	FlashIcon,
	FolderLibraryIcon,
	Radio01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ModelInfo } from "@/entities/model-catalog";

export type FamilyKey = ModelInfo["family"];

interface FamilyConfig {
	/** Tailwind classes for the family chip (background + foreground). */
	chip: string;
	/** HugeIcons fallback when no brand `logoSrc` is available. */
	icon: IconSvgElement;
	label: string;
	/** Public path to a brand-logo PNG/SVG. When set, the brand logo is shown instead of the HugeIcon. */
	logoSrc?: string;
}

const FAMILY_CONFIG: Record<FamilyKey, FamilyConfig> = {
	whisper: {
		icon: AudioWave02Icon,
		label: "Whisper",
		chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
		logoSrc: "/provider-icons/openai.png",
	},
	"lite-whisper": {
		icon: AudioWave02Icon,
		label: "Lite-Whisper",
		chip: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
		logoSrc: "/provider-icons/openai.png",
	},
	nemo: {
		icon: AiChipIcon,
		label: "NeMo",
		chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
		logoSrc: "/provider-icons/nvidia.png",
	},
	gigaam: {
		icon: Radio01Icon,
		label: "GigaAM",
		chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
		logoSrc: "/provider-icons/sber-salute.png",
	},
	kaldi: {
		icon: CpuIcon,
		label: "Kaldi",
		chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
		logoSrc: "/provider-icons/alpha-cephei.png",
	},
	"t-one": {
		icon: FlashIcon,
		label: "T-One",
		chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
		logoSrc: "/provider-icons/t-tech.png",
	},
	moonshine: {
		icon: FlashIcon,
		label: "Moonshine",
		chip: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
		// No brand logo bundled — Useful Sensors doesn't ship one in
		// provider-icons/, so we fall back to the HugeIcon.
	},
	cohere: {
		icon: AiChipIcon,
		label: "Cohere",
		chip: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
		logoSrc: "/provider-icons/cohere.png",
	},
	sense_voice: {
		icon: AudioWave02Icon,
		label: "SenseVoice",
		chip: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
		// No brand logo bundled — FunAudioLLM (Alibaba) doesn't ship one in
		// provider-icons/, so we fall back to the HugeIcon. Matches the
		// pattern Moonshine uses.
	},
	custom: {
		icon: FolderLibraryIcon,
		label: "Custom",
		chip: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
		// No brand logo — these are user-provided drops, not first-party models.
	},
};

export function getFamilyConfig(family: FamilyKey): FamilyConfig {
	return FAMILY_CONFIG[family];
}

/** The org/maker behind each model family — drives the group header. */
const FAMILY_AUTHOR: Record<FamilyKey, string> = {
	whisper: "OpenAI",
	"lite-whisper": "Efficient-Speech",
	nemo: "NVIDIA",
	gigaam: "Sber Salute",
	kaldi: "Alpha Cephei",
	"t-one": "T-Tech",
	moonshine: "Useful Sensors",
	cohere: "Cohere",
	sense_voice: "FunAudioLLM",
	custom: "Your Models",
};

export function getAuthorLabel(family: FamilyKey): string {
	return FAMILY_AUTHOR[family];
}

/**
 * Extra synonyms that should also match the family in search — covers common
 * brand nicknames (e.g. "tinkoff" for T-Tech, "sber" for Sber Salute, "vosk"
 * for Kaldi/Alpha Cephei) so users can type whatever brand they know.
 */
const FAMILY_SEARCH_ALIASES: Record<FamilyKey, string[]> = {
	whisper: ["openai", "open ai", "breeze", "mediatek"],
	"lite-whisper": ["efficient-speech", "efficient speech", "lite", "litewhisper"],
	nemo: ["nvidia", "parakeet", "canary"],
	gigaam: ["sber", "salute", "sberbank", "sberdevices", "salutedevices"],
	kaldi: ["alpha cephei", "alphacephei", "vosk"],
	"t-one": ["t-tech", "t tech", "t-bank", "tinkoff", "tbank"],
	moonshine: ["useful sensors", "useful-sensors", "moon", "streaming"],
	cohere: ["cohere ai", "command", "transcribe"],
	sense_voice: [
		"sensevoice",
		"sense-voice",
		"sense voice",
		"funaudiollm",
		"funasr",
		"alibaba",
		"damo",
	],
	custom: ["custom", "user", "local", "byo", "bring your own"],
};

/**
 * Builds the lowercase search corpus for a model: display fields plus the
 * authoring org and any brand aliases. Centralised here so the search input
 * and any future "global search" share one definition.
 */
export function buildModelSearchCorpus(model: ModelInfo): string {
	const author = FAMILY_AUTHOR[model.family];
	const aliases = FAMILY_SEARCH_ALIASES[model.family].join(" ");
	const label = FAMILY_CONFIG[model.family].label;
	return [
		model.displayName,
		model.id,
		model.family,
		model.sizeLabel,
		label,
		author,
		aliases,
		model.languages.join(" "),
	]
		.join(" ")
		.toLowerCase();
}

const SIZE_UNIT_MULTIPLIER: Record<string, number> = {
	"": 1,
	K: 1e3,
	M: 1e6,
	B: 1e9,
	T: 1e12,
};

const SIZE_LABEL_RE = /^([\d.]+)\s*([KMBT]?)/i;

/**
 * Parses a parameter-count label like "39M" / "1.5B" / "600M" into a numeric
 * value used purely for ordering. Unrecognised labels sort last.
 */
export function parseParameterSize(sizeLabel: string): number {
	const match = sizeLabel.trim().match(SIZE_LABEL_RE);
	if (!match || match[1] === undefined) {
		return Number.POSITIVE_INFINITY;
	}
	const value = Number.parseFloat(match[1]);
	if (Number.isNaN(value)) {
		return Number.POSITIVE_INFINITY;
	}
	const unit = (match[2] ?? "").toUpperCase();
	return value * (SIZE_UNIT_MULTIPLIER[unit] ?? 1);
}

function bucketByFamily(models: readonly ModelInfo[]): Map<FamilyKey, ModelInfo[]> {
	const grouped = new Map<FamilyKey, ModelInfo[]>();
	for (const m of models) {
		const list = grouped.get(m.family) ?? [];
		list.push(m);
		grouped.set(m.family, list);
	}
	return grouped;
}

/**
 * Group models by family. Both the *group* order and the order *within* each
 * group are driven by parameter count (smallest → largest), so the picker
 * surfaces the cheapest entry-point in each family first and the cheapest
 * family overall ends up at the top. Empty families are dropped.
 */
export function groupByFamily(models: readonly ModelInfo[]): [FamilyKey, ModelInfo[]][] {
	const grouped = bucketByFamily(models);
	const entries: [FamilyKey, ModelInfo[]][] = [];
	for (const [family, list] of grouped) {
		if (list.length === 0) {
			continue;
		}
		const sorted = [...list].sort(
			(a, b) => parseParameterSize(a.sizeLabel) - parseParameterSize(b.sizeLabel)
		);
		entries.push([family, sorted]);
	}
	entries.sort(
		([, a], [, b]) =>
			parseParameterSize(a[0]?.sizeLabel ?? "") - parseParameterSize(b[0]?.sizeLabel ?? "")
	);
	return entries;
}

/**
 * Base UI Combobox grouped-items shape: one entry per author/family with its
 * member models. `value` is the family key (used as the group identity);
 * the visible heading is derived via {@link getAuthorLabel}.
 */
export interface AuthorGroup {
	items: ModelInfo[];
	value: FamilyKey;
}

export function groupModelsByAuthor(models: readonly ModelInfo[]): AuthorGroup[] {
	return groupByFamily(models).map(([value, items]) => ({ value, items }));
}

/**
 * A "variant bundle" pairs a multilingual base model with its ``.en``
 * English-only sibling (when both are present in the same family) so the
 * picker can render them as one collapsible card instead of two adjacent
 * rows. Singletons stay as a 1-item bundle for uniform rendering.
 */
export interface VariantBundle {
	/** Stable id for the bundle as a whole — used as the expansion key. */
	baseId: string;
	/**
	 * 1 or 2 entries. When 2: ``[multilingual, englishOnly]``. The
	 * multilingual variant is the "primary" — clicking the bundle card
	 * selects it; the chevron reveals the .en sibling.
	 */
	variants: ModelInfo[];
}

/** Top-level regex for the lite-whisper compression suffix — hoisted out of
 * :func:`getBaseId` per biome's ``useTopLevelRegex`` perf rule. */
const LITE_WHISPER_FLAVOR_SUFFIX_RE = /-(?:acc|fast)$/;

/** Strip a trailing ``-turbo`` so Whisper's distilled-decoder variant
 * collapses into the same bundle as the full-precision base. Hoisted per
 * the ``useTopLevelRegex`` perf rule. */
const TURBO_SUFFIX_RE = /-turbo$/;

/**
 * Architecture prefixes that group genuine variants of a single model into
 * one bundle. Only families whose variants share the SAME architecture
 * (differing in size, language fine-tune, or quantization flavour) belong
 * here — CTC / RNN-T / TDT decoder choices are different models, not
 * variants, and stay as separate cards.
 *
 * Ordering matters: more-specific prefixes appear FIRST so any future
 * ``X-sub`` family doesn't get swallowed by a shorter ``X`` entry.
 *
 * Examples:
 *   - ``nemo-canary-1b-v2`` + ``nemo-canary-180m-flash`` → ``nemo-canary``
 *     (both are TDT-based Canary; differ only in size).
 *   - ``moonshine-tiny`` + ``moonshine-tiny-zh`` / ``-ja`` / ``-ko`` / etc.
 *       → ``moonshine-tiny`` (the same encoder-only model, language-tuned).
 *   - ``moonshine-base`` likewise.
 */
const ARCH_BUNDLE_PREFIXES: readonly string[] = ["nemo-canary", "moonshine-tiny", "moonshine-base"];

/**
 * Return the longest matching architecture prefix for ``id``, or ``null``
 * if none applies. ``id`` matches a prefix iff it equals the prefix or
 * starts with ``${prefix}-`` (so ``moonshine-tiny`` matches the prefix
 * ``moonshine-tiny`` itself, and ``moonshine-tiny-zh`` also matches but
 * collapses down to the same bundle).
 */
function findArchPrefix(id: string): string | null {
	for (const prefix of ARCH_BUNDLE_PREFIXES) {
		if (id === prefix || id.startsWith(`${prefix}-`)) {
			return prefix;
		}
	}
	return null;
}

/** Strip wrapper prefixes/suffixes to find the model's architectural base id.
 *
 * - ``lite-whisper-X`` -> ``X`` (Lite-Whisper is an SVD compression of base
 *   ``X``; the user explicitly wants these grouped with their original
 *   architecture rather than spun off as a separate "Efficient-Speech"
 *   provider).
 * - ``lite-whisper-X-{acc,fast}`` -> ``X`` (further compression flavours all
 *   share the same base architecture as the canonical lite-whisper variant).
 * - ``X-turbo`` -> ``X`` (Whisper's distilled-decoder variant — same encoder
 *   weights as the base, faster decoder. Belongs in the base bundle so
 *   "Large v3" and "Large v3 Turbo" stack as one card, not two).
 * - ``X.en`` -> ``X`` (English-only sibling of multilingual ``X``).
 *
 * Idempotent - anything that's already a base id passes through unchanged.
 */
export function getBaseId(id: string): string {
	// Architecture prefixes (NeMo Canary, Parakeet, FastConformer; Moonshine
	// tiny/base; GigaAM v2/v3/v3-e2e) bundle by family name with size /
	// decoder / language suffixes as siblings. Checked first because their
	// ids never carry the Whisper-style ``-turbo`` / ``.en`` / ``lite-``
	// affordances handled below — short-circuiting here keeps the Whisper
	// rules from accidentally trimming a NeMo id.
	const archPrefix = findArchPrefix(id);
	if (archPrefix !== null) {
		return archPrefix;
	}
	let base = id;
	if (base.startsWith("lite-whisper-")) {
		base = base.slice("lite-whisper-".length).replace(LITE_WHISPER_FLAVOR_SUFFIX_RE, "");
	}
	// Strip .en before -turbo so any hypothetical ``X-turbo.en`` (none ships
	// today; multilingual-only) collapses cleanly down to ``X``.
	if (base.endsWith(".en")) {
		base = base.slice(0, -3);
	}
	base = base.replace(TURBO_SUFFIX_RE, "");
	return base;
}

/**
 * Magnitude that comfortably exceeds every explicit key (0..3) and every
 * lite-whisper key (10 + raw param count up to ~2 B). The catch-all leans
 * on this to slot architecture bundles AFTER the Whisper-shaped ones
 * within the same bucket without ever overlapping their integer slots.
 */
const ARCH_SORT_OFFSET = 1e12;

/** Order variants inside a bundle: base first, then ``.en`` sibling, then
 * ``-turbo`` variant, then lite-whisper compressions (smallest-param first).
 * Architecture bundles (NeMo / Moonshine / GigaAM) fall through to a
 * catch-all that orders the LARGER variant first, so Canary 1B-v2 lands
 * on top with 180M-flash tucked underneath the chevron. */
function variantSortKey(model: ModelInfo, baseId: string): number {
	if (model.id === baseId) {
		return 0;
	}
	if (model.id === `${baseId}.en`) {
		return 1;
	}
	if (model.id === `${baseId}-turbo`) {
		return 2;
	}
	if (model.id === `${baseId}-turbo.en`) {
		return 3;
	}
	if (model.id.startsWith("lite-whisper-")) {
		// Lite siblings sorted by param count (smallest first), offset to land
		// after the primary + .en + turbo siblings.
		return 10 + parseParameterSize(model.sizeLabel);
	}
	// Architecture-bundle catch-all (NeMo Canary 1B-v2 vs 180M-flash; Moonshine
	// tiny vs tiny-zh; GigaAM v3-ctc vs v3-rnnt). Largest-param-first so the
	// flagship lands on the primary card; the offset guarantees these all sort
	// AFTER any explicit Whisper-shaped sibling that might share the bundle.
	return ARCH_SORT_OFFSET - parseParameterSize(model.sizeLabel);
}

/**
 * Bundle a list of models into variant bundles. Two derivative classes are
 * collapsed into the base model's card:
 *
 * - ``.en`` siblings of multilingual Whisper variants (``tiny`` + ``tiny.en``).
 * - Lite-Whisper compressions of a base architecture (``large-v3-turbo`` +
 *   ``lite-whisper-large-v3-turbo`` + ``lite-whisper-large-v3-turbo-acc`` +
 *   ``lite-whisper-large-v3-turbo-fast``).
 *
 * Each bundle is keyed by its base id; the primary card is the base model
 * (when present in the list) or the first remaining variant. Bundles
 * inherit their order from the first variant's position in the input,
 * preserving the caller's "cheapest first" sort.
 */
export function bundleVariants(items: readonly ModelInfo[]): VariantBundle[] {
	const buckets = new Map<string, ModelInfo[]>();
	const order: string[] = [];
	for (const m of items) {
		const baseId = getBaseId(m.id);
		const bucket = buckets.get(baseId);
		if (bucket === undefined) {
			buckets.set(baseId, [m]);
			order.push(baseId);
		} else {
			bucket.push(m);
		}
	}
	const bundles: VariantBundle[] = [];
	for (const baseId of order) {
		const variants = buckets.get(baseId);
		if (variants === undefined || variants.length === 0) {
			continue;
		}
		const sorted = [...variants].sort(
			(a, b) => variantSortKey(a, baseId) - variantSortKey(b, baseId)
		);
		bundles.push({ baseId, variants: sorted });
	}
	return bundles;
}
