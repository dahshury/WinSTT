"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
	buildHeatmap,
	formatDuration,
	formatWpm,
	intensityLevel,
	type TranscriptionHistoryEntry,
	toDayKey,
	wordsPerMinute,
} from "@/entities/transcription-history";
import { CalendarHeatmap, type CalendarSystemId } from "@/shared/ui/calendar-heatmap";
import { Select } from "@/shared/ui/select";

interface ActivityHeatmapProps {
	entries: TranscriptionHistoryEntry[];
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

export function ActivityHeatmap({ entries }: ActivityHeatmapProps) {
	const t = useTranslations("history");
	const [metric, setMetric] = useState<Metric>("transcriptions");
	const [calendarSystem, setCalendarSystem] = useState<CalendarSystemId>("gregorian");
	const [selectedDate, setSelectedDate] = useState<Date | null>(null);

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
		const formatted = date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
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

	const handleSelect = (value: Date | { from: Date | null; to: Date | null } | null) => {
		setSelectedDate(value instanceof Date ? value : null);
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

	const selectedStat = selectedDate ? dayStats.get(toDayKey(selectedDate.getTime())) : undefined;
	const selectedEntries = selectedDate
		? entries
				.filter((e) => toDayKey(e.timestamp) === toDayKey(selectedDate.getTime()))
				.sort((a, b) => a.timestamp - b.timestamp)
		: [];

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
				formatTooltip={formatTooltip}
				mode="single"
				nextMonthLabel={t("heatmapNextMonth")}
				onSelect={handleSelect}
				prevMonthLabel={t("heatmapPrevMonth")}
				renderDayBadge={renderDayBadge}
				selected={selectedDate}
				variantClassnames={VARIANT_CLASSES}
				weekStartsOn={0}
			/>

			<div className="flex items-center justify-end gap-1.5 text-foreground-muted text-xs-tight">
				<span>{t("heatmapLess")}</span>
				{LEGEND_CLASSES.map((cls) => (
					<div className={`h-[11px] w-[11px] rounded-[2px] ${cls}`} key={cls} />
				))}
				<span>{t("heatmapMore")}</span>
			</div>

			{selectedDate && selectedStat ? (
				<div className="flex flex-col gap-2 rounded-md border border-border bg-surface-elevated p-3">
					<div className="flex items-baseline justify-between">
						<span className="font-medium text-foreground text-sm">
							{selectedDate.toLocaleDateString(undefined, {
								weekday: "long",
								year: "numeric",
								month: "long",
								day: "numeric",
							})}
						</span>
						<span className="text-foreground-muted text-xs-tight">
							{selectedStat.count} {t("tableTitle").toLowerCase()} ·{" "}
							{selectedStat.words.toLocaleString()} {t("heatmapWords")} ·{" "}
							{formatWpm(wordsPerMinute(selectedStat.words, selectedStat.durationMs))} {t("colWpm")}{" "}
							· {formatDuration(selectedStat.durationMs)}
						</span>
					</div>
					<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
						{selectedEntries.map((entry) => (
							<li
								className="flex items-start gap-2 rounded-sm bg-surface-tertiary px-2 py-1.5 text-xs-tight"
								key={entry.id}
							>
								<span className="shrink-0 font-mono text-foreground-muted">
									{new Date(entry.timestamp).toLocaleTimeString(undefined, {
										hour: "2-digit",
										minute: "2-digit",
									})}
								</span>
								<span className="min-w-0 flex-1 truncate text-foreground-secondary">
									{entry.text}
								</span>
								<span className="shrink-0 text-foreground-muted">
									{entry.wordCount} {t("heatmapWords")}
								</span>
							</li>
						))}
					</ul>
				</div>
			) : (
				<p className="text-center text-foreground-muted text-xs-tight">{t("heatmapDayHint")}</p>
			)}
		</div>
	);
}
