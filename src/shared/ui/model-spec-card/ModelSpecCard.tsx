import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { performanceScoreColor } from "@/shared/lib/performance-color";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import type {
	ModelSpec,
	ModelSpecFact,
	ModelSpecFeature,
	ModelSpecStat,
} from "./types";

/** Small uppercase section label. */
function Eyebrow({ children }: { children: string }) {
	return (
		<p className="mb-2 font-semibold text-[10px] text-foreground-muted uppercase leading-none tracking-[0.09em]">
			{children}
		</p>
	);
}

/** `$` / `$$` / `$$$` price chip — cloud models only. Grayscale (color is
 *  reserved for selection), legibility from the glyph count + tooltip. */
function PriceChip({
	tier,
	label,
}: {
	tier: 1 | 2 | 3;
	label?: string | undefined;
}) {
	return (
		<span
			className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-semibold text-[11px] text-foreground-secondary leading-none ring-1 ring-inset ring-divider-strong"
			title={label ?? `Pricing tier ${tier} of 3`}
		>
			{"$".repeat(tier)}
		</span>
	);
}

function SpecHeader({ spec, raisedBg }: { spec: ModelSpec; raisedBg: string }) {
	const { makerLogoSrc, makerIcon, makerLabel, name, variant, priceTier } =
		spec;
	return (
		<div className="flex items-center gap-3 px-4 pt-4 pb-3.5">
			<span
				className={cn(
					"flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1 ring-inset ring-divider-strong",
					raisedBg,
				)}
			>
				{makerLogoSrc ? (
					<img
						alt=""
						className="size-7 object-contain"
						height={28}
						loading="eager"
						src={makerLogoSrc}
						width={28}
					/>
				) : makerIcon ? (
					<HugeiconsIcon
						className="size-5 text-foreground-muted"
						icon={makerIcon}
					/>
				) : null}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 truncate font-semibold text-body text-foreground tracking-tight">
						{name}
					</span>
					{variant ? (
						<span className="shrink-0 truncate font-medium text-body-sm text-foreground-muted tracking-tight">
							{variant}
						</span>
					) : null}
					{priceTier ? (
						<span className="ms-auto">
							<PriceChip label={spec.priceLabel} tier={priceTier} />
						</span>
					) : null}
				</div>
				{makerLabel ? (
					<span className="truncate text-[11.5px] text-foreground-muted leading-none">
						{makerLabel}
					</span>
				) : null}
			</div>
		</div>
	);
}

function FeatureChips({
	features,
	raisedBg,
}: {
	features: ModelSpecFeature[];
	raisedBg: string;
}) {
	const t = useTranslations("modelPicker");
	return (
		<div>
			<Eyebrow>{t("specFeatures")}</Eyebrow>
			<div className="flex flex-wrap gap-1.5">
				{features.map((f) => (
					<span
						className={cn(
							"inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium text-[11.5px] text-foreground-secondary leading-none ring-1 ring-inset ring-divider-strong",
							raisedBg,
						)}
						key={f.key}
						title={f.description ?? f.label}
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5 shrink-0 text-foreground-muted"
							icon={f.icon}
						/>
						{f.label}
					</span>
				))}
			</div>
		</div>
	);
}

/** One `label ————— value` row in the spec sheet. Labels left-align, values
 *  right-align, and a hairline divides each row — an evenly-spaced definition
 *  list where every value's leading icon and text sit on the same right edge. */
function FactRow({ fact }: { fact: ModelSpecFact }) {
	return (
		<div className="flex items-center justify-between gap-3 border-divider border-t py-2 first:border-t-0 first:pt-0">
			<span className="shrink-0 font-medium text-[11.5px] text-foreground-muted leading-none">
				{fact.label}
			</span>
			<span className="inline-flex min-w-0 items-center gap-1.5 truncate text-[12px] text-foreground-secondary leading-none">
				{fact.logoSrc ? (
					<img
						alt=""
						className="size-3.5 shrink-0 rounded-[3px] object-contain"
						height={14}
						src={fact.logoSrc}
						width={14}
					/>
				) : fact.icon ? (
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-foreground-muted"
						icon={fact.icon}
					/>
				) : null}
				<span className="min-w-0 truncate">{fact.value}</span>
			</span>
		</div>
	);
}

function FactList({ facts }: { facts: ModelSpecFact[] }) {
	const t = useTranslations("modelPicker");
	return (
		<div>
			<Eyebrow>{t("specDetails")}</Eyebrow>
			<div className="flex flex-col">
				{facts.map((fact) => (
					<FactRow fact={fact} key={fact.key} />
				))}
			</div>
		</div>
	);
}

// Mirrors the model-picker card's `CardPerf` bar: a dim metaphor glyph, a fill
// tinted on the shared red→amber→green performance scale, and the percentage
// echoed in that same colour — so accuracy/speed read identically wherever they
// appear.
function StatBar({ stat }: { stat: ModelSpecStat }) {
	const pct = Math.round(Math.min(1, Math.max(0, stat.score)) * 100);
	const color = performanceScoreColor(stat.score);
	return (
		<div className="flex items-center gap-2">
			{stat.icon ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3.5 shrink-0 text-foreground-muted"
					icon={stat.icon}
				/>
			) : null}
			<span className="w-16 shrink-0 truncate text-[11px] text-foreground-secondary leading-none">
				{stat.label}
			</span>
			<span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
				<span
					aria-hidden="true"
					className="absolute inset-y-0 left-0 rounded-full"
					style={{ width: `${pct}%`, backgroundColor: color }}
				/>
			</span>
			<span
				className="w-8 shrink-0 text-right font-semibold text-[10.5px] tabular-nums leading-none"
				style={{ color }}
			>
				{pct}%
			</span>
		</div>
	);
}

function StatBars({ stats }: { stats: ModelSpecStat[] }) {
	const t = useTranslations("modelPicker");
	return (
		<div>
			<Eyebrow>{t("specPerformance")}</Eyebrow>
			<div className="flex flex-col gap-2">
				{stats.map((stat) => (
					<StatBar key={stat.key} stat={stat} />
				))}
			</div>
		</div>
	);
}

export interface ModelSpecCardProps {
	spec: ModelSpec;
	className?: string | undefined;
}

/**
 * The presentational model spec card shown on hover over a model-selector's
 * currently-selected chip. Pure layout — it takes a normalized {@link ModelSpec}
 * (built by each surface's `build*Spec` adapter) and renders whatever sections
 * that model actually carries. Kept in `shared/ui` so all four selectors (STT,
 * TTS, Ollama, OpenRouter) render through the exact same card.
 */
export function ModelSpecCard({ spec, className }: ModelSpecCardProps) {
	const t = useTranslations("modelPicker");
	// Chips/logo sit one elevation above the card so they read as raised objects
	// on it rather than dissolving into the background (per the surface
	// convention — the card is rendered inside a level-7 popup).
	const raisedBg = surfaceBg(useSurface() + 1);
	const hasDescription = Boolean(spec.description);
	const hasFeatures = spec.features.length > 0;
	const hasFacts = spec.facts.length > 0;
	const hasStats = (spec.stats?.length ?? 0) > 0;
	const hasBody = hasDescription || hasFeatures || hasFacts || hasStats;
	return (
		<div className={cn("flex flex-col text-foreground", className)}>
			<SpecHeader raisedBg={raisedBg} spec={spec} />
			{hasBody ? (
				<div className="flex flex-col gap-4 border-divider border-t px-4 py-4">
					{hasDescription ? (
						<div>
							<Eyebrow>{t("specDescription")}</Eyebrow>
							<p className="line-clamp-5 text-[12px] text-foreground-secondary leading-[17px]">
								{spec.description}
							</p>
						</div>
					) : null}
					{hasFeatures ? (
						<FeatureChips features={spec.features} raisedBg={raisedBg} />
					) : null}
					{hasFacts ? <FactList facts={spec.facts} /> : null}
					{hasStats && spec.stats ? <StatBars stats={spec.stats} /> : null}
				</div>
			) : null}
			{spec.sourceLabel || spec.loading ? (
				<div className="flex items-center gap-1.5 border-divider border-t px-4 py-2.5">
					{spec.loading ? (
						<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground-dim" />
					) : null}
					<span className="text-[10px] text-foreground-dim leading-none">
						{spec.loading ? "Loading details…" : spec.sourceLabel}
					</span>
				</div>
			) : null}
		</div>
	);
}
