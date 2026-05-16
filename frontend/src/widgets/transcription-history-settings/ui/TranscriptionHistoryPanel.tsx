"use client";

import { BarChartIcon, Delete02Icon, ListViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { SettingSection } from "@/entities/setting";
import { aggregate, useTranscriptionHistoryStore } from "@/entities/transcription-history";
import { useTranscriptionHistorySync } from "@/features/sync-transcription-history";
import { clearTranscriptionHistory } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { HistorySummary } from "./HistorySummary";
import { HistoryTable } from "./HistoryTable";

export function TranscriptionHistoryPanel() {
	const t = useTranslations("history");
	useTranscriptionHistorySync();
	const entries = useTranscriptionHistoryStore((s) => s.entries);
	const clearLocal = useTranscriptionHistoryStore((s) => s.clear);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const stats = aggregate(entries);

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
					<ActivityHeatmap entries={entries} />
				</div>
			</SettingSection>

			<SettingSection icon={ListViewIcon} title={t("tableTitle")}>
				<div className="py-2">
					<HistoryTable entries={entries} />
				</div>
			</SettingSection>

			<div className="flex justify-end pt-1">
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
			</div>
		</div>
	);
}
