"use client";

import { useTranslations } from "next-intl";
import {
	formatDuration,
	formatWpm,
	type TranscriptionHistoryEntry,
	wordsPerMinute,
} from "@/entities/transcription-history";

interface HistoryTableProps {
	entries: TranscriptionHistoryEntry[];
	visibleLimit: number;
}

function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function HistoryTable({ entries, visibleLimit }: HistoryTableProps) {
	const t = useTranslations("history");
	// Most recent first; entries are stored chronologically by the main process.
	const sorted = [...entries].reverse();
	const visible = sorted.slice(0, visibleLimit);
	const hiddenCount = sorted.length - visible.length;

	if (visible.length === 0) {
		return (
			<div className="px-3 py-6 text-center text-foreground-muted text-sm">{t("tableEmpty")}</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="overflow-hidden rounded-md border border-border bg-surface-primary">
				<table className="w-full table-fixed border-collapse text-sm">
					<thead>
						<tr className="border-border border-b bg-surface-secondary text-left text-foreground-muted text-xs-tight uppercase tracking-wider">
							<th className="w-[160px] px-3 py-1.5 font-medium font-mono">{t("colTime")}</th>
							<th className="w-[68px] px-3 py-1.5 text-right font-medium font-mono">
								{t("colWords")}
							</th>
							<th className="w-[88px] px-3 py-1.5 text-right font-medium font-mono">
								{t("colDuration")}
							</th>
							<th className="w-[68px] px-3 py-1.5 text-right font-medium font-mono">
								{t("colWpm")}
							</th>
							<th className="px-3 py-1.5 font-medium font-mono">{t("colText")}</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((entry) => (
							<tr
								className="border-border/40 border-t align-top hover:bg-surface-secondary/60"
								key={entry.id}
							>
								<td className="px-3 py-2 font-mono text-foreground-secondary text-xs-tight tabular-nums">
									{formatTimestamp(entry.timestamp)}
								</td>
								<td className="px-3 py-2 text-right tabular-nums">{entry.wordCount}</td>
								<td className="px-3 py-2 text-right tabular-nums">
									{formatDuration(entry.durationMs)}
								</td>
								<td className="px-3 py-2 text-right tabular-nums">
									{formatWpm(wordsPerMinute(entry.wordCount, entry.durationMs))}
								</td>
								<td
									className="overflow-hidden truncate px-3 py-2 text-foreground"
									title={entry.text}
								>
									{entry.text}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{hiddenCount > 0 && (
				<div className="text-foreground-muted text-xs-tight">
					{t("tableTruncated", {
						visible: visible.length,
						total: sorted.length,
					})}
				</div>
			)}
		</div>
	);
}
