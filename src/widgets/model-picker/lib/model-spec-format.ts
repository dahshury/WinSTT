import type {
	ModelSpecPriceTier,
	ModelSpecStat,
} from "@/shared/ui/model-spec-card";

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/**
 * Render a models.dev date token ("2025-09" or "2025-09-09") as a compact,
 * locale-neutral "Sep 2025". Returns the raw token unchanged when it isn't the
 * expected shape, and `null` for empty input.
 */
export function formatSpecDate(
	value: string | null | undefined,
): string | null {
	if (!value) {
		return null;
	}
	const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value.trim());
	if (!match) {
		return value.trim();
	}
	const year = match[1];
	const monthIndex = Number(match[2]) - 1;
	const month = MONTHS[monthIndex];
	return month ? `${month} ${year}` : (year ?? value);
}

/** Compact token count: 256000 → "256K", 1048576 → "1M". */
export function formatContextTokens(
	tokens: number | null | undefined,
): string | null {
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
		return null;
	}
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		return `${m.toFixed(m >= 10 ? 0 : 1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1000) {
		return `${Math.round(tokens / 1000)}K`;
	}
	return String(tokens);
}

/** Human list of the first `max` languages, with an "+N more" tail. */
export function formatLanguageSummary(
	languages: readonly string[],
	max = 2,
): string | null {
	if (languages.length === 0) {
		return null;
	}
	if (languages.length === 1) {
		return languages[0] ?? null;
	}
	if (languages.length <= max) {
		return languages.join(", ");
	}
	return `${languages.length} languages`;
}

/** Drop the catalog "unknown" sentinel (0.5) so only real perf scores render. */
export function specStat(
	key: string,
	label: string,
	score: number,
): ModelSpecStat | null {
	if (!Number.isFinite(score) || score === 0.5 || score <= 0) {
		return null;
	}
	return { key, label, score };
}

/** Per-million-token USD figure parsed from an OpenRouter price string. */
function perMillion(price: string | null | undefined): number | null {
	if (!price) {
		return null;
	}
	const perToken = Number(price);
	if (!Number.isFinite(perToken) || perToken < 0) {
		return null;
	}
	return perToken * 1_000_000;
}

export interface PriceTierInfo {
	tier: ModelSpecPriceTier;
	label: string;
}

/**
 * Map OpenRouter per-token pricing to a `$` / `$$` / `$$$` tier plus a hover
 * label. Tiers are keyed off the higher of the input/output per-million cost:
 * ≤ $1/M → `$`, ≤ $10/M → `$$`, otherwise `$$$`. Returns `null` for free models
 * (no chip).
 */
export function priceTierFromPricing(pricing: {
	prompt?: string | undefined;
	completion?: string | undefined;
}): PriceTierInfo | null {
	const input = perMillion(pricing.prompt);
	const output = perMillion(pricing.completion);
	const worst = Math.max(input ?? 0, output ?? 0);
	if (worst <= 0) {
		return null;
	}
	const fmt = (v: number | null): string =>
		v === null ? "?" : `$${v < 1 ? v.toFixed(2) : v.toFixed(2)}`;
	const label = `${fmt(input)} in · ${fmt(output)} out / M tokens`;
	const tier: ModelSpecPriceTier = worst <= 1 ? 1 : worst <= 10 ? 2 : 3;
	return { tier, label };
}
