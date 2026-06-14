import type { ModelInfo } from "@/entities/model-catalog";
import { parseParameterSize } from "./family-grouping";

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
const ARCH_BUNDLE_PREFIXES: readonly string[] = [
	"nemo-canary",
	"moonshine-tiny",
	"moonshine-base",
];

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
		base = base
			.slice("lite-whisper-".length)
			.replace(LITE_WHISPER_FLAVOR_SUFFIX_RE, "");
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
			(a, b) => variantSortKey(a, baseId) - variantSortKey(b, baseId),
		);
		bundles.push({ baseId, variants: sorted });
	}
	return bundles;
}
