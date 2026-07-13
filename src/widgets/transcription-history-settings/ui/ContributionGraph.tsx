import { useTranslations } from "use-intl";
import { useLocaleStore } from "@/shared/i18n";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	buildHeatmap,
	type DayBucket,
	intensityLevel,
} from "../lib/word-stats";
import type { TranscriptionHistoryEntry } from "../model/history-store";

interface ContributionGraphProps {
	entries: TranscriptionHistoryEntry[];
}

// Teal ramp matching the calendar heatmap's legend (20/40/65/100% opacity) so
// both activity views read on one scale. Index 0 (empty) is supplied at render
// time from the surface so it sits a touch above the card.
const VARIANT_BG = [
	"bg-activity/20",
	"bg-activity/40",
	"bg-activity/65",
	"bg-activity",
];

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function formatMonth(date: Date, locale: string): string {
	return date.toLocaleDateString(locale, { month: "short" });
}

function formatCellDate(date: Date, locale: string): string {
	return date.toLocaleDateString(locale, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

interface Column {
	/** Seven cells, Sunday→Saturday; `null` pads the partial first/last week. */
	cells: (DayBucket | null)[];
	/**
	 * Stable React key: the `dayKey` of the column's first real day, which is
	 * unique per week across the rolling-year window. Survives reorders/filters
	 * where the positional index would not.
	 */
	key: string;
}

function keyedColumnCells(col: Column): {
	cell: DayBucket | null;
	key: string;
}[] {
	return col.cells.map((cell, dow) => ({
		cell,
		key: cell?.dayKey ?? `${col.key}-pad-${WEEKDAY_KEYS[dow]}`,
	}));
}

/** Group the rolling-year buckets into Sunday-started week columns. */
function toColumns(buckets: DayBucket[]): Column[] {
	const columns: Column[] = [];
	let cells: (DayBucket | null)[] = [];

	const firstDow = buckets[0]?.date.getDay() ?? 0;
	for (let i = 0; i < firstDow; i++) {
		cells.push(null);
	}

	const flush = () => {
		while (cells.length < 7) {
			cells.push(null);
		}
		const firstReal = cells.find((c): c is DayBucket => c !== null);
		const key = firstReal ? firstReal.dayKey : `pad-${columns.length}`;
		columns.push({ cells, key });
		cells = [];
	};

	for (const bucket of buckets) {
		cells.push(bucket);
		if (bucket.date.getDay() === 6) {
			flush();
		}
	}
	if (cells.length > 0) {
		flush();
	}
	return columns;
}

const columnsCache = new WeakMap<DayBucket[], Column[]>();

function cachedColumns(buckets: DayBucket[]): Column[] {
	const cached = columnsCache.get(buckets);
	if (cached) {
		return cached;
	}
	const columns = toColumns(buckets);
	columnsCache.set(buckets, columns);
	return columns;
}

/**
 * Short month name per week column: labeled wherever the month changes. The
 * leading (usually partial) month is labeled too, unless the next label lands
 * within two columns — a cramped double label reads worse than starting quiet.
 */
function monthLabels(columns: Column[], locale: string): string[] {
	let lastMonth = -1;
	const labels = columns.map((col) => {
		const firstReal = col.cells.find((c): c is DayBucket => c !== null);
		if (!firstReal) {
			return "";
		}
		const month = firstReal.date.getMonth();
		if (month === lastMonth) {
			return "";
		}
		lastMonth = month;
		return formatMonth(firstReal.date, locale);
	});
	const nextLabel = labels.findIndex((label, i) => i > 0 && label !== "");
	if (nextLabel !== -1 && nextLabel <= 2) {
		labels[0] = "";
	}
	return labels;
}

/**
 * A GitHub-style contribution heatmap of the last year of dictation activity —
 * the at-a-glance "are you keeping it up" view that pairs with the streak
 * banner. Read-only: date-range filtering lives in the interactive calendar
 * below it. The whole rolling year renders at once as ~53 fixed-pitch columns
 * of small rounded squares with month labels underneath — no paging, no
 * weekday gutter. Intensity is anchored to the busiest day of the year.
 */
export function ContributionGraph({ entries }: ContributionGraphProps) {
	const t = useTranslations("history");
	const locale = useLocaleStore((s) => s.locale);
	const emptyBg = surfaceBg(Math.min(useSurface() + 2, 8));

	const buckets = buildHeatmap(entries);
	const columns = cachedColumns(buckets);
	const labels = monthLabels(columns, locale);

	let max = 0;
	for (const bucket of buckets) {
		if (bucket.wordCount > max) {
			max = bucket.wordCount;
		}
	}

	const cellTitle = (cell: DayBucket): string => {
		const date = formatCellDate(cell.date, locale);
		if (cell.wordCount <= 0) {
			return date;
		}
		return `${date} · ${cell.wordCount.toLocaleString()} ${t("heatmapWords")}`;
	};

	return (
		// max-w-3xl caps the flexing cells at ~11px so the grid reads as a tight
		// GitHub-style mosaic on wide windows; the min-w + overflow wrapper lets a
		// narrow window scroll horizontally instead of crushing cells below
		// legibility.
		<div className="mx-auto w-full max-w-3xl overflow-x-auto">
			<div className="flex min-w-[560px] flex-col gap-1.5">
				<div className="flex gap-[3px]">
					{columns.map((col) => (
						<div
							className="flex min-w-0 flex-1 flex-col gap-[3px]"
							key={col.key}
						>
							{keyedColumnCells(col).map(({ cell, key }) => {
								if (cell === null) {
									return <div className="aspect-square w-full" key={key} />;
								}
								const level = intensityLevel(cell.wordCount, max);
								const bg = level === 0 ? emptyBg : VARIANT_BG[level - 1];
								return (
									<Tooltip content={cellTitle(cell)} key={cell.dayKey}>
										<div
											className={`aspect-square w-full rounded-[3px] ${bg}`}
										/>
									</Tooltip>
								);
							})}
						</div>
					))}
				</div>
				<div className="flex gap-[3px]">
					{columns.map((col, i) => (
						<div className="relative h-4 min-w-0 flex-1" key={`m-${col.key}`}>
							{labels[i] ? (
								<span className="absolute start-0 whitespace-nowrap text-foreground-muted text-xs-tight">
									{labels[i]}
								</span>
							) : null}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
