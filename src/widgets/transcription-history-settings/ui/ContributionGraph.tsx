import { useTranslations } from "use-intl";
import { useLocaleStore } from "@/shared/i18n";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
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

// Mon / Wed / Fri rows get a label, like a GitHub contribution graph — labeling
// all seven crowds the 9px cells.
const WEEKDAY_LABEL_ROWS = new Set([1, 3, 5]);
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function formatMonth(date: Date, locale: string): string {
	return date.toLocaleDateString(locale, { month: "short" });
}

function formatWeekday(date: Date, locale: string): string {
	return date.toLocaleDateString(locale, { weekday: "short" });
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
	/** Short month name shown above the column when the month changes here. */
	monthLabel: string;
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
function toColumns(buckets: DayBucket[], locale: string): Column[] {
	const columns: Column[] = [];
	let cells: (DayBucket | null)[] = [];
	let lastMonth = -1;

	const firstDow = buckets[0]?.date.getDay() ?? 0;
	for (let i = 0; i < firstDow; i++) {
		cells.push(null);
	}

	const flush = () => {
		while (cells.length < 7) {
			cells.push(null);
		}
		const firstReal = cells.find((c): c is DayBucket => c !== null);
		let monthLabel = "";
		if (firstReal) {
			const month = firstReal.date.getMonth();
			if (month !== lastMonth) {
				monthLabel = formatMonth(firstReal.date, locale);
				lastMonth = month;
			}
		}
		const key = firstReal ? firstReal.dayKey : `pad-${columns.length}`;
		columns.push({ cells, key, monthLabel });
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

const columnsCache = new WeakMap<DayBucket[], Map<string, Column[]>>();

function cachedColumns(buckets: DayBucket[], locale: string): Column[] {
	let byLocale = columnsCache.get(buckets);
	if (!byLocale) {
		byLocale = new Map();
		columnsCache.set(buckets, byLocale);
	}
	const cached = byLocale.get(locale);
	if (cached) {
		return cached;
	}
	const columns = toColumns(buckets, locale);
	byLocale.set(locale, columns);
	return columns;
}

/** Localized short weekday names indexed by day-of-week (0 = Sunday). */
function weekdayNames(locale: string): string[] {
	// 2024-01-07 is a Sunday; +dow lands on each weekday.
	return Array.from({ length: 7 }, (_, dow) =>
		formatWeekday(new Date(2024, 0, 7 + dow), locale),
	);
}

const weekdayNamesCache = new Map<string, string[]>();

function cachedWeekdayNames(locale: string): string[] {
	const cached = weekdayNamesCache.get(locale);
	if (cached) {
		return cached;
	}
	const names = weekdayNames(locale);
	weekdayNamesCache.set(locale, names);
	return names;
}

/**
 * A GitHub-style contribution heatmap of the last year of dictation activity —
 * the at-a-glance "are you keeping it up" view that pairs with the streak
 * banner. Read-only: date-range filtering lives in the interactive calendar
 * below it. Intensity is anchored to the busiest day so a quiet stretch still
 * shows texture.
 */
export function ContributionGraph({ entries }: ContributionGraphProps) {
	const t = useTranslations("history");
	const locale = useLocaleStore((s) => s.locale);
	const emptyBg = surfaceBg(Math.min(useSurface() + 2, 8));

	const buckets = buildHeatmap(entries);
	const columns = cachedColumns(buckets, locale);
	const weekdays = cachedWeekdayNames(locale);

	let max = 0;
	for (const col of columns) {
		for (const cell of col.cells) {
			if (cell && cell.wordCount > max) {
				max = cell.wordCount;
			}
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
		<div className="overflow-x-auto pb-1">
			<div className="inline-flex min-w-max flex-col gap-1">
				<div className="flex">
					<div className="w-7 shrink-0" />
					{columns.map((col) => (
						<div
							className="w-[11px] shrink-0 whitespace-nowrap text-[9px] text-foreground-muted leading-none"
							key={`m-${col.key}`}
						>
							{col.monthLabel}
						</div>
					))}
				</div>

				<div className="flex">
					<div className="mr-0 flex w-7 shrink-0 flex-col gap-[2px] pr-1.5 text-right">
						{weekdays.map((name, dow) => (
							<div
								className="h-[9px] text-[9px] text-foreground-muted leading-[9px]"
								key={name}
							>
								{WEEKDAY_LABEL_ROWS.has(dow) ? name : ""}
							</div>
						))}
					</div>

					<div className="flex gap-[2px]">
						{columns.map((col) => (
							<div className="flex flex-col gap-[2px]" key={col.key}>
								{keyedColumnCells(col).map(({ cell, key }) => {
									if (cell === null) {
										return <div className="h-[9px] w-[9px]" key={key} />;
									}
									const level = intensityLevel(cell.wordCount, max);
									const bg = level === 0 ? emptyBg : VARIANT_BG[level - 1];
									return (
										<div
											className={`h-[9px] w-[9px] rounded-[2px] ${bg}`}
											key={cell.dayKey}
											title={cellTitle(cell)}
										/>
									);
								})}
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
