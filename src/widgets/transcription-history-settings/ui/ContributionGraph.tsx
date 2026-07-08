import { Button as BaseButton } from "@base-ui/react/button";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useLocaleStore } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { NAV_BUTTON_CLASS } from "@/shared/ui/calendar-heatmap";
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

// One "page" of the rolling year: ~4 months of week columns. Cells flex to
// fill the panel width, so fewer columns per page = bigger, readable cells —
// the paging chevrons cover the rest of the year.
const WEEKS_PER_PAGE = 18;

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
 * Short month name per visible column: the first column is always labeled for
 * context, then every column where the month changes.
 */
function visibleMonthLabels(visible: Column[], locale: string): string[] {
	let lastMonth = -1;
	return visible.map((col) => {
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
}

interface ColumnSlot {
	/** `null` for the invisible pads that keep the earliest page full-width. */
	col: Column | null;
	key: string;
	label: string;
}

/**
 * A GitHub-style contribution heatmap of the last year of dictation activity —
 * the at-a-glance "are you keeping it up" view that pairs with the streak
 * banner. Read-only: date-range filtering lives in the interactive calendar
 * below it. Shows ~4 months at a time with cells that flex to fill the panel
 * width; the chevrons page back through the rest of the rolling year.
 * Intensity is anchored to the busiest day of the WHOLE year, so paging never
 * rescales the ramp.
 */
export function ContributionGraph({ entries }: ContributionGraphProps) {
	const t = useTranslations("history");
	const locale = useLocaleStore((s) => s.locale);
	const emptyBg = surfaceBg(Math.min(useSurface() + 2, 8));
	// Pages back from the latest window (0 = the most recent ~4 months).
	const [pageBack, setPageBack] = useState(0);

	const buckets = buildHeatmap(entries);
	const columns = cachedColumns(buckets);
	const weekdays = cachedWeekdayNames(locale);

	const totalPages = Math.max(1, Math.ceil(columns.length / WEEKS_PER_PAGE));
	const page = Math.min(pageBack, totalPages - 1);
	const end = columns.length - page * WEEKS_PER_PAGE;
	const visible = columns.slice(Math.max(0, end - WEEKS_PER_PAGE), end);
	const labels = visibleMonthLabels(visible, locale);

	// Pad the earliest (possibly short) page with invisible leading columns so
	// cell size stays identical across pages.
	const slots: ColumnSlot[] = [
		...Array.from({ length: WEEKS_PER_PAGE - visible.length }, (_, i) => ({
			col: null,
			key: `pad-col-${i}`,
			label: "",
		})),
		...visible.map((col, i) => ({ col, key: col.key, label: labels[i] ?? "" })),
	];

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

	const renderColumn = (slot: ColumnSlot) => (
		<div className="flex min-w-0 flex-1 flex-col gap-[3px]" key={slot.key}>
			{slot.col === null
				? WEEKDAY_KEYS.map((dow) => (
						<div className="aspect-square w-full" key={`${slot.key}-${dow}`} />
					))
				: keyedColumnCells(slot.col).map(({ cell, key }) => {
						if (cell === null) {
							return <div className="aspect-square w-full" key={key} />;
						}
						const level = intensityLevel(cell.wordCount, max);
						const bg = level === 0 ? emptyBg : VARIANT_BG[level - 1];
						return (
							<Tooltip content={cellTitle(cell)} key={cell.dayKey}>
								<div className={`aspect-square w-full rounded-[4px] ${bg}`} />
							</Tooltip>
						);
					})}
		</div>
	);

	return (
		// max-w caps the aspect-square cells at ~36px so an ultra-wide settings
		// window doesn't inflate the grid into a wall of tiles; centering keeps
		// the nav chevrons hugging the grid edges.
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
			<div className="flex items-center">
				<div className="flex w-9 shrink-0 items-center">
					<BaseButton
						aria-label={t("heatmapEarlier")}
						className={cn(
							NAV_BUTTON_CLASS,
							"disabled:pointer-events-none disabled:opacity-20",
						)}
						disabled={page >= totalPages - 1}
						onClick={() => setPageBack(page + 1)}
						type="button"
					>
						<HugeiconsIcon
							className="rtl:-scale-x-100"
							icon={ArrowLeft01Icon}
							size={14}
						/>
					</BaseButton>
				</div>
				<div className="flex min-w-0 flex-1 gap-[3px]">
					{slots.map((slot) => (
						<div className="relative h-4 min-w-0 flex-1" key={`m-${slot.key}`}>
							{slot.label ? (
								<span className="absolute start-0 whitespace-nowrap text-foreground-muted text-xs-tight">
									{slot.label}
								</span>
							) : null}
						</div>
					))}
				</div>
				<div className="flex w-9 shrink-0 items-center justify-end">
					<BaseButton
						aria-label={t("heatmapLater")}
						className={cn(
							NAV_BUTTON_CLASS,
							"disabled:pointer-events-none disabled:opacity-20",
						)}
						disabled={page === 0}
						onClick={() => setPageBack(page - 1)}
						type="button"
					>
						<HugeiconsIcon
							className="rtl:-scale-x-100"
							icon={ArrowRight01Icon}
							size={14}
						/>
					</BaseButton>
				</div>
			</div>

			<div className="flex">
				<div className="flex w-9 shrink-0 flex-col gap-[3px] overflow-hidden pe-2">
					{weekdays.map((name) => (
						<div
							className="flex flex-1 items-center justify-end whitespace-nowrap text-2xs text-foreground-muted"
							key={name}
						>
							{name}
						</div>
					))}
				</div>
				<div className="flex min-w-0 flex-1 gap-[3px]">
					{slots.map(renderColumn)}
				</div>
				<div className="w-9 shrink-0" />
			</div>
		</div>
	);
}
