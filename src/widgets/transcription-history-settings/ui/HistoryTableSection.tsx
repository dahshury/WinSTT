import { Delete02Icon, ListViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { SettingSection } from "@/entities/setting";
import {
	clearTranscriptionHistory,
	clearTransformHistory,
	clearTtsHistory,
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Select, type SelectOption } from "@/shared/ui/select";
import { CLEAR_ACTION_SEGMENT_CLASS } from "../lib/clear-action-segment";
import { useHistorySearch } from "../api/use-history-search";
import { useTranscriptionHistoryStore } from "../model/history-store";
import type { HistoryTableItem } from "../model/history-table-types";
import { HistoryTable } from "./HistoryTable";
import { HistorySearchInput } from "./HistorySearchInput";
import { LiveListenSessionCard } from "./LiveListenSessionCard";

interface HistoryTableSectionProps {
	/** The date-filtered combined rows (STT + transform + TTS) to display. */
	combinedHistoryEntries: HistoryTableItem[];
	selectedRange: DateRange | null;
}

/**
 * The combined history table plus its kind filter and clear controls. The
 * shared Select both filters the visible rows by kind (default "All") and names
 * the target of the single Clear button, which arms the matching confirm dialog.
 */
export function HistoryTableSection({
	combinedHistoryEntries,
	selectedRange,
}: HistoryTableSectionProps) {
	const t = useTranslations("history");
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
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [confirmTransformsOpen, setConfirmTransformsOpen] = useState(false);
	const [confirmTtsOpen, setConfirmTtsOpen] = useState(false);
	const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
	// The combined history table's kind filter, doubling as the target of the
	// single "Clear" action: the shared Select picks which history to show (and
	// clear), with "All" as the default that shows everything and clears all
	// three kinds at once.
	const [historyKind, setHistoryKind] = useState<
		"all" | "history" | "transforms" | "tts"
	>("all");
	const [query, setQuery] = useState("");
	const search = useHistorySearch(query, combinedHistoryEntries, selectedRange);

	const handleClear = () => {
		clearTranscriptionHistory().then(() => clearLocal());
	};

	const handleClearTransforms = () => {
		clearTransformHistory().then(() => clearTransformLocal());
	};

	const handleClearTts = () => {
		clearTtsHistory().then(() => clearTtsLocal());
	};

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

	// The history kinds the Select filters/clears by. `count` drives the Clear
	// button's disabled state (nothing to clear) and `open` arms the matching
	// confirm dialog — "All" clears everything via the delete-all dialog. Labels
	// reuse the section nouns already localized in this namespace.
	const allHistoryKind = {
		count: entries.length + transformEntries.length + ttsEntries.length,
		id: "all" as const,
		label: t("filterAll"),
		open: () => setConfirmDeleteAllOpen(true),
	};
	const historyKinds = [
		allHistoryKind,
		{
			count: entries.length,
			id: "history" as const,
			label: t("tableTitle"),
			open: () => setConfirmOpen(true),
		},
		{
			count: transformEntries.length,
			id: "transforms" as const,
			label: t("transformTableTitle"),
			open: () => setConfirmTransformsOpen(true),
		},
		{
			count: ttsEntries.length,
			id: "tts" as const,
			label: t("kindTextToSpeech"),
			open: () => setConfirmTtsOpen(true),
		},
	];
	const historyKindOptions: SelectOption[] = historyKinds.map((kind) => ({
		id: kind.id,
		label: kind.label,
	}));
	const activeHistoryKind =
		historyKinds.find((kind) => kind.id === historyKind) ?? allHistoryKind;
	// Kind filter applied to the (already date-filtered) combined rows. "All"
	// passes everything through; the specific kinds map onto the row's `kind` tag.
	const visibleHistoryEntries =
		historyKind === "all"
			? search.items
			: search.items.filter((row) => {
					if (historyKind === "history") {
						return row.kind === "transcription";
					}
					if (historyKind === "transforms") {
						return row.kind === "transform";
					}
					return row.kind === "tts";
				});

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
					{/* One control: the shared Select filters the table by kind
					    (default "All") and names the target of the single Clear
					    button, which (wrapped in the app's connected group so it
					    reads as the standard segmented chip) acts on the selection. */}
					<HistorySearchInput
						count={search.totalLabelCount}
						hasMore={search.hasMore}
						onQueryChange={setQuery}
					/>
					<Select
						className="h-7 w-44"
						onChange={(v) =>
							setHistoryKind(v as "all" | "history" | "transforms" | "tts")
						}
						options={historyKindOptions}
						value={historyKind}
					/>
					<ButtonGroup connected>
						<Button
							className={CLEAR_ACTION_SEGMENT_CLASS}
							disabled={activeHistoryKind.count === 0}
							onClick={activeHistoryKind.open}
						>
							<HugeiconsIcon icon={Delete02Icon} size={14} />
							{t("clearConfirm")}
						</Button>
					</ButtonGroup>
				</div>
			}
			boxed
			icon={ListViewIcon}
			title={t("combinedTableTitle")}
		>
			<div className="flex flex-col gap-2 py-2">
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
					preserveOrder={Boolean(query.trim())}
				/>
			</div>
		</SettingSection>
	);
}
