import { Form } from "@base-ui/react/form";
import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, type ReactNode, useState } from "react";
import type { ZodType } from "zod";
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

/** One field in the add-entry form. The Add button rides in the LAST field. */
export interface CrudField {
	icon: IconSvgElement;
	name: string;
	placeholder: string;
	label: string;
	/** Width class for the field wrapper in a multi-field row (e.g. "w-1/3", "flex-1"). */
	width?: string;
}

/** One column in the entry table (the trailing delete column is automatic). */
export interface CrudColumn<TEntry> {
	header: string;
	render: (entry: TEntry) => ReactNode;
	/** Width class applied to both the header and cells (e.g. "w-1/3"). */
	width?: string;
	/** Extra classes for the data cells. */
	cellClassName?: string;
}

export interface CrudTableLabels {
	add: string;
	clearDescription: string;
	clearTitle: string;
	delete: string;
	deleteAll: string;
	emptyState: string;
	/** Optional confirm-button label for the clear-all dialog. */
	clearConfirm?: string;
}

export interface CrudTableProps<TEntry, TAdd> {
	columns: CrudColumn<TEntry>[];
	/** Value shown in each row's delete aria-label: `${delete} "${value}"`. */
	deleteLabelFor: (entry: TEntry) => string;
	entries: TEntry[];
	fields: CrudField[];
	getId: (entry: TEntry) => string;
	labels: CrudTableLabels;
	onAdd: (entry: TAdd) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
	/** Validates the assembled `{ [field.name]: value }` map; its output is passed to `onAdd`. */
	schema: ZodType<TAdd>;
}

/**
 * A scrollable add/list/delete table — the shared engine behind the Dictionary
 * and Snippets settings tables (and any future "manage a small list" control).
 * Caller supplies the entry columns, the add-form fields, a Zod schema for the
 * add row, and the CRUD callbacks; everything else (the add field-group with its
 * inline Add button, the scroll frame, per-row delete, the empty state, and the
 * guarded clear-all) is identical across consumers and lives here once.
 */
export function CrudTable<TEntry, TAdd>({
	columns,
	deleteLabelFor,
	entries,
	fields,
	getId,
	labels,
	onAdd,
	onClearAll,
	onRemove,
	schema,
}: CrudTableProps<TEntry, TAdd>) {
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [values, setValues] = useState<Record<string, string>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});

	const setField = (name: string, value: string): void => {
		setValues((prev) => ({ ...prev, [name]: value }));
		if (errors[name]) {
			setErrors((prev) => {
				const { [name]: _omit, ...rest } = prev;
				return rest;
			});
		}
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		const draft: Record<string, string> = {};
		for (const f of fields) {
			draft[f.name] = values[f.name] ?? "";
		}
		const result = schema.safeParse(draft);
		if (!result.success) {
			const next: Record<string, string> = {};
			for (const issue of result.error.issues) {
				const key = issue.path[0];
				if (typeof key === "string" && !next[key]) {
					next[key] = issue.message;
				}
			}
			setErrors(next);
			return;
		}
		// The Zod schema applies .trim() during validation — no manual trimming.
		onAdd(result.data);
		setValues({});
		setErrors({});
	};

	const isAddDisabled = !fields.every((f) => (values[f.name] ?? "").trim().length > 0);
	const colSpan = columns.length + 1;

	return (
		<div className="flex flex-col gap-3">
			{/* Add-an-entry row: each field sits in its own input-group; the Add
			    button lives in the trailing slot of the LAST field so the
			    field(s) + their action read as one control (the fluidfunctionalism
			    input-group recipe). */}
			<Form
				className={fields.length > 1 ? "flex items-end gap-2" : undefined}
				onSubmit={handleSubmit}
			>
				{fields.map((field, i) => {
					const isLast = i === fields.length - 1;
					const error = errors[field.name];
					const inputGroup = (
						<FormControl error={error} label={field.label}>
							<InputGroup
								appearance="elevated"
								className="h-9"
								size="sm"
								tone={error ? "danger" : "default"}
							>
								<InputGroupAddon align="inline-start">
									<HugeiconsIcon aria-hidden="true" icon={field.icon} size={14} />
								</InputGroupAddon>
								<InputGroupInput
									aria-invalid={!!error}
									name={field.name}
									onChange={(event) => setField(field.name, event.target.value)}
									placeholder={field.placeholder}
									value={values[field.name] ?? ""}
								/>
								{isLast ? (
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											aria-label={labels.add}
											disabled={isAddDisabled}
											tone="surface"
											type="submit"
										>
											<HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={2.25} />
										</InputGroupButton>
									</InputGroupAddon>
								) : null}
							</InputGroup>
						</FormControl>
					);
					return fields.length > 1 ? (
						<div className={field.width} key={field.name}>
							{inputGroup}
						</div>
					) : (
						<div key={field.name}>{inputGroup}</div>
					);
				})}
			</Form>
			{/* Scroll lives on this OUTER frame so the Table's inner proximity-hover
			    container scrolls as one unit within it and the row-hover backdrop
			    stays aligned. The border/rounding moves here too so the frame stays
			    put while the rows scroll. */}
			<div
				className="overflow-y-auto overscroll-contain rounded border border-border"
				style={{ maxHeight: TABLE_MAX_HEIGHT_PX }}
			>
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							{columns.map((col) => (
								<TableHead className={col.width} key={col.header}>
									{col.header}
								</TableHead>
							))}
							<TableHead className="w-10" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{entries.length === 0 ? (
							<TableEmpty colSpan={colSpan}>{labels.emptyState}</TableEmpty>
						) : (
							entries.map((entry, idx) => {
								const id = getId(entry);
								return (
									<TableRow index={idx} key={id}>
										{columns.map((col) => (
											<TableCell
												className={`break-words${col.width ? ` ${col.width}` : ""}${col.cellClassName ? ` ${col.cellClassName}` : ""}`}
												key={col.header}
											>
												{col.render(entry)}
											</TableCell>
										))}
										<TableCell className="w-10 text-right">
											<Tooltip content={labels.delete}>
												<Button
													aria-label={`${labels.delete} "${deleteLabelFor(entry)}"`}
													className="rounded bg-transparent p-1 text-error transition-colors duration-150 hover:bg-error-dim"
													onClick={() => onRemove(id)}
												>
													<HugeiconsIcon icon={Delete02Icon} size={14} />
												</Button>
											</Tooltip>
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</div>
			{onClearAll && (
				<>
					<ConfirmDialog
						description={labels.clearDescription}
						onConfirm={onClearAll}
						onOpenChange={setClearConfirmOpen}
						open={clearConfirmOpen}
						title={labels.clearTitle}
						{...(labels.clearConfirm ? { confirmLabel: labels.clearConfirm } : {})}
					/>
					<Button
						className="h-7 gap-1.5 self-end rounded-md bg-error-dim/40 px-2.5 font-medium text-error text-xs ring-1 ring-error/25 transition-colors duration-150 hover:bg-error-dim/70 hover:ring-error/40 disabled:opacity-50"
						disabled={entries.length === 0}
						onClick={() => setClearConfirmOpen(true)}
					>
						<HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={14} />
						{labels.deleteAll}
					</Button>
				</>
			)}
		</div>
	);
}
