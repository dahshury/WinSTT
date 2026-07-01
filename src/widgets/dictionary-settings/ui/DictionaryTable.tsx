import { PencilEdit01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColumnDef } from "@tanstack/react-table";
import { useTranslations } from "use-intl";
import type { DictionaryEntry } from "@/shared/config/settings-schema";
import { generateId } from "@/shared/lib/generate-id";
import { Badge } from "@/shared/ui/badge";
import {
	EditableRecordsGrid,
	getDataGridSelectColumn,
	getFilterFn,
} from "@/shared/ui/data-grid";
import { normalizeDictionaryTerm } from "../lib/dictionary-terms";

const EDITABLE_COLUMNS = ["term"] as const;

const isBlankDictionaryEntry = (entry: DictionaryEntry): boolean =>
	entry.term.trim() === "";

const newDictionaryEntry = (): DictionaryEntry => ({
	id: generateId(),
	term: "",
});

const acceptDictionaryData = (newData: readonly DictionaryEntry[]) => {
	const seen = new Set<string>();
	for (const row of newData) {
		const key = normalizeDictionaryTerm(row.term);
		if (!key) continue;
		if (seen.has(key)) return false;
		seen.add(key);
	}
	return true;
};

export interface DictionaryTableProps {
	entries: DictionaryEntry[];
	onChange: (entries: DictionaryEntry[]) => void;
}

export function DictionaryTable({ entries, onChange }: DictionaryTableProps) {
	const t = useTranslations("dictionary");

	const filterFn = getFilterFn<DictionaryEntry>();
	const columns: ColumnDef<DictionaryEntry>[] = [
		getDataGridSelectColumn<DictionaryEntry>(),
		{
			accessorKey: "term",
			filterFn,
			header: t("term"),
			id: "term",
			meta: { cell: { variant: "short-text" }, label: t("term") },
			minSize: 220,
		},
		{
			// Function header → the grid renders this column via its own `cell`
			// (read-only), bypassing the editable cell-variant router.
			accessorFn: (row) =>
				row.autoAdded ? t("sourceAuto") : t("sourceManual"),
			cell: ({ row }) =>
				row.original.autoAdded ? (
					<Badge
						className="border-accent/30 bg-accent/12 text-accent"
						variant="outline"
					>
						<HugeiconsIcon aria-hidden="true" icon={SparklesIcon} size={11} />
						{t("sourceAuto")}
					</Badge>
				) : (
					<Badge variant="outline">
						<HugeiconsIcon
							aria-hidden="true"
							icon={PencilEdit01Icon}
							size={11}
						/>
						{t("sourceManual")}
					</Badge>
				),
			enableResizing: false,
			enableSorting: false,
			header: () => <span>{t("source")}</span>,
			id: "source",
			meta: { label: t("source") },
			size: 130,
		},
	];

	return (
		<EditableRecordsGrid
			acceptData={acceptDictionaryData}
			columns={columns}
			createRow={newDictionaryEntry}
			data={entries}
			editableColumnIds={EDITABLE_COLUMNS}
			focusColumnId="term"
			isEmptyRow={isBlankDictionaryEntry}
			onChange={onChange}
		/>
	);
}
