"use client";

import { useTranslations } from "next-intl";
import { VList } from "virtua";
import {
	formatDuration,
	formatWpm,
	type TranscriptionHistoryEntry,
	wordsPerMinute,
} from "@/entities/transcription-history";

interface HistoryTableProps {
	entries: TranscriptionHistoryEntry[];
}

const GRID_COLS = "grid-cols-[160px_68px_88px_68px_minmax(0,1fr)]";
const ROW_HEIGHT_ESTIMATE = 40;
const MAX_VISIBLE_ROWS = 12;

function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

interface HistoryRowProps {
	entry: TranscriptionHistoryEntry;
}

function HistoryRow({ entry }: HistoryRowProps) {
	return (
		<div
			className={`grid ${GRID_COLS} items-start border-border/40 border-t text-sm hover:bg-surface-secondary/60`}
		>
			<div className="px-3 py-2 font-mono text-foreground-secondary text-xs-tight tabular-nums">
				{formatTimestamp(entry.timestamp)}
			</div>
			<div className="px-3 py-2 text-right tabular-nums">{entry.wordCount}</div>
			<div className="px-3 py-2 text-right tabular-nums">{formatDuration(entry.durationMs)}</div>
			<div className="px-3 py-2 text-right tabular-nums">
				{formatWpm(wordsPerMinute(entry.wordCount, entry.durationMs))}
			</div>
			<div className="truncate px-3 py-2 text-foreground" title={entry.text}>
				{entry.text}
			</div>
		</div>
	);
}

export function HistoryTable({ entries }: HistoryTableProps) {
	const t = useTranslations("history");
	// Most recent first; entries are stored chronologically by the main process.
	const sorted = [...entries].reverse();

	if (sorted.length === 0) {
		return (
			<div className="px-3 py-6 text-center text-foreground-muted text-sm">{t("tableEmpty")}</div>
		);
	}

	const viewportHeight = Math.min(sorted.length, MAX_VISIBLE_ROWS) * ROW_HEIGHT_ESTIMATE;

	return (
		<div className="flex flex-col overflow-hidden rounded-md border border-border bg-surface-primary">
			<div
				className={`grid ${GRID_COLS} border-border border-b bg-surface-secondary text-left text-foreground-muted text-xs-tight uppercase tracking-wider`}
			>
				<div className="px-3 py-1.5 font-medium font-mono">{t("colTime")}</div>
				<div className="px-3 py-1.5 text-right font-medium font-mono">{t("colWords")}</div>
				<div className="px-3 py-1.5 text-right font-medium font-mono">{t("colDuration")}</div>
				<div className="px-3 py-1.5 text-right font-medium font-mono">{t("colWpm")}</div>
				<div className="px-3 py-1.5 font-medium font-mono">{t("colText")}</div>
			</div>
			<VList className="overscroll-contain" style={{ height: viewportHeight }}>
				{sorted.map((entry) => (
					<HistoryRow entry={entry} key={entry.id} />
				))}
			</VList>
		</div>
	);
}
