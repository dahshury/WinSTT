import { BarChartIcon, Delete02Icon, ListViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SettingSection } from "@/entities/setting";
import { clearTranscriptionHistory } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useTranscriptionHistorySync } from "../api/use-history-sync";
import { aggregate, filterEntriesByDateRange } from "../lib/word-stats";
import { useTranscriptionHistoryStore } from "../model/history-store";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { HistorySummary } from "./HistorySummary";
import { HistoryTable } from "./HistoryTable";

export function TranscriptionHistoryPanel() {
	const t = useTranslations("history");
	useTranscriptionHistorySync();
	const entries = useTranscriptionHistoryStore((s) => s.entries);
	const clearLocal = useTranscriptionHistoryStore((s) => s.clear);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [selectedRange, setSelectedRange] = useState<DateRange | null>(null);

	const filteredEntries = filterEntriesByDateRange(
		entries,
		selectedRange?.from ?? null,
		selectedRange?.to ?? null
	);
	const stats = aggregate(filteredEntries);

	const handleClear = () => {
		clearTranscriptionHistory().then(() => clearLocal());
	};

	return (
		<div className="flex flex-col gap-2">
			<SettingSection icon={BarChartIcon} title={t("summaryTitle")}>
				<div className="py-2">
					<HistorySummary stats={stats} />
				</div>
			</SettingSection>

			<SettingSection icon={BarChartIcon} title={t("heatmapTitle")}>
				<div className="py-2">
					<ActivityHeatmap
						entries={entries}
						onRangeChange={setSelectedRange}
						selectedRange={selectedRange}
					/>
				</div>
			</SettingSection>

			<SettingSection
				headerAction={
					<>
						<ConfirmDialog
							confirmLabel={t("clearConfirm")}
							description={t("clearDescription")}
							onConfirm={handleClear}
							onOpenChange={setConfirmOpen}
							open={confirmOpen}
							title={t("clearTitle")}
						/>
						<Button
							className="flex items-center gap-1.5 bg-surface-elevated px-3 py-1.5 text-foreground-secondary text-xs-tight hover:bg-error hover:text-white disabled:opacity-50"
							disabled={entries.length === 0}
							onClick={() => setConfirmOpen(true)}
						>
							<HugeiconsIcon icon={Delete02Icon} size={14} />
							{t("clearButton")}
						</Button>
					</>
				}
				icon={ListViewIcon}
				title={t("tableTitle")}
			>
				<div className="py-2">
					<HistoryTable entries={filteredEntries} />
				</div>
			</SettingSection>
		</div>
	);
}
