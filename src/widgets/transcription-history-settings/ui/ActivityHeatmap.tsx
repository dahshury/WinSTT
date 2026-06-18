import { Button as BaseButton } from "@base-ui/react/button";
import {
	Calendar03Icon,
	ChartBarLineIcon,
	ChartLineData01Icon,
	Timer01Icon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { ButtonGroup } from "@/shared/ui/button-group";
import {
	buildDefaultCalendarPresets,
	CalendarHeatmap,
	type CalendarPreset,
	type CalendarPresetGroup,
	type CalendarSystemId,
	type DateRange,
} from "@/shared/ui/calendar-heatmap";
import { Select } from "@/shared/ui/select";
import {
	buildHeatmap,
	formatWpm,
	intensityLevel,
	toDayKey,
	wordsPerMinute,
} from "../lib/word-stats";
import type { TranscriptionHistoryEntry } from "../model/history-store";

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

// Render order for the preset clusters below the calendar. Grouping the nine
// shortcuts by time scale (day / month / year) turns one ragged wrap-row into
// three tidy segmented controls.
const PRESET_GROUP_ORDER: CalendarPresetGroup[] = ["day", "month", "year"];

function buildDayStats(
	entries: TranscriptionHistoryEntry[],
): Map<string, DayStat> {
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

const dayStatsCache = new WeakMap<
	TranscriptionHistoryEntry[],
	Map<string, DayStat>
>();

function cachedDayStats(
	entries: TranscriptionHistoryEntry[],
): Map<string, DayStat> {
	const cached = dayStatsCache.get(entries);
	if (cached) {
		return cached;
	}
	const stats = buildDayStats(entries);
	dayStatsCache.set(entries, stats);
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

export function ActivityHeatmap({
	entries,
	onRangeChange,
	selectedRange,
}: ActivityHeatmapProps) {
	const t = useTranslations("history");
	const [metric, setMetric] = useState<Metric>("transcriptions");
	const [calendarSystem, setCalendarSystem] =
		useState<CalendarSystemId>("gregorian");
	const [month, setMonth] = useState<Date>(() => new Date());
	// Lift interactive chrome (preset chips, range panel) above the section it
	// sits in (surfaces system) so it reads as its own surface, not the bg.
	const level = Math.min(useSurface() + 1, 8);
	const panelBg = surfaceBg(level);
	const insetBg = surfaceBg(Math.min(level + 1, 8));

	const dayStats = cachedDayStats(entries);
	const buckets = buildHeatmap(entries);
	const maxValue = buckets.reduce(
		(acc, b) => Math.max(acc, metricValue(dayStats.get(b.dayKey), metric)),
		0,
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
		{
			id: "transcriptions",
			label: t("heatmapMetricTranscriptions"),
			icon: ChartBarLineIcon,
		},
		{ id: "words", label: t("heatmapMetricWords"), icon: ChartLineData01Icon },
		{ id: "wpm", label: t("heatmapMetricWpm"), icon: Timer01Icon },
	];

	const calendarOptions = [
		{
			id: "gregorian",
			label: t("heatmapCalendarGregorian"),
			icon: Calendar03Icon,
		},
		{ id: "hijri", label: t("heatmapCalendarHijri"), icon: Calendar03Icon },
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

	const applyPreset = (preset: CalendarPreset) => {
		onRangeChange(preset.range);
		const target = preset.range.from ?? preset.range.to;
		if (target) {
			setMonth(target);
		}
	};

	const presetGroups: {
		group: CalendarPresetGroup;
		items: CalendarPreset[];
	}[] = [];
	for (const group of PRESET_GROUP_ORDER) {
		const items: CalendarPreset[] = [];
		for (const preset of presets) {
			if (preset.group === group) {
				items.push(preset);
			}
		}
		if (items.length > 0) {
			presetGroups.push({ group, items });
		}
	}

	return (
		<div className="flex w-full flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<span className="text-foreground-muted text-xs-tight">
						{t("heatmapMetric")}
					</span>
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
					<span className="text-foreground-muted text-xs-tight">
						{t("heatmapCalendar")}
					</span>
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

			<div className="flex flex-col items-center gap-2 border-border border-t pt-3">
				{presetGroups.map(({ group, items }) => (
					<ButtonGroup connected key={group}>
						{items.map((preset) => {
							const active = isPresetActive(preset);
							return (
								<BaseButton
									aria-pressed={active}
									className={cn(
										"inline-flex h-7 items-center justify-center px-3 font-medium text-xs-tight transition-colors",
										active
											? "bg-teal text-white"
											: "text-foreground-secondary hover:bg-surface-hover hover:text-foreground",
									)}
									key={preset.label}
									onClick={() => applyPreset(preset)}
									type="button"
								>
									{preset.label}
								</BaseButton>
							);
						})}
					</ButtonGroup>
				))}
			</div>

			<div className="flex items-center justify-end gap-1.5 text-foreground-muted text-xs-tight">
				<span>{t("heatmapLess")}</span>
				{LEGEND_CLASSES.map((cls) => (
					<div className={`h-[11px] w-[11px] rounded-[2px] ${cls}`} key={cls} />
				))}
				<span>{t("heatmapMore")}</span>
			</div>

			{hasRange && selectedRange?.from && selectedRange.to ? (
				<div
					className={cn(
						"flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-foreground-muted text-xs-tight",
						panelBg,
					)}
				>
					<span className="font-mono text-foreground-secondary">
						{`${formatRangeDate(selectedRange.from)} — ${formatRangeDate(selectedRange.to)}`}
					</span>
					<BaseButton
						className={cn(
							"rounded-md border border-border px-2 py-0.5 text-foreground-secondary text-xs-tight transition-colors hover:bg-surface-hover hover:text-foreground",
							insetBg,
						)}
						onClick={() => onRangeChange(null)}
						type="button"
					>
						{t("heatmapClearRange")}
					</BaseButton>
				</div>
			) : (
				<p className="text-center text-foreground-muted text-xs-tight">
					{t("heatmapRangeHint")}
				</p>
			)}
		</div>
	);
}
