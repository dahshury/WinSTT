"use client";

import { Form } from "@base-ui/react/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { components } from "@spec/schema";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { type AddDictionaryEntry, addDictionaryEntrySchema } from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { FormControl } from "@/shared/ui/form-control";
import { TextField } from "@/shared/ui/text-field";
import { Tooltip } from "@/shared/ui/tooltip";

type DictionaryEntry = components["schemas"]["DictionaryEntry"];

export interface DictionaryTableProps {
	entries: DictionaryEntry[];
	onAdd: (entry: Omit<DictionaryEntry, "id">) => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, entry: Partial<DictionaryEntry>) => void;
	onClearAll?: () => void;
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
		defaultValues: { find: "", replace: "", caseSensitive: false, wholeWord: false },
	});

	const findValue = watch("find");
	const replaceValue = watch("replace");

	const onSubmit = (data: AddDictionaryEntry) => {
		// Zod schema applies .trim() during validation, no manual trimming needed
		onAdd(data);
		reset();
	};

	const findReg = register("find");
	const replaceReg = register("replace");
	const isAddDisabled = !(findValue?.trim() && replaceValue?.trim());

	return (
		<div className="flex flex-col gap-3">
			<Form className="flex items-end gap-2" onSubmit={handleSubmit(onSubmit)}>
				<div className="flex-1">
					<FormControl error={errors.find?.message} label={t("find")}>
						<TextField
							error={!!errors.find}
							name={findReg.name}
							onBlur={findReg.onBlur}
							onChange={findReg.onChange}
							placeholder={t("findPlaceholder")}
							ref={findReg.ref}
						/>
					</FormControl>
				</div>
				<div className="flex-1">
					<FormControl error={errors.replace?.message} label={t("replace")}>
						<TextField
							error={!!errors.replace}
							name={replaceReg.name}
							onBlur={replaceReg.onBlur}
							onChange={replaceReg.onChange}
							placeholder={t("replacePlaceholder")}
							ref={replaceReg.ref}
						/>
					</FormControl>
				</div>
				<Button
					className="h-8 rounded-md bg-accent px-3 font-medium text-black text-body transition-colors duration-150 hover:bg-accent-hover"
					disabled={isAddDisabled}
					type="submit"
				>
					{tc("add")}
				</Button>
			</Form>
			<div className="flex flex-col gap-1">
				{entries.map((entry) => (
					<div
						className="flex items-center justify-between rounded border border-border bg-surface-tertiary px-3 py-2 text-body"
						key={entry.id}
					>
						<span>
							<span className="text-foreground-secondary">{entry.find}</span>
							<span className="text-foreground-muted">{" → "}</span>
							<span className="text-foreground">{entry.replace}</span>
						</span>
						<Tooltip content={tc("delete")}>
							<Button
								aria-label={`${tc("delete")} "${entry.find}"`}
								className="rounded bg-transparent p-1 text-error transition-colors duration-150 hover:bg-error-dim"
								onClick={() => onRemove(entry.id)}
							>
								<HugeiconsIcon icon={Delete02Icon} size={14} />
							</Button>
						</Tooltip>
					</div>
				))}
				{entries.length === 0 && (
					<p className="py-4 text-center text-body text-foreground-muted">{t("emptyState")}</p>
				)}
			</div>
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
