import { Form } from "@base-ui/react/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { components } from "@spec/schema";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslations } from "use-intl";
import { type AddSnippetEntry, addSnippetEntrySchema } from "@/shared/config/settings-schema";
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

type SnippetEntry = components["schemas"]["SnippetEntry"];

export interface SnippetsTableProps {
	entries: SnippetEntry[];
	onAdd: (entry: Omit<SnippetEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
}

export function SnippetsTable({ entries, onAdd, onRemove, onClearAll }: SnippetsTableProps) {
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const t = useTranslations("snippets");
	const tc = useTranslations("common");
	const {
		register,
		handleSubmit,
		reset,
		watch,
		formState: { errors },
	} = useForm<AddSnippetEntry>({
		resolver: zodResolver(addSnippetEntrySchema),
		defaultValues: { trigger: "", expansion: "" },
	});

	const triggerValue = watch("trigger");
	const expansionValue = watch("expansion");

	const onSubmit = (data: AddSnippetEntry) => {
		// Zod schema applies .trim() during validation, no manual trimming needed
		onAdd(data);
		reset();
	};

	const triggerReg = register("trigger");
	const expansionReg = register("expansion");
	const isAddDisabled = !(triggerValue?.trim() && expansionValue?.trim());

	return (
		<div className="flex flex-col gap-3">
			<Form className="flex items-end gap-2" onSubmit={handleSubmit(onSubmit)}>
				<div className="w-1/3">
					<FormControl error={errors.trigger?.message} label={t("trigger")}>
						<TextField
							error={!!errors.trigger}
							name={triggerReg.name}
							onBlur={triggerReg.onBlur}
							onChange={triggerReg.onChange}
							placeholder={t("triggerPlaceholder")}
							ref={triggerReg.ref}
						/>
					</FormControl>
				</div>
				<div className="flex-1">
					<FormControl error={errors.expansion?.message} label={t("expansion")}>
						<TextField
							error={!!errors.expansion}
							name={expansionReg.name}
							onBlur={expansionReg.onBlur}
							onChange={expansionReg.onChange}
							placeholder={t("expansionPlaceholder")}
							ref={expansionReg.ref}
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
						<TableHead className="w-1/3">{t("trigger")}</TableHead>
						<TableHead>{t("expansion")}</TableHead>
						<TableHead className="w-10" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{entries.length === 0 ? (
						<TableEmpty colSpan={3}>{t("emptyState")}</TableEmpty>
					) : (
						entries.map((entry, idx) => (
							<TableRow index={idx} key={entry.id}>
								<TableCell className="w-1/3 text-purple">{entry.trigger}</TableCell>
								<TableCell className="text-foreground">{entry.expansion}</TableCell>
								<TableCell className="w-10 text-right">
									<Tooltip content={tc("delete")}>
										<Button
											aria-label={`${tc("delete")} "${entry.trigger}"`}
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
