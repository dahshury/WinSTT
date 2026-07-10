import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";

/**
 * A single capability chip (e.g. Reasoning, Tool Calling, Multilingual). Reads
 * from its glyph shape + label; kept neutral/grayscale per the design system —
 * color is reserved for selection, not capability.
 */
export interface ModelSpecFeature {
	/** Stable key for the chip. */
	key: string;
	/** Capability glyph. */
	icon: IconSvgElement;
	/** Short chip label, e.g. "Reasoning". */
	label: string;
	/** Optional longer explanation (rendered as the chip's title/tooltip). */
	description?: string | undefined;
}

/**
 * One label/value row in the two-column spec grid — Provider, Developer,
 * Knowledge cutoff, Added on, Context, Languages, Parameters, Voices, …
 */
export interface ModelSpecFact {
	key: string;
	/** Left-column label, e.g. "Provider". */
	label: string;
	/** Right-column value, e.g. "OpenRouter". */
	value: ReactNode;
	/** Optional glyph before the value (e.g. a maker logo path is preferred). */
	icon?: IconSvgElement | undefined;
	/** Optional resolved logo URL shown before the value (run local asset paths
	 *  through `publicAsset`). Takes precedence over `icon`. */
	logoSrc?: string | null | undefined;
}

/**
 * A normalized 0..1 quality/speed/accuracy bar. The local ONNX models have no
 * external benchmark source, so these author-published perf scores stand in for
 * the cloud card's benchmark donuts. `0.5` (the catalog "unknown" sentinel) is
 * filtered out by the adapter before it reaches the card.
 */
export interface ModelSpecStat {
	key: string;
	/** Bar label, e.g. "Accuracy", "Speed", "Quality". */
	label: string;
	/** Normalized 0..1 score. */
	score: number;
}

/** A price tier derived from cloud pricing — rendered as `$` / `$$` / `$$$`. */
export type ModelSpecPriceTier = 1 | 2 | 3;

/**
 * The single normalized view-model every model-selector hover card renders
 * through. Each surface (STT, TTS, Ollama, OpenRouter) supplies a `build*Spec`
 * adapter that maps its catalog row → this shape, so all four hover cards read
 * identically. Every section renders conditionally: a local STT model simply
 * won't carry `facts` like "Knowledge cutoff" or a `priceTier`.
 */
export interface ModelSpec {
	/** Model display name (top line). */
	name: string;
	/** Optional trailing variant token shown muted after the name (e.g. "Turbo"). */
	variant?: string | null | undefined;
	/** Maker/author label, e.g. "OpenAI", "Moonshot". */
	makerLabel?: string | undefined;
	/** Resolved maker logo URL (run local asset paths through `publicAsset`). */
	makerLogoSrc?: string | null | undefined;
	/** Fallback maker glyph when no logo is available. */
	makerIcon?: IconSvgElement | undefined;
	/** Main description paragraph. */
	description?: string | undefined;
	/** Price tier from cloud pricing — omitted for local (free) models. */
	priceTier?: ModelSpecPriceTier | undefined;
	/** Hover explanation for the price chip (e.g. "$3.00 in · $15.00 out / M tokens"). */
	priceLabel?: string | undefined;
	/** Capability chips (Reasoning, Tool Calling, Multilingual, Voice cloning, …). */
	features: ModelSpecFeature[];
	/** Two-column label/value spec rows. */
	facts: ModelSpecFact[];
	/** Perf bars (accuracy/speed/quality) — the local-model stand-in for benchmarks. */
	stats?: ModelSpecStat[] | undefined;
	/** Attribution line, e.g. "via models.dev", shown in the footer when the card
	 *  was enriched from an online source. */
	sourceLabel?: string | undefined;
	/** True while online enrichment is still in flight — shows a subtle shimmer on
	 *  the enrichable rows without blocking the catalog data already shown. */
	loading?: boolean | undefined;
}
