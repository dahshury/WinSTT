import { Form } from "@base-ui/react/form";
import { Delete02Icon, PlusSignIcon, TextIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, useState } from "react";
import { useTranslations } from "use-intl";
import { addDictionaryEntrySchema, type DictionaryEntry } from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { FormControl } from "@/shared/ui/form-control";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/shared/ui/input-group";
import {
	Table,
	TableBody,
	TableCell,
	TableEmpty,
	TableHead,
	TableHeader,
	TableRow,
} from "@/shared/ui/table";
import { Tooltip } from "@/shared/ui/tooltip";

// Cap the entry list so it scrolls inside its own frame rather than growing
// without bound and pushing the rest of the panel off the fixed-height
// settings window (700×560). Picked to keep the table comfortably within the
// page — ~7 rows visible before the scrollbar engages.
const TABLE_MAX_HEIGHT_PX = 280;

export interface DictionaryTableProps {
	entries: DictionaryEntry[];
	onAdd: (entry: Omit<DictionaryEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
}

export function DictionaryTable({ entries, onAdd, onRemove, onClearAll }: DictionaryTableProps) {
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [term, setTerm] = useState("");
	const [termError, setTermError] = useState<string | undefined>(undefined);
	const t = useTranslations("dictionary");
	const tc = useTranslations("common");

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const result = addDictionaryEntrySchema.safeParse({ term });
		if (!result.success) {
			setTermError(result.error.issues[0]?.message ?? "Required");
			return;
		}
		onAdd({ term: result.data.term });
		setTerm("");
		setTermError(undefined);
	};

	const isAddDisabled = !term.trim();

	return (
		<div className="flex flex-col gap-3">
			{/* Add-a-term row: the term lives in an input-group whose trailing
			    slot holds the Add button, so the field + its action read as one
			    control (the fluidfunctionalism input-group recipe). */}
			<Form onSubmit={handleSubmit}>
				<FormControl error={termError} label={t("term")}>
					<InputGroup
						appearance="minimal"
						className="h-9"
						size="sm"
						tone={termError ? "danger" : "default"}
					>
						<InputGroupAddon align="inline-start">
							<HugeiconsIcon aria-hidden="true" icon={TextIcon} size={14} />
						</InputGroupAddon>
						<InputGroupInput
							aria-invalid={!!termError}
							name="term"
							onChange={(event) => {
								setTerm(event.target.value);
								if (termError) {
									setTermError(undefined);
								}
							}}
							placeholder={t("termPlaceholder")}
							value={term}
						/>
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								aria-label={tc("add")}
								disabled={isAddDisabled}
								tone="ghost"
								type="submit"
							>
								<HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={2.25} />
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>
				</FormControl>
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
							<TableHead>{t("term")}</TableHead>
							<TableHead className="w-10" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{entries.length === 0 ? (
							<TableEmpty colSpan={2}>{t("emptyState")}</TableEmpty>
						) : (
							entries.map((entry, idx) => (
								<TableRow index={idx} key={entry.id}>
									<TableCell className="break-words text-foreground">{entry.term}</TableCell>
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
						className="h-7 gap-1.5 self-end rounded-md bg-error px-2.5 font-medium text-white text-xs transition-colors duration-150 hover:bg-error/90"
						disabled={entries.length === 0}
						onClick={() => setClearConfirmOpen(true)}
					>
						<HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={14} />
						{tc("deleteAll")}
					</Button>
				</>
			)}
		</div>
	);
}
