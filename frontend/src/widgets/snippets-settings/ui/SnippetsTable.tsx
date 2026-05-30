import { Form } from "@base-ui/react/form";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { components } from "@spec/schema";
import { type FormEvent, useState } from "react";
import { useTranslations } from "use-intl";
import { addSnippetEntrySchema } from "@/shared/config/settings-schema";
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

// Cap the entry list so it scrolls inside its own frame rather than growing
// without bound and pushing the rest of the panel off the fixed-height
// settings window (700×560). Picked to keep the table comfortably within the
// page — ~7 rows visible before the scrollbar engages.
const TABLE_MAX_HEIGHT_PX = 280;

export interface SnippetsTableProps {
	entries: SnippetEntry[];
	onAdd: (entry: Omit<SnippetEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
}

interface FieldErrors {
	expansion?: string;
	trigger?: string;
}

export function SnippetsTable({ entries, onAdd, onRemove, onClearAll }: SnippetsTableProps) {
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [trigger, setTrigger] = useState("");
	const [expansion, setExpansion] = useState("");
	const [errors, setErrors] = useState<FieldErrors>({});
	const t = useTranslations("snippets");
	const tc = useTranslations("common");

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const result = addSnippetEntrySchema.safeParse({ trigger, expansion });
		if (!result.success) {
			const fieldErrors: FieldErrors = {};
			for (const issue of result.error.issues) {
				const key = issue.path[0];
				if ((key === "trigger" || key === "expansion") && !fieldErrors[key]) {
					fieldErrors[key] = issue.message;
				}
			}
			setErrors(fieldErrors);
			return;
		}
		// Zod schema applies .trim() during validation, no manual trimming needed
		onAdd(result.data);
		setTrigger("");
		setExpansion("");
		setErrors({});
	};

	const isAddDisabled = !(trigger.trim() && expansion.trim());

	return (
		<div className="flex flex-col gap-3">
			<Form className="flex items-end gap-2" onSubmit={handleSubmit}>
				<div className="w-1/3">
					<FormControl error={errors.trigger} label={t("trigger")}>
						<TextField
							error={!!errors.trigger}
							name="trigger"
							onChange={(event) => {
								setTrigger(event.target.value);
								if (errors.trigger) {
									setErrors((prev) => {
										const { trigger: _trigger, ...rest } = prev;
										return rest;
									});
								}
							}}
							placeholder={t("triggerPlaceholder")}
							value={trigger}
						/>
					</FormControl>
				</div>
				<div className="flex-1">
					<FormControl error={errors.expansion} label={t("expansion")}>
						<TextField
							error={!!errors.expansion}
							name="expansion"
							onChange={(event) => {
								setExpansion(event.target.value);
								if (errors.expansion) {
									setErrors((prev) => {
										const { expansion: _expansion, ...rest } = prev;
										return rest;
									});
								}
							}}
							placeholder={t("expansionPlaceholder")}
							value={expansion}
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
			{/* Scroll lives on this OUTER frame so the Table's inner
			    proximity-hover container scrolls as one unit within it and the
			    row-hover backdrop stays aligned. The border/rounding moves here
			    too so the frame stays put while the rows scroll. */}
			<div
				className="overflow-y-auto overscroll-contain rounded border border-border"
				style={{ maxHeight: TABLE_MAX_HEIGHT_PX }}
			>
				<Table className="table-fixed">
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
									<TableCell className="w-1/3 break-words text-purple">{entry.trigger}</TableCell>
									<TableCell className="break-words text-foreground">{entry.expansion}</TableCell>
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
