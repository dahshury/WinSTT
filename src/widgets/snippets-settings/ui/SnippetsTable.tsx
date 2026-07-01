import type { ColumnDef } from "@tanstack/react-table";
import { useTranslations } from "use-intl";
import type { SnippetEntry } from "@/bindings";
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
			meta: { cell: { variant: "short-text" }, label: t("expansion") },
			minSize: 260,
		},
	];

	return (
		<EditableRecordsGrid
			columns={columns}
			createRow={newSnippet}
			data={entries}
			editableColumnIds={EDITABLE_COLUMNS}
			focusColumnId="trigger"
			isEmptyRow={isBlankSnippet}
			onChange={onChange}
		/>
	);
}
