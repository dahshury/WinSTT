import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
	buildHeatmap,
	formatWpm,
	intensityLevel,
	type TranscriptionHistoryEntry,
	toDayKey,
	wordsPerMinute,
} from "@/entities/transcription-history";
import { cn } from "@/shared/lib/cn";
import {
	buildDefaultCalendarPresets,
	CalendarHeatmap,
	type CalendarPreset,
	type CalendarSystemId,
	type DateRange,
} from "@/shared/ui/calendar-heatmap";
import { Select } from "@/shared/ui/select";

interface ActivityHeatmapProps {
	entries: TranscriptionHistoryEntry[];
	onRangeChange: (range: DateRange | null) => void;
	selectedRange: DateRange | null;
}

type Metric = "transcriptions" | "words" | "wpm";

interface DayStat {
	count: number;
	durationMs: number;
	words: number;
}

const EMPTY_CLASS = "bg-surface-elevated";
const VARIANT_CLASSES: string[] = [
	"bg-teal/20 hover:bg-teal/20 text-foreground",
	"bg-teal/40 hover:bg-teal/40 text-foreground",
	"bg-teal/65 hover:bg-teal/65 text-white",
	"bg-teal hover:bg-teal text-white",
];
const LEGEND_CLASSES = [EMPTY_CLASS, ...VARIANT_CLASSES];

function buildDayStats(entries: TranscriptionHistoryEntry[]): Map<string, DayStat> {
	const stats = new Map<string, DayStat>();
	for (const entry of entries) {
		const key = toDayKey(entry.timestamp);
		const prev = stats.get(key) ?? { count: 0, words: 0, durationMs: 0 };
		stats.set(key, {
			count: prev.count + 1,
			words: prev.words + entry.wordCount,
			durationMs: prev.durationMs + entry.durationMs,
		});
	}
	return stats;
}

function metricValue(stat: DayStat | undefined, metric: Metric): number {
	if (!stat) {
		return 0;
	}
	if (metric === "transcriptions") {
		return stat.count;
	}
	if (metric === "words") {
		return stat.words;
	}
	return wordsPerMinute(stat.words, stat.durationMs);
}

function formatMetric(value: number, metric: Metric): string {
	if (value <= 0) {
		return "";
	}
	if (metric === "wpm") {
		return formatWpm(value);
	}
	return String(Math.round(value));
}

function formatRangeDate(date: Date): string {
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export function ActivityHeatmap({ entries, onRangeChange, selectedRange }: ActivityHeatmapProps) {
	const t = useTranslations("history");
	const [metric, setMetric] = useState<Metric>("transcriptions");
	const [calendarSystem, setCalendarSystem] = useState<CalendarSystemId>("gregorian");
	const [month, setMonth] = useState<Date>(() => new Date());

	const dayStats = buildDayStats(entries);
	const buckets = buildHeatmap(entries);
	const maxValue = buckets.reduce(
		(acc, b) => Math.max(acc, metricValue(dayStats.get(b.dayKey), metric)),
		0
	);

	const datesPerVariant: Date[][] = [[], [], [], []];
	for (const bucket of buckets) {
		const value = metricValue(dayStats.get(bucket.dayKey), metric);
		if (value <= 0) {
			continue;
		}
		const level = intensityLevel(value, maxValue);
		if (level >= 1 && level <= 4) {
			datesPerVariant[level - 1]?.push(bucket.date);
		}
	}

	const formatTooltip = (date: Date): string => {
		const formatted = formatRangeDate(date);
		const stat = dayStats.get(toDayKey(date.getTime()));
		if (!stat) {
			return formatted;
		}
		const wpm = wordsPerMinute(stat.words, stat.durationMs);
		return `${formatted} · ${stat.count} ${t("tableTitle").toLowerCase()} · ${stat.words.toLocaleString()} ${t("heatmapWords")} · ${formatWpm(wpm)} ${t("colWpm")}`;
	};

	const renderDayBadge = (date: Date): ReactNode => {
		const value = metricValue(dayStats.get(toDayKey(date.getTime())), metric);
		return formatMetric(value, metric);
	};

	const isDisabled = (date: Date): boolean =>
		(dayStats.get(toDayKey(date.getTime()))?.count ?? 0) === 0;

	const handleSelect = (value: Date | DateRange | null) => {
		if (value === null || value instanceof Date) {
			onRangeChange(null);
			return;
		}
		onRangeChange(value);
	};

	const metricOptions = [
		{ id: "transcriptions", label: t("heatmapMetricTranscriptions") },
		{ id: "words", label: t("heatmapMetricWords") },
		{ id: "wpm", label: t("heatmapMetricWpm") },
	];

	const calendarOptions = [
		{ id: "gregorian", label: t("heatmapCalendarGregorian") },
		{ id: "hijri", label: t("heatmapCalendarHijri") },
	];

	const presets = buildDefaultCalendarPresets({
		today: t("presetToday"),
		yesterday: t("presetYesterday"),
		last7Days: t("presetLast7Days"),
		last30Days: t("presetLast30Days"),
		monthToDate: t("presetMonthToDate"),
		thisMonth: t("presetThisMonth"),
		lastMonth: t("presetLastMonth"),
		yearToDate: t("presetYearToDate"),
		lastYear: t("presetLastYear"),
	});

	const hasRange = Boolean(selectedRange?.from && selectedRange?.to);

	const isPresetActive = (preset: CalendarPreset): boolean => {
		const r = selectedRange;
		const p = preset.range;
		if (!(r?.from && r.to && p.from && p.to)) {
			return false;
		}
		return (
			toDayKey(r.from.getTime()) === toDayKey(p.from.getTime()) &&
			toDayKey(r.to.getTime()) === toDayKey(p.to.getTime())
		);
	};

	return (
		<div className="flex w-full flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<span className="text-foreground-muted text-xs-tight">{t("heatmapMetric")}</span>
					<div className="w-40">
						<Select
							aria-label={t("heatmapMetric")}
							onChange={(v) => setMetric(v as Metric)}
							options={metricOptions}
							value={metric}
						/>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-foreground-muted text-xs-tight">{t("heatmapCalendar")}</span>
					<div className="w-32">
						<Select
							aria-label={t("heatmapCalendar")}
							onChange={(v) => setCalendarSystem(v as CalendarSystemId)}
							options={calendarOptions}
							value={calendarSystem}
						/>
					</div>
				</div>
			</div>

			<CalendarHeatmap
				calendarSystem={calendarSystem}
				cellSize="2.5rem"
				className="p-0"
				datesPerVariant={datesPerVariant}
				disabled={isDisabled}
				fillWidth
				formatTooltip={formatTooltip}
				mode="range"
				month={month}
				nextMonthLabel={t("heatmapNextMonth")}
				numberOfMonths={2}
				onMonthChange={setMonth}
				onSelect={handleSelect}
				prevMonthLabel={t("heatmapPrevMonth")}
				renderDayBadge={renderDayBadge}
				selected={selectedRange}
				variantClassnames={VARIANT_CLASSES}
				weekStartsOn={0}
			/>

			<div className="border-border border-t pt-3">
				<div className="flex flex-wrap items-center gap-1.5">
					{presets.map((preset) => {
						const active = isPresetActive(preset);
						return (
							<button
								className={cn(
									"inline-flex h-7 items-center justify-center rounded-md border px-2.5 font-medium text-xs-tight transition-colors",
									active
										? "border-teal/60 bg-teal/15 text-foreground shadow-surface-1"
										: "border-border bg-surface-elevated text-foreground-secondary hover:border-foreground-muted/40 hover:bg-surface-hover hover:text-foreground"
								)}
								key={preset.label}
								onClick={() => {
									onRangeChange(preset.range);
									const target = preset.range.from ?? preset.range.to;
									if (target) {
										setMonth(target);
									}
								}}
								type="button"
							>
								{preset.label}
							</button>
						);
					})}
				</div>
			</div>

			<div className="flex items-center justify-end gap-1.5 text-foreground-muted text-xs-tight">
				<span>{t("heatmapLess")}</span>
				{LEGEND_CLASSES.map((cls) => (
					<div className={`h-[11px] w-[11px] rounded-[2px] ${cls}`} key={cls} />
				))}
				<span>{t("heatmapMore")}</span>
			</div>

			{hasRange && selectedRange?.from && selectedRange.to ? (
				<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-elevated px-3 py-2 text-foreground-muted text-xs-tight">
					<span className="font-mono text-foreground-secondary">
						{`${formatRangeDate(selectedRange.from)} — ${formatRangeDate(selectedRange.to)}`}
					</span>
					<button
						className="rounded-md border border-border bg-surface-tertiary px-2 py-0.5 text-foreground-secondary text-xs-tight transition-colors hover:bg-surface-hover hover:text-foreground"
						onClick={() => onRangeChange(null)}
						type="button"
					>
						{t("heatmapClearRange")}
					</button>
				</div>
			) : (
				<p className="text-center text-foreground-muted text-xs-tight">{t("heatmapRangeHint")}</p>
			)}
		</div>
	);
}
