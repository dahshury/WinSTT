import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import type {
	ModelSpec,
	ModelSpecFact,
	ModelSpecFeature,
	ModelSpecStat,
} from "./types";

/** Small uppercase section label. */
function Eyebrow({ children }: { children: string }) {
	return (
		<p className="mb-1.5 font-semibold text-[10px] text-foreground-dim uppercase leading-none tracking-[0.08em]">
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

function SpecHeader({ spec }: { spec: ModelSpec }) {
	const { makerLogoSrc, makerIcon, makerLabel, name, variant, priceTier } =
		spec;
	return (
		<div className="flex items-start gap-3 px-4 pt-4 pb-3">
			<span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground/[0.05] ring-1 ring-inset ring-divider">
				{makerLogoSrc ? (
					<img
						alt=""
						className="size-6 object-contain"
						height={24}
						loading="eager"
						src={makerLogoSrc}
						width={24}
					/>
				) : makerIcon ? (
					<HugeiconsIcon
						className="size-5 text-foreground-muted"
						icon={makerIcon}
					/>
				) : null}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
					<span className="truncate text-[11px] text-foreground-muted leading-tight">
						{makerLabel}
					</span>
				) : null}
			</div>
		</div>
	);
}

function FeatureChips({ features }: { features: ModelSpecFeature[] }) {
	return (
		<div>
			<Eyebrow>Features</Eyebrow>
			<div className="flex flex-wrap gap-1.5">
				{features.map((f) => (
					<span
						className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-foreground/[0.04] px-1.5 py-1 font-medium text-[10.5px] text-foreground-muted leading-none"
						key={f.key}
						title={f.description ?? f.label}
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3 shrink-0"
							icon={f.icon}
						/>
						{f.label}
					</span>
				))}
			</div>
		</div>
	);
}

function FactCell({ fact }: { fact: ModelSpecFact }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="font-semibold text-[9.5px] text-foreground-dim uppercase leading-none tracking-[0.06em]">
				{fact.label}
			</span>
			<span className="flex min-w-0 items-center gap-1 truncate text-[11.5px] text-foreground-secondary leading-tight">
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
						className="size-3.5 shrink-0 text-foreground-dim"
						icon={fact.icon}
					/>
				) : null}
				<span className="min-w-0 truncate">{fact.value}</span>
			</span>
		</div>
	);
}

function FactGrid({ facts }: { facts: ModelSpecFact[] }) {
	return (
		<div>
			<Eyebrow>Details</Eyebrow>
			<div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
				{facts.map((fact) => (
					<FactCell fact={fact} key={fact.key} />
				))}
			</div>
		</div>
	);
}

function StatBar({ stat }: { stat: ModelSpecStat }) {
	const pct = Math.round(Math.min(1, Math.max(0, stat.score)) * 100);
	return (
		<div className="flex items-center gap-2">
			<span className="w-16 shrink-0 truncate text-[10.5px] text-foreground-muted leading-none">
				{stat.label}
			</span>
			<span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
				<span
					className="block h-full rounded-full bg-foreground-muted"
					style={{ width: `${pct}%` }}
				/>
			</span>
			<span className="w-8 shrink-0 text-right font-medium text-[10px] text-foreground-secondary tabular-nums leading-none">
				{pct}%
			</span>
		</div>
	);
}

function StatBars({ stats }: { stats: ModelSpecStat[] }) {
	return (
		<div>
			<Eyebrow>Performance</Eyebrow>
			<div className="flex flex-col gap-1.5">
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
	const hasDescription = Boolean(spec.description);
	const hasFeatures = spec.features.length > 0;
	const hasFacts = spec.facts.length > 0;
	const hasStats = (spec.stats?.length ?? 0) > 0;
	const hasBody = hasDescription || hasFeatures || hasFacts || hasStats;
	return (
		<div className={cn("flex flex-col text-foreground", className)}>
			<SpecHeader spec={spec} />
			{hasBody ? (
				<div className="flex flex-col gap-3 border-divider border-t px-4 py-3">
					{hasDescription ? (
						<div>
							<Eyebrow>Description</Eyebrow>
							<p className="line-clamp-5 text-[11.5px] text-foreground-muted leading-[16px]">
								{spec.description}
							</p>
						</div>
					) : null}
					{hasFeatures ? <FeatureChips features={spec.features} /> : null}
					{hasFacts ? <FactGrid facts={spec.facts} /> : null}
					{hasStats && spec.stats ? <StatBars stats={spec.stats} /> : null}
				</div>
			) : null}
			{spec.sourceLabel || spec.loading ? (
				<div className="flex items-center gap-1.5 border-divider border-t px-4 py-2">
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
