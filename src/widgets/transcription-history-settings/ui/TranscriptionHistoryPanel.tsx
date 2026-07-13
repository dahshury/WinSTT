import { Archive02Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import {
	clearTranscriptionHistory,
	clearTransformHistory,
	clearTtsHistory,
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { CLEAR_ACTION_SEGMENT_CLASS } from "../lib/clear-action-segment";
import { filterEntriesByDateRange } from "../lib/word-stats";
import { useTranscriptionHistoryStore } from "../model/history-store";
import { HistoryDashboardSections } from "./HistoryDashboardSections";
import { HistoryLimitsSection } from "./HistoryLimitsSection";
import type { HistoryTableItem } from "./HistoryTable";
import { HistoryTableSection } from "./HistoryTableSection";

export function TranscriptionHistoryPanel() {
	const t = useTranslations("history");
	// History data is hydrated + kept live at the settings-window root
	// (SettingsBootstrap → useTranscriptionHistorySync), so this panel is a pure
	// reader: on every tab revisit the entries array keeps its identity and the
	// stats caches stay warm.
	const entries = useTranscriptionHistoryStore((s) => s.entries);
	const transformEntries = useTranscriptionHistoryStore(
		(s) => s.transformEntries,
	);
	const ttsEntries = useTranscriptionHistoryStore((s) => s.ttsEntries);
	const clearLocal = useTranscriptionHistoryStore((s) => s.clear);
	const clearTransformLocal = useTranscriptionHistoryStore(
		(s) => s.clearTransforms,
	);
	const clearTtsLocal = useTranscriptionHistoryStore((s) => s.clearTts);
	const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
	const [selectedRange, setSelectedRange] = useState<DateRange | null>(null);
	const historyEnabled = useSettingsStore(
		(s) => s.settings.general?.historyEnabled ?? true,
	);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);

	const filteredEntries = filterEntriesByDateRange(
		entries,
		selectedRange?.from ?? null,
		selectedRange?.to ?? null,
	);
	const filteredTransformEntries = filterEntriesByDateRange(
		transformEntries,
		selectedRange?.from ?? null,
		selectedRange?.to ?? null,
	);
	const filteredTtsEntries = filterEntriesByDateRange(
		ttsEntries,
		selectedRange?.from ?? null,
		selectedRange?.to ?? null,
	);
	const combinedHistoryEntries: HistoryTableItem[] = [
		...filteredEntries.map((entry) => ({
			entry,
			kind: "transcription" as const,
		})),
		...filteredTransformEntries.map((entry) => ({
			entry,
			kind: "transform" as const,
		})),
		// TTS runs ride the same table: reshape the run into the row shape the
		// table renders (no recording, so duration stays 0) and carry the full
		// run alongside for the TTS-specific chips (model / voice / cost).
		...filteredTtsEntries.map((entry) => ({
			entry: {
				durationMs: 0,
				id: entry.id,
				text: entry.text,
				timestamp: entry.timestamp,
				wordCount: entry.wordCount,
			},
			kind: "tts" as const,
			tts: entry,
		})),
	];

	// Off-state purge: opting out stops collection but never destroys data
	// silently — this explicit, confirmed action is the only way old rows,
	// transforms, read-aloud runs, and recordings leave the disk.
	const handleDeleteAll = () => {
		Promise.all([
			clearTranscriptionHistory(),
			clearTransformHistory(),
			clearTtsHistory(),
		]).then(() => {
			clearLocal();
			clearTransformLocal();
			clearTtsLocal();
		});
	};

	const masterSection = (
		<SettingSection
			// Turning history OFF stops collection but keeps existing rows on disk —
			// the user must still be able to purge them. A toggled-off section dims
			// and inerts its CHILDREN, so the off-state hint + Delete All live in
			// `footer` (documented as "actions that must stay visible"), which
			// renders outside the dimmed body and stays fully interactive.
			footer={
				historyEnabled ? null : (
					<div className="flex flex-wrap items-center justify-between gap-3 py-2">
						<p className="min-w-0 flex-1 text-foreground-muted text-xs-tight">
							{t("disabledHint")}
						</p>
						<ConfirmDialog
							confirmLabel={t("clearConfirm")}
							description={t("deleteAllDescription")}
							onConfirm={handleDeleteAll}
							onOpenChange={setConfirmDeleteAllOpen}
							open={confirmDeleteAllOpen}
							title={t("deleteAllTitle")}
						/>
						{/* Single action, but wrapped in the same connected ButtonGroup so
						    it reads as the app's standard segmented chip — identical to the
						    clear-actions group in the enabled state. */}
						<ButtonGroup connected>
							<Button
								className={CLEAR_ACTION_SEGMENT_CLASS}
								onClick={() => setConfirmDeleteAllOpen(true)}
							>
								<HugeiconsIcon icon={Delete02Icon} size={14} />
								{t("deleteAllButton")}
							</Button>
						</ButtonGroup>
					</div>
				)
			}
			icon={Archive02Icon}
			onToggle={(v) => updateGeneral({ historyEnabled: v })}
			title={t("enabledTitle")}
			toggled={historyEnabled}
			tooltip={t("enabledTooltip")}
		/>
	);

	if (!historyEnabled) {
		return <div className="flex flex-col">{masterSection}</div>;
	}

	return (
		<div className="flex flex-col">
			{masterSection}
			<HistoryDashboardSections
				entries={entries}
				filteredEntries={filteredEntries}
				filteredTtsEntries={filteredTtsEntries}
				onRangeChange={setSelectedRange}
				selectedRange={selectedRange}
			/>
			<HistoryTableSection combinedHistoryEntries={combinedHistoryEntries} />
			<HistoryLimitsSection />
		</div>
	);
}
