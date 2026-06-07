/**
 * Canonical byte-size formatter shared across slices.
 *
 * Renders a byte count as a human-readable size string ("423 MB", "2.1 GB",
 * "12.0 KB", "512 B"). Behaviour is tuned per call site via {@link FormatBytesOptions}
 * so every existing consumer keeps byte-identical output.
 *
 * The tier ladder is data-driven (a static table + `Array.find`) so the public
 * function stays at McCabe complexity ≤ 3 — no `if/else-if` tower.
 */

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Smallest unit the formatter is allowed to step down to. */
type ByteUnit = "B" | "KB" | "MB" | "GB";

export interface FormatBytesOptions {
	/** Decimal places for the GB tier. Default `1`. */
	gbDecimals?: number;
	/** Decimal places for the KB tier (only used when `minUnit` allows KB). Default `1`. */
	kbDecimals?: number;
	/** Decimal places for the MB tier. Default `0`. */
	mbDecimals?: number;
	/**
	 * Smallest unit to use. With `"MB"` (default) any value below 1 GB is shown
	 * in MB (no KB/B), matching the model-size formatters. `"B"` enables the full
	 * B → KB → MB → GB ladder for the download overlay.
	 */
	minUnit?: ByteUnit;
}

interface Tier {
	/** `toFixed` precision; `null` renders the raw value (the "B" tier). */
	decimals: number | null;
	/** Divisor applied before rounding. `1` keeps raw bytes (the "B" tier). */
	divisor: number;
	/** Inclusive lower bound (bytes) at which this tier is normally selected. */
	floor: number;
	rank: number;
	suffix: ByteUnit;
}

const DEFAULTS = {
	minUnit: "MB",
	mbDecimals: 0,
	gbDecimals: 1,
	kbDecimals: 1,
} as const;
const UNIT_RANK: Record<ByteUnit, number> = { B: 0, KB: 1, MB: 2, GB: 3 };

/** Largest → smallest. `floor` is collapsed to 0 for the chosen `minUnit`. */
function buildTiers(o: Required<FormatBytesOptions>): Tier[] {
	const minRank = UNIT_RANK[o.minUnit];
	const raw: Tier[] = [
		{ suffix: "GB", rank: 3, divisor: GIB, decimals: o.gbDecimals, floor: GIB },
		{ suffix: "MB", rank: 2, divisor: MIB, decimals: o.mbDecimals, floor: MIB },
		{ suffix: "KB", rank: 1, divisor: KIB, decimals: o.kbDecimals, floor: KIB },
		{ suffix: "B", rank: 0, divisor: 1, decimals: null, floor: 0 },
	];
	return raw
		.filter((t) => t.rank >= minRank)
		.map((t) => ({ ...t, floor: t.rank === minRank ? 0 : t.floor }));
}

function isValidByteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The lowest kept tier always has `floor: 0` (collapsed by {@link buildTiers}),
 * so a tier always matches for a positive byte count. The trailing fallback
 * exists only to keep the return type non-nullable.
 */
function pickTier(bytes: number, tiers: Tier[]): Tier {
	const match = tiers.find((t) => bytes >= t.floor);
	return match ?? tiers.at(-1) ?? FALLBACK_TIER;
}

const FALLBACK_TIER: Tier = {
	suffix: "B",
	rank: 0,
	divisor: 1,
	decimals: null,
	floor: 0,
};

function renderTier(bytes: number, tier: Tier): string {
	const scaled = bytes / tier.divisor;
	const text =
		tier.decimals === null ? `${scaled}` : scaled.toFixed(tier.decimals);
	return `${text} ${tier.suffix}`;
}

/**
 * Format a byte count. Non-positive / non-finite / nullish input returns `null`;
 * call sites that need a different sentinel (e.g. `"unknown"`, `"0 B"`) coalesce
 * on the result.
 */
export function formatBytes(
	bytes: number | null | undefined,
	options: FormatBytesOptions = {},
): string | null {
	if (!isValidByteCount(bytes)) {
		return null;
	}
	const tiers = buildTiers({ ...DEFAULTS, ...options });
	return renderTier(bytes, pickTier(bytes, tiers));
}
