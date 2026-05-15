"use client";

import { useTranslations } from "next-intl";
import {
	buildHeatmap,
	type DayBucket,
	intensityLevel,
	type TranscriptionHistoryEntry,
} from "@/entities/transcription-history";
import { Tooltip } from "@/shared/ui/tooltip";

interface ActivityHeatmapProps {
	entries: TranscriptionHistoryEntry[];
}

const INTENSITY_CLASSES: Record<0 | 1 | 2 | 3 | 4, string> = {
	0: "bg-surface-elevated",
	1: "bg-teal/20",
	2: "bg-teal/40",
	3: "bg-teal/65",
	4: "bg-teal",
};

const MONTH_LABELS = [
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
];

/**
 * Chunks the 365 day buckets into week columns aligned to Sunday. The first
 * column may be partial (current day-of-week padding) — we render an empty
 * placeholder cell for missing weekdays so columns stay vertically aligned.
 */
function toWeekColumns(buckets: DayBucket[]): (DayBucket | null)[][] {
	const columns: (DayBucket | null)[][] = [];
	let current: (DayBucket | null)[] = [];
	const firstWeekday = buckets[0]?.date.getDay() ?? 0;
	for (let i = 0; i < firstWeekday; i++) {
		current.push(null);
	}
	for (const bucket of buckets) {
		current.push(bucket);
		if (current.length === 7) {
			columns.push(current);
			current = [];
		}
	}
	if (current.length > 0) {
		while (current.length < 7) {
			current.push(null);
		}
		columns.push(current);
	}
	return columns;
}

function formatBucketLabel(bucket: DayBucket, label: string): string {
	const date = bucket.date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
	return `${date} · ${bucket.wordCount.toLocaleString()} ${label}`;
}

export function ActivityHeatmap({ entries }: ActivityHeatmapProps) {
	const t = useTranslations("history");
	const buckets = buildHeatmap(entries);
	const max = buckets.reduce((acc, b) => Math.max(acc, b.wordCount), 0);
	const columns = toWeekColumns(buckets);
	const wordsLabel = t("heatmapWords");

	return (
		<div className="overflow-x-auto">
			<div className="flex min-w-fit flex-col gap-1">
				<div className="flex gap-[3px] pl-[26px] text-foreground-muted text-xs-tight">
					{columns.map((col, idx) => {
						const firstDay = col.find((c): c is DayBucket => c !== null);
						if (!firstDay) {
							return <div className="w-[11px]" key={`m-${idx}`} />;
						}
						const isFirstWeekOfMonth = firstDay.date.getDate() <= 7 && (idx === 0 || idx % 4 === 0);
						return (
							<div className="w-[11px] text-center" key={firstDay.dayKey}>
								{isFirstWeekOfMonth ? MONTH_LABELS[firstDay.date.getMonth()] : ""}
							</div>
						);
					})}
				</div>
				<div className="flex gap-[3px]">
					<div className="flex flex-col gap-[3px] pr-1 text-foreground-muted text-xs-tight">
						<div className="h-[11px]" />
						<div className="h-[11px] leading-[11px]">Mon</div>
						<div className="h-[11px]" />
						<div className="h-[11px] leading-[11px]">Wed</div>
						<div className="h-[11px]" />
						<div className="h-[11px] leading-[11px]">Fri</div>
						<div className="h-[11px]" />
					</div>
					{columns.map((col, colIdx) => (
						<div className="flex flex-col gap-[3px]" key={`col-${colIdx}`}>
							{col.map((bucket, rowIdx) => {
								if (!bucket) {
									return <div className="h-[11px] w-[11px]" key={`empty-${colIdx}-${rowIdx}`} />;
								}
								const level = intensityLevel(bucket.wordCount, max);
								return (
									<Tooltip content={formatBucketLabel(bucket, wordsLabel)} key={bucket.dayKey}>
										<div
											aria-label={formatBucketLabel(bucket, wordsLabel)}
											className={`h-[11px] w-[11px] rounded-[2px] ${INTENSITY_CLASSES[level]}`}
											role="img"
										/>
									</Tooltip>
								);
							})}
						</div>
					))}
				</div>
				<div className="flex items-center justify-end gap-1.5 pt-1 text-foreground-muted text-xs-tight">
					<span>{t("heatmapLess")}</span>
					{([0, 1, 2, 3, 4] as const).map((level) => (
						<div
							className={`h-[11px] w-[11px] rounded-[2px] ${INTENSITY_CLASSES[level]}`}
							key={level}
						/>
					))}
					<span>{t("heatmapMore")}</span>
				</div>
			</div>
		</div>
	);
}
