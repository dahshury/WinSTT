import {
	BarChartIcon,
	Calendar03Icon,
	DashboardCircleIcon,
	Delete02Icon,
	InfinityIcon,
	ListViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { clearTranscriptionHistory } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Select, type SelectOption } from "@/shared/ui/select";
import { useTranscriptionHistorySync } from "../api/use-history-sync";
import { aggregate, filterEntriesByDateRange } from "../lib/word-stats";
import { useTranscriptionHistoryStore } from "../model/history-store";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { HistorySummary } from "./HistorySummary";
import { HistoryTable } from "./HistoryTable";

type RetentionValue = "never" | "cap" | "days3" | "weeks2" | "months3";

export function TranscriptionHistoryPanel() {
	const t = useTranslations("history");
	useTranscriptionHistorySync();
	const entries = useTranscriptionHistoryStore((s) => s.entries);
	const clearLocal = useTranscriptionHistoryStore((s) => s.clear);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [selectedRange, setSelectedRange] = useState<DateRange | null>(null);
	const historyMaxEntries = useSettingsStore((s) => s.settings.general?.historyMaxEntries ?? 1000);
	const recordingRetention = useSettingsStore(
		(s) => (s.settings.general?.recordingRetention as RetentionValue | undefined) ?? "cap"
	);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const retentionOptions: SelectOption[] = [
		{ id: "never", label: t("retentionNever"), icon: InfinityIcon },
		{ id: "cap", label: t("retentionCap"), icon: ListViewIcon },
		{ id: "days3", label: t("retentionDays3"), icon: Calendar03Icon },
		{ id: "weeks2", label: t("retentionWeeks2"), icon: Calendar03Icon },
		{ id: "months3", label: t("retentionMonths3"), icon: Calendar03Icon },
	];

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

			{/* Limits — history-entry cap and saved-recording retention.
			    Cap defaults to 1000, retention defaults to "cap" (delete
			    only when the entry count exceeds the cap; absolute time
			    cutoffs are opt-in). */}
			<SettingSection icon={DashboardCircleIcon} title={t("limitsTitle")}>
				<div className="flex flex-col divide-y divide-surface-1">
					<FormControl
						label={t("historyMaxEntries")}
						labelTrailing={
							<SettingResetButton
								isDefault={historyMaxEntries === DEFAULT_SETTINGS.general.historyMaxEntries}
								onReset={() =>
									updateGeneral({ historyMaxEntries: DEFAULT_SETTINGS.general.historyMaxEntries })
								}
							/>
						}
						layout="row"
						tooltip={`${t("historyMaxEntriesTooltip")} ${t("historyMaxEntriesCaption")}`}
					>
						<ElevatedSurface className="w-fit" inline>
							<NumberStepper
								max={10_000}
								min={10}
								onChange={(v) => updateGeneral({ historyMaxEntries: v })}
								step={10}
								value={historyMaxEntries}
							/>
						</ElevatedSurface>
					</FormControl>
					<FormControl
						label={t("retention")}
						labelTrailing={
							<SettingResetButton
								isDefault={recordingRetention === DEFAULT_SETTINGS.general.recordingRetention}
								onReset={() =>
									updateGeneral({
										recordingRetention: DEFAULT_SETTINGS.general.recordingRetention,
									})
								}
							/>
						}
						layout="row"
						tooltip={t("retentionTooltip")}
					>
						<ElevatedSurface className="w-52" inline>
							<Select
								onChange={(v) => updateGeneral({ recordingRetention: v as RetentionValue })}
								options={retentionOptions}
								value={recordingRetention}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>
			</SettingSection>
		</div>
	);
}
