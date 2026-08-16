import { Delete02Icon, ListViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { SettingSection } from "@/entities/setting";
import {
	clearTranscriptionHistory,
	clearTransformHistory,
	clearTtsHistory,
	deleteTranscriptionHistoryEntry,
	deleteTransformHistoryEntry,
	deleteTtsHistoryEntry,
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

import { CLEAR_ACTION_SEGMENT_CLASS } from "../lib/clear-action-segment";
import {
	type HistoryKind,
	type HistoryKindOption,
	matchesHistoryKind,
} from "../lib/history-kinds";
import { useHistorySearch } from "../api/use-history-search";
import { useTranscriptionHistoryStore } from "../model/history-store";
import type {
	HistoryTableEntryKind,
	HistoryTableItem,
} from "../model/history-table-types";
import { HistoryTable } from "./HistoryTable";
import { HistorySearchInput } from "./HistorySearchInput";
import { LiveListenSessionCard } from "./LiveListenSessionCard";

interface HistoryTableSectionProps {
	/** The date-filtered combined rows (STT + transform + TTS) to display. */
	combinedHistoryEntries: HistoryTableItem[];
	/** Kind scope, picked in the tab's filters menu up in the dashboard header.
	 *  It both narrows the rows and names what Clear acts on. */
	historyKind: HistoryKind;
	historyKindOptions: HistoryKindOption[];
	selectedRange: DateRange | null;
}

/**
 * The combined history table plus its search and clear controls. The kind scope
 * itself is picked in the tab's filters menu (dashboard header, alongside the
 * date range); this section consumes it to narrow the rows and to decide which
 * confirm dialog the single Clear button arms.
 */
export function HistoryTableSection({
	combinedHistoryEntries,
	historyKind,
	historyKindOptions,
	selectedRange,
}: HistoryTableSectionProps) {
	const t = useTranslations("history");
	const clearLocal = useTranscriptionHistoryStore((s) => s.clear);
	const clearTransformLocal = useTranscriptionHistoryStore(
		(s) => s.clearTransforms,
	);
	const clearTtsLocal = useTranscriptionHistoryStore((s) => s.clearTts);
	const removeEntry = useTranscriptionHistoryStore((s) => s.removeEntry);
	const removeTransformEntry = useTranscriptionHistoryStore(
		(s) => s.removeTransformEntry,
	);
	const removeTtsEntry = useTranscriptionHistoryStore((s) => s.removeTtsEntry);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [confirmTransformsOpen, setConfirmTransformsOpen] = useState(false);
	const [confirmTtsOpen, setConfirmTtsOpen] = useState(false);
	const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [actionPending, setActionPending] = useState(false);
	const [query, setQuery] = useState("");
	const search = useHistorySearch(query, combinedHistoryEntries, selectedRange);

	const runHistoryAction = (action: () => Promise<void>) => {
		setActionError(null);
		setActionPending(true);
		void action()
			.catch((error: unknown) => {
				setActionError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				setActionPending(false);
			});
	};

	const handleClear = () => {
		runHistoryAction(async () => {
			await clearTranscriptionHistory();
			clearLocal();
		});
	};

	const handleClearTransforms = () => {
		runHistoryAction(async () => {
			await clearTransformHistory();
			clearTransformLocal();
		});
	};

	const handleClearTts = () => {
		runHistoryAction(async () => {
			await clearTtsHistory();
			clearTtsLocal();
		});
	};

	const handleDeleteAll = () => {
		runHistoryAction(async () => {
			await Promise.all([
				clearTranscriptionHistory(),
				clearTransformHistory(),
				clearTtsHistory(),
			]);
			clearLocal();
			clearTransformLocal();
			clearTtsLocal();
		});
	};

	const handleDeleteEntry = (id: string, kind: HistoryTableEntryKind) => {
		runHistoryAction(async () => {
			const result =
				kind === "transform"
					? await deleteTransformHistoryEntry(id)
					: kind === "tts"
						? await deleteTtsHistoryEntry(id)
						: await deleteTranscriptionHistoryEntry(id);
			if (!result.deleted) {
				throw new Error("The history entry could not be deleted.");
			}
			if (kind === "transform") {
				removeTransformEntry(id);
			} else if (kind === "tts") {
				removeTtsEntry(id);
			} else {
				removeEntry(id);
			}
		});
	};

	// Which confirm dialog the single Clear button arms — "All" clears every
	// kind at once through the delete-all dialog.
	const armClearDialog: Record<HistoryKind, () => void> = {
		all: () => setConfirmDeleteAllOpen(true),
		history: () => setConfirmOpen(true),
		transforms: () => setConfirmTransformsOpen(true),
		tts: () => setConfirmTtsOpen(true),
	};
	const activeKind = historyKindOptions.find(
		(option) => option.id === historyKind,
	);
	const activeKindCount = activeKind?.count ?? 0;
	const activeKindLabel = activeKind?.label ?? "";
	// Kind scope applied to the (already date-filtered) combined rows.
	const visibleHistoryEntries = search.items.filter((row) =>
		matchesHistoryKind(row, historyKind),
	);

	return (
		<SettingSection
			headerAction={
				<div className="flex flex-wrap items-center justify-end gap-1.5">
					{/* Controlled confirm dialogs — portal-rendered, no inline layout,
					    so they sit outside the joined ButtonGroup below. */}
					<ConfirmDialog
						confirmLabel={t("clearConfirm")}
						description={t("clearDescription")}
						onConfirm={handleClear}
						onOpenChange={setConfirmOpen}
						open={confirmOpen}
						title={t("clearTitle")}
					/>
					<ConfirmDialog
						confirmLabel={t("clearConfirm")}
						description={t("clearTransformsDescription")}
						onConfirm={handleClearTransforms}
						onOpenChange={setConfirmTransformsOpen}
						open={confirmTransformsOpen}
						title={t("clearTransformsTitle")}
					/>
					<ConfirmDialog
						confirmLabel={t("clearConfirm")}
						description={t("clearTtsDescription")}
						onConfirm={handleClearTts}
						onOpenChange={setConfirmTtsOpen}
						open={confirmTtsOpen}
						title={t("clearTtsTitle")}
					/>
					<ConfirmDialog
						confirmLabel={t("clearConfirm")}
						description={t("deleteAllDescription")}
						onConfirm={handleDeleteAll}
						onOpenChange={setConfirmDeleteAllOpen}
						open={confirmDeleteAllOpen}
						title={t("deleteAllTitle")}
					/>
					{/* Clear acts on whatever kind the tab's filters menu has scoped
					    to, so its label names that kind — the control that picks it
					    lives in the dashboard header, not beside this button. */}
					<HistorySearchInput
						count={search.totalLabelCount}
						hasMore={search.hasMore}
						onQueryChange={setQuery}
					/>
					<ButtonGroup connected>
						<Button
							className={CLEAR_ACTION_SEGMENT_CLASS}
							disabled={activeKindCount === 0 || actionPending}
							onClick={armClearDialog[historyKind]}
						>
							<HugeiconsIcon icon={Delete02Icon} size={14} />
							{t("clearKind", { kind: activeKindLabel })}
						</Button>
					</ButtonGroup>
				</div>
			}
			boxed
			icon={ListViewIcon}
			title={t("combinedTableTitle")}
		>
			<div className="flex flex-col gap-2 py-2">
				{actionError ? (
					<p className="text-body-sm text-error" role="alert">
						{actionError}
					</p>
				) : null}
				{/* Ongoing listen session — live captions + finalize-now. Renders
				    only while a session is active; the finalized entry drops into
				    the table below through the standard history events. */}
				<LiveListenSessionCard />
				{query.trim() ? (
					<p className="text-foreground-muted text-xs" role="status">
						{search.hasMore
							? t("searchMatchCountMore", {
									count: search.totalLabelCount,
								})
							: t("searchMatchCount", {
									count: search.totalLabelCount,
								})}
					</p>
				) : null}
				<HistoryTable
					{...(query.trim() ? { emptyLabel: t("searchNoResults") } : {})}
					entries={visibleHistoryEntries}
					highlights={search.highlights}
					onDeleteEntry={handleDeleteEntry}
					preserveOrder={Boolean(query.trim())}
				/>
			</div>
		</SettingSection>
	);
}
