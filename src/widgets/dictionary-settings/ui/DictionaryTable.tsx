import { TextIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { addDictionaryEntrySchema, type DictionaryEntry } from "@/shared/config/settings-schema";
import { CrudTable } from "@/shared/ui/crud-table";

export interface DictionaryTableProps {
	entries: DictionaryEntry[];
	onAdd: (entry: Omit<DictionaryEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
}

export function DictionaryTable({ entries, onAdd, onRemove, onClearAll }: DictionaryTableProps) {
	const t = useTranslations("dictionary");
	const tc = useTranslations("common");
	return (
		<CrudTable
			columns={[{ cellClassName: "text-foreground", header: t("term"), render: (e) => e.term }]}
			deleteLabelFor={(e) => e.term}
			entries={entries}
			fields={[
				{ icon: TextIcon, label: t("term"), name: "term", placeholder: t("termPlaceholder") },
			]}
			getId={(e) => e.id}
			labels={{
				add: tc("add"),
				clearDescription: t("clearDescription"),
				clearTitle: t("clearTitle"),
				delete: tc("delete"),
				deleteAll: tc("deleteAll"),
				emptyState: t("emptyState"),
			}}
			onAdd={onAdd}
			onRemove={onRemove}
			schema={addDictionaryEntrySchema}
			{...(onClearAll ? { onClearAll } : {})}
		/>
	);
}
