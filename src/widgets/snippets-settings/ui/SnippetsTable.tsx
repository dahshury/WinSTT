import type { ColumnDef } from "@tanstack/react-table";
import { useTranslations } from "use-intl";
import type { SnippetEntry } from "@/bindings";
import {
	fitsRustShortText,
	fitsRustText,
	VOCABULARY_LIMITS,
} from "@/shared/config/vocabulary-limits";
import { generateId } from "@/shared/lib/generate-id";
import {
	EditableRecordsGrid,
	getDataGridSelectColumn,
	getFilterFn,
} from "@/shared/ui/data-grid";

const EDITABLE_COLUMNS = ["trigger", "expansion"] as const;

const isBlankSnippet = (entry: SnippetEntry): boolean =>
	entry.trigger.trim() === "" && entry.expansion.trim() === "";

export interface SnippetsTableProps {
	entries: SnippetEntry[];
	onChange: (entries: SnippetEntry[]) => void;
}

function newSnippet(): SnippetEntry {
	return { expansion: "", id: generateId(), trigger: "" };
}

function acceptSnippetData(newData: readonly SnippetEntry[]): boolean {
	return (
		newData.length <= VOCABULARY_LIMITS.snippets &&
		newData.every(
			(entry) =>
				fitsRustShortText(entry.id, VOCABULARY_LIMITS.idBytes) &&
				fitsRustShortText(
					entry.trigger,
					VOCABULARY_LIMITS.termOrTriggerBytes,
				) &&
				fitsRustText(entry.expansion, VOCABULARY_LIMITS.snippetExpansionBytes),
		)
	);
}

export function SnippetsTable({ entries, onChange }: SnippetsTableProps) {
	const t = useTranslations("snippets");

	const filterFn = getFilterFn<SnippetEntry>();
	const columns: ColumnDef<SnippetEntry>[] = [
		getDataGridSelectColumn<SnippetEntry>(),
		{
			accessorKey: "trigger",
			filterFn,
			header: t("trigger"),
			id: "trigger",
			meta: { cell: { variant: "short-text" }, label: t("trigger") },
			minSize: 180,
		},
		{
			accessorKey: "expansion",
			filterFn,
			header: t("expansion"),
			id: "expansion",
			meta: { cell: { variant: "long-text" }, label: t("expansion") },
			minSize: 260,
		},
	];

	return (
		<EditableRecordsGrid
			acceptData={acceptSnippetData}
			columns={columns}
			createRow={newSnippet}
			data={entries}
			editableColumnIds={EDITABLE_COLUMNS}
			focusColumnId="trigger"
			isEmptyRow={isBlankSnippet}
			maxRows={VOCABULARY_LIMITS.snippets}
			onChange={onChange}
		/>
	);
}
