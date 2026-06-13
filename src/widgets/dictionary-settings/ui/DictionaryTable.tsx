import {
	BookOpenTextIcon,
	PencilEdit01Icon,
	SparklesIcon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import {
	addDictionaryEntrySchema,
	type DictionaryEntry,
} from "@/shared/config/settings-schema";
import { Badge } from "@/shared/ui/badge";
import { CrudTable } from "@/shared/ui/crud-table";
import { dictionaryContainsTerm } from "../lib/dictionary-terms";

export interface DictionaryTableProps {
	entries: DictionaryEntry[];
	onAdd: (entry: Omit<DictionaryEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
	onRemoveMany?: (ids: string[]) => void;
	onUpdate?: (id: string, entry: Omit<DictionaryEntry, "id">) => void;
}

export function DictionaryTable({
	entries,
	onAdd,
	onRemove,
	onRemoveMany,
	onClearAll,
	onUpdate,
}: DictionaryTableProps) {
	const t = useTranslations("dictionary");
	const tc = useTranslations("common");
	const addSchema = addDictionaryEntrySchema.superRefine((entry, ctx) => {
		if (dictionaryContainsTerm(entries, entry.term)) {
			ctx.addIssue({
				code: "custom",
				message: "Already added",
				path: ["term"],
			});
		}
	});
	const updateSchema = (current: DictionaryEntry) =>
		addDictionaryEntrySchema.superRefine((entry, ctx) => {
			if (
				dictionaryContainsTerm(
					entries.filter((e) => e.id !== current.id),
					entry.term,
				)
			) {
				ctx.addIssue({
					code: "custom",
					message: "Already added",
					path: ["term"],
				});
			}
		});

	return (
		<CrudTable
			addFormLayout="joined"
			columnControls
			columns={[
				{
					cellClassName: "text-foreground",
					editFieldName: "term",
					header: t("term"),
					render: (e) => e.term,
				},
				{
					accessor: (e) =>
						e.autoAdded === true ? t("sourceAuto") : t("sourceManual"),
					header: t("source"),
					render: (e) =>
						e.autoAdded === true ? (
							<Badge
								className="border-accent/30 bg-accent/12 text-accent"
								variant="outline"
							>
								<HugeiconsIcon
									aria-hidden="true"
									icon={SparklesIcon}
									size={11}
								/>
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
					width: "w-28",
				},
			]}
			deleteLabelFor={(e) => e.term}
			emptyIcon={BookOpenTextIcon}
			entries={entries}
			fields={[
				{
					icon: TextIcon,
					label: t("term"),
					name: "term",
					placeholder: t("termPlaceholder"),
				},
			]}
			getId={(e) => e.id}
			labels={{
				add: tc("add"),
				cancel: tc("cancel"),
				clearDescription: t("clearDescription"),
				clearTitle: t("clearTitle"),
				delete: tc("delete"),
				deleteAll: tc("deleteAll"),
				edit: tc("edit"),
				emptyState: t("emptyState"),
				save: tc("save"),
			}}
			onAdd={onAdd}
			onRemove={onRemove}
			{...(onRemoveMany ? { onRemoveMany } : {})}
			pageSize={5}
			paginated
			schema={addSchema}
			searchable
			sortable
			{...(onClearAll ? { onClearAll } : {})}
			{...(onUpdate ? { onUpdate, updateSchema } : {})}
		/>
	);
}
