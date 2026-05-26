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
	whisper: ["openai", "open ai"],
	"lite-whisper": ["efficient-speech", "efficient speech", "lite", "litewhisper"],
	nemo: ["nvidia", "parakeet", "canary"],
	gigaam: ["sber", "salute", "sberbank", "sberdevices", "salutedevices"],
	kaldi: ["alpha cephei", "alphacephei", "vosk"],
	"t-one": ["t-tech", "t tech", "t-bank", "tinkoff", "tbank"],
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

/** Strip wrapper prefixes/suffixes to find the model's architectural base id.
 *
 * - ``lite-whisper-X`` -> ``X`` (Lite-Whisper is an SVD compression of base
 *   ``X``; the user explicitly wants these grouped with their original
 *   architecture rather than spun off as a separate "Efficient-Speech"
 *   provider).
 * - ``lite-whisper-X-{acc,fast}`` -> ``X`` (further compression flavours all
 *   share the same base architecture as the canonical lite-whisper variant).
 * - ``X.en`` -> ``X`` (English-only sibling of multilingual ``X``).
 *
 * Idempotent - anything that's already a base id passes through unchanged.
 */
function getBaseId(id: string): string {
	let base = id;
	if (base.startsWith("lite-whisper-")) {
		base = base.slice("lite-whisper-".length).replace(LITE_WHISPER_FLAVOR_SUFFIX_RE, "");
	}
	if (base.endsWith(".en")) {
		base = base.slice(0, -3);
	}
	return base;
}

/** Order variants inside a bundle: base first, then ``.en`` sibling, then
 * lite-whisper compressions sorted by parameter count (cheapest first). */
function variantSortKey(model: ModelInfo, baseId: string): number {
	if (model.id === baseId) {
		return 0;
	}
	if (model.id === `${baseId}.en`) {
		return 1;
	}
	if (model.id.startsWith("lite-whisper-")) {
		// Lite siblings sorted by param count (smallest first), offset to land
		// after the primary + .en sibling.
		return 10 + parseParameterSize(model.sizeLabel);
	}
	// Unknown derivative — push to the end.
	return Number.POSITIVE_INFINITY;
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
