import { Form } from "@base-ui/react/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import {
	type AddDictionaryEntry,
	addDictionaryEntrySchema,
	type DictionaryEntry,
} from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { FormControl } from "@/shared/ui/form-control";
import {
	Table,
	TableBody,
	TableCell,
	TableEmpty,
	TableHead,
	TableHeader,
	TableRow,
} from "@/shared/ui/table";
import { TextField } from "@/shared/ui/text-field";
import { Tooltip } from "@/shared/ui/tooltip";

export interface DictionaryTableProps {
	entries: DictionaryEntry[];
	onAdd: (entry: Omit<DictionaryEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
}

export function DictionaryTable({ entries, onAdd, onRemove, onClearAll }: DictionaryTableProps) {
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const t = useTranslations("dictionary");
	const tc = useTranslations("common");
	const {
		register,
		handleSubmit,
		reset,
		watch,
		formState: { errors },
	} = useForm<AddDictionaryEntry>({
		resolver: zodResolver(addDictionaryEntrySchema),
		defaultValues: { term: "", replacement: "" },
	});

	const termValue = watch("term");

	const onSubmit = (data: AddDictionaryEntry) => {
		// Trim replacement and only pass it through when non-empty; the
		// matcher treats absent and empty-string identically (both mean
		// "vocab word, no replacement"), but persisting `""` would
		// pollute the store with noise so we drop it at the form edge.
		const replacement = data.replacement?.trim();
		onAdd({
			term: data.term.trim(),
			...(replacement ? { replacement } : {}),
		});
		reset();
	};

	const termReg = register("term");
	const replacementReg = register("replacement");
	const isAddDisabled = !termValue?.trim();

	return (
		<div className="flex flex-col gap-3">
			<Form className="flex items-end gap-2" onSubmit={handleSubmit(onSubmit)}>
				<div className="flex-1">
					<FormControl error={errors.term?.message} label={t("term")}>
						<TextField
							error={!!errors.term}
							name={termReg.name}
							onBlur={termReg.onBlur}
							onChange={termReg.onChange}
							placeholder={t("termPlaceholder")}
							ref={termReg.ref}
						/>
					</FormControl>
				</div>
				<div className="flex-1">
					<FormControl caption={t("replacementCaption")} label={t("replacement")}>
						<TextField
							name={replacementReg.name}
							onBlur={replacementReg.onBlur}
							onChange={replacementReg.onChange}
							placeholder={t("replacementPlaceholder")}
							ref={replacementReg.ref}
						/>
					</FormControl>
				</div>
				<Button
					className="mb-3 h-8 rounded-md bg-accent px-3 font-medium text-black text-body transition-colors duration-150 hover:bg-accent-hover"
					disabled={isAddDisabled}
					type="submit"
				>
					{tc("add")}
				</Button>
			</Form>
			<Table containerClassName="rounded border border-border bg-surface-tertiary overflow-hidden">
				<TableHeader>
					<TableRow>
						<TableHead>{t("term")}</TableHead>
						<TableHead>{t("replacement")}</TableHead>
						<TableHead className="w-10" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{entries.length === 0 ? (
						<TableEmpty colSpan={3}>{t("emptyState")}</TableEmpty>
					) : (
						entries.map((entry, idx) => (
							<TableRow index={idx} key={entry.id}>
								<TableCell className="text-foreground">{entry.term}</TableCell>
								<TableCell className="text-foreground-muted">{entry.replacement ?? "—"}</TableCell>
								<TableCell className="w-10 text-right">
									<Tooltip content={tc("delete")}>
										<Button
											aria-label={`${tc("delete")} "${entry.term}"`}
											className="rounded bg-transparent p-1 text-error transition-colors duration-150 hover:bg-error-dim"
											onClick={() => onRemove(entry.id)}
										>
											<HugeiconsIcon icon={Delete02Icon} size={14} />
										</Button>
									</Tooltip>
								</TableCell>
							</TableRow>
						))
					)}
				</TableBody>
			</Table>
			{onClearAll && (
				<>
					<ConfirmDialog
						description={t("clearDescription")}
						onConfirm={onClearAll}
						onOpenChange={setClearConfirmOpen}
						open={clearConfirmOpen}
						title={t("clearTitle")}
					/>
					<Button
						className="h-7 self-end rounded-md border border-error bg-transparent px-2.5 font-medium text-error text-xs transition-colors duration-150 hover:bg-error-dim"
						disabled={entries.length === 0}
						onClick={() => setClearConfirmOpen(true)}
					>
						{tc("deleteAll")}
					</Button>
				</>
			)}
		</div>
	);
}
