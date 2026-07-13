import {
	AiMicIcon,
	AiVoiceIcon,
	ChartLineData01Icon,
	CpuIcon,
	DollarCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import type { AuthorSlice } from "../lib/author-usage";
import type { CostAnalytics } from "../lib/cost-analytics";
import { formatUsd } from "../lib/word-stats";
import { CostBars } from "./CostBars";
import { CostPie } from "./CostPie";
import { ModelAuthorRadar } from "./ModelAuthorRadar";
import { Sparkline } from "./Sparkline";

interface SpendingSectionProps {
	analytics: CostAnalytics;
}

/** `~$x` when the figure includes an estimate, else `$x`. */
function costText(cost: number, estimate: boolean): string {
	return `${estimate ? "~" : ""}${formatUsd(cost) ?? "$0.00"}`;
}

/** Cost-weighted maker radar spoke title: `label · $cost (pct%)`. */
function makerTitle(slice: AuthorSlice): string {
	return `${slice.label} · ${formatUsd(slice.count) ?? "$0.00"} (${slice.pct}%)`;
}

function Card({
	icon,
	label,
	children,
	index,
}: {
	icon: IconSvgElement;
	label: string;
	children: ReactNode;
	index: number;
}) {
	const substrate = useSurface();
	const cardBg = surfaceBg(Math.min(substrate + 1, 8));
	const chipBg = surfaceBg(Math.min(substrate + 2, 8));
	return (
		<div
			className={`flex flex-col gap-2.5 overflow-hidden rounded-lg border border-divider ${cardBg} p-3 opacity-0 shadow-surface-2`}
			style={{ animation: `fade-in 240ms ease-out ${index * 40}ms forwards` }}
		>
			<div className="flex items-center gap-2">
				<div
					className={`flex size-[22px] shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-divider ${chipBg}`}
				>
					<HugeiconsIcon
						aria-hidden
						className="text-foreground-muted"
						icon={icon}
						size={12}
						strokeWidth={1.75}
					/>
				</div>
				<div className="line-clamp-1 min-w-0 font-mono text-[9.5px] text-foreground-muted uppercase leading-[1.25] tracking-[0.08em]">
					{label}
				</div>
			</div>
			{children}
		</div>
	);
}

function SubtotalRow({
	icon,
	label,
	value,
	tint,
}: {
	icon: IconSvgElement;
	label: string;
	value: string;
	tint: string;
}) {
	return (
		<div className="flex items-center gap-2 text-xs-tight">
			<HugeiconsIcon
				aria-hidden
				className={`shrink-0 ${tint}`}
				icon={icon}
				size={13}
				strokeWidth={1.75}
			/>
			<span className="min-w-0 flex-1 truncate text-foreground-muted">
				{label}
			</span>
			<span className="shrink-0 font-mono text-foreground-secondary tabular-nums">
				{value}
			</span>
		</div>
	);
}

const BIG_VALUE =
	"font-mono font-semibold text-[26px] text-foreground tabular-nums leading-none tracking-tight";

/**
 * The History dashboard's spending analytics — how cloud cost splits across
 * modalities (a donut tied to the STT/TTS row-kind colors), providers (a second
 * donut), and individual models (bars beside a cost-weighted maker radar),
 * plus a daily-spend trend. Everything reads the SAME date-filtered entries as
 * the rest of the dashboard, so the calendar picker at the top scopes it too.
 * The panel only mounts this when there IS cloud spend in the window.
 */
export function SpendingSection({ analytics }: SpendingSectionProps) {
	const t = useTranslations("history");

	// A breakdown with a single slice is just the total wearing a different hat —
	// showing it would echo the same figure beside itself. So each donut/bar chart
	// only renders once it actually splits the total (≥2 slices); a single-source
	// window (one modality, one provider, one model) collapses to the Total card.
	const showModality = analytics.byModality.length > 1;
	const showProvider = analytics.byProvider.length > 1;
	const showModels = analytics.byModel.length > 1;
	const showSubtotals = analytics.byModality.length > 1;
	const cardCount = 1 + (showModality ? 1 : 0) + (showProvider ? 1 : 0);
	const gridCols =
		cardCount >= 3
			? "sm:grid-cols-3"
			: cardCount === 2
				? "sm:grid-cols-2"
				: "sm:grid-cols-1";

	return (
		<div className="flex flex-col gap-4 py-2">
			<div className={`grid grid-cols-1 gap-2 ${gridCols}`}>
				<Card
					icon={ChartLineData01Icon}
					index={0}
					label={t("spendingTotalLabel")}
				>
					<div className={BIG_VALUE}>
						{costText(analytics.total, analytics.estimated)}
					</div>
					<Sparkline className="mt-1 h-7 w-full" values={analytics.daily} />
					{showSubtotals ? (
						<div className="mt-auto flex flex-col gap-1.5 border-divider border-t pt-2.5">
							{analytics.stt > 0 ? (
								<SubtotalRow
									icon={AiMicIcon}
									label={t("costSpeechToText")}
									tint="text-history-stt"
									value={costText(
										analytics.stt,
										analytics.byModality.find((s) => s.key === "stt")
											?.estimate ?? false,
									)}
								/>
							) : null}
							{analytics.llm > 0 ? (
								<SubtotalRow
									icon={CpuIcon}
									label={t("costLanguageModel")}
									tint="text-activity"
									value={costText(analytics.llm, false)}
								/>
							) : null}
							{analytics.tts > 0 ? (
								<SubtotalRow
									icon={AiVoiceIcon}
									label={t("costTextToSpeech")}
									tint="text-history-tts"
									value={costText(
										analytics.tts,
										analytics.byModality.find((s) => s.key === "tts")
											?.estimate ?? false,
									)}
								/>
							) : null}
						</div>
					) : null}
				</Card>

				{showModality ? (
					<Card
						icon={DollarCircleIcon}
						index={1}
						label={t("spendingByModalityTitle")}
					>
						<div className="flex flex-1 items-center justify-center">
							<CostPie
								ariaLabel={t("spendingByModalityTitle")}
								centerLabel={t("spendingTotalLabel")}
								centerValue={costText(analytics.total, analytics.estimated)}
								slices={analytics.byModality}
							/>
						</div>
					</Card>
				) : null}

				{showProvider ? (
					<Card
						icon={DollarCircleIcon}
						index={showModality ? 2 : 1}
						label={t("spendingByProviderTitle")}
					>
						<div className="flex flex-1 items-center justify-center">
							<CostPie
								ariaLabel={t("spendingByProviderTitle")}
								centerLabel={t("spendingTotalLabel")}
								centerValue={costText(analytics.total, analytics.estimated)}
								slices={analytics.byProvider}
							/>
						</div>
					</Card>
				) : null}
			</div>

			{showModels ? (
				<div className="flex flex-col gap-4 border-divider border-t pt-4 sm:flex-row sm:items-center sm:gap-6">
					<div className="min-w-0 flex-1">
						<div className="mb-2.5 font-mono text-[9.5px] text-foreground-muted uppercase tracking-[0.08em]">
							{t("spendingByModelTitle")}
						</div>
						<CostBars bars={analytics.byModel} otherLabel={t("usageOther")} />
					</div>
					<ModelAuthorRadar
						ariaLabel={t("spendingByMakerTitle")}
						formatTitle={makerTitle}
						slices={analytics.byMaker}
					/>
				</div>
			) : null}

			{analytics.estimated ? (
				<p className="text-2xs text-foreground-muted">
					{t("spendingEstimatedHint")}
				</p>
			) : null}
		</div>
	);
}
