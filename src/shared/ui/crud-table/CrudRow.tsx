import {
	Cancel01Icon,
	CheckIcon,
	Delete02Icon,
	Edit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Button } from "@/shared/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/shared/ui/input-group";
import { Tooltip } from "@/shared/ui/tooltip";
import type { CrudColumn, CrudField, CrudTableLabels } from "./CrudTable";

interface CrudEditableCellProps<TEntry> {
	col: CrudColumn<TEntry>;
	entry: TEntry;
	editingId: string | null;
	editValues: Record<string, string>;
	editErrors: Record<string, string>;
	fields: CrudField[];
	getId: (entry: TEntry) => string;
	setEditField: (name: string, value: string) => void;
	handleUpdate: (entry: TEntry) => void;
	cancelEdit: () => void;
}

/**
 * Inline-edit cell: when this row is being edited and the column maps to a
 * field, swap the value for an editable input (+ inline error); otherwise
 * render the column's normal content. Sorting reads the committed value (the
 * column accessor), so a row never jumps while it's being typed in.
 */
export function CrudEditableCell<TEntry>({
	col,
	entry,
	editingId,
	editValues,
	editErrors,
	fields,
	getId,
	setEditField,
	handleUpdate,
	cancelEdit,
}: CrudEditableCellProps<TEntry>): ReactNode {
	const editField = col.editFieldName
		? fields.find((field) => field.name === col.editFieldName)
		: undefined;
	if (editingId === getId(entry) && editField) {
		const error = editErrors[editField.name];
		return (
			<div className="flex flex-col gap-1">
				<InputGroup
					appearance="minimal"
					className="h-8"
					size="sm"
					tone={error ? "danger" : "default"}
				>
					<InputGroupAddon align="inline-start">
						<HugeiconsIcon aria-hidden="true" icon={editField.icon} size={14} />
					</InputGroupAddon>
					<InputGroupInput
						aria-invalid={!!error}
						aria-label={editField.label}
						name={editField.name}
						onChange={(event) =>
							setEditField(editField.name, event.target.value)
						}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								handleUpdate(entry);
							}
							if (event.key === "Escape") {
								event.preventDefault();
								cancelEdit();
							}
						}}
						placeholder={editField.placeholder}
						value={editValues[editField.name] ?? ""}
					/>
				</InputGroup>
				{error ? (
					<div
						aria-live="assertive"
						className="text-error text-xs-tight leading-[14px]"
						role="alert"
					>
						{error}
					</div>
				) : null}
			</div>
		);
	}
	return col.render(entry);
}

interface CrudRowActionsProps<TEntry> {
	entry: TEntry;
	editingId: string | null;
	getId: (entry: TEntry) => string;
	labels: CrudTableLabels;
	deleteLabelFor: (entry: TEntry) => string;
	isEditSaveDisabled: boolean;
	onUpdate?: ((id: string, entry: never) => void) | undefined;
	onRemove: (id: string) => void;
	startEdit: (entry: TEntry) => void;
	cancelEdit: () => void;
	handleUpdate: (entry: TEntry) => void;
}

/**
 * Trailing per-row controls: edit/delete normally, save/cancel while editing.
 */
export function CrudRowActions<TEntry>({
	entry,
	editingId,
	getId,
	labels,
	deleteLabelFor,
	isEditSaveDisabled,
	onUpdate,
	onRemove,
	startEdit,
	cancelEdit,
	handleUpdate,
}: CrudRowActionsProps<TEntry>): ReactNode {
	const id = getId(entry);
	const isEditing = editingId === id;
	return (
		<div className="flex justify-end gap-1">
			{isEditing ? (
				<>
					<Tooltip content={labels.save}>
						<Button
							aria-label={`${labels.save} "${deleteLabelFor(entry)}"`}
							className="rounded bg-transparent p-1 text-success transition-colors duration-150 hover:bg-success-dim"
							disabled={isEditSaveDisabled}
							onClick={() => handleUpdate(entry)}
						>
							<HugeiconsIcon icon={CheckIcon} size={14} />
						</Button>
					</Tooltip>
					<Tooltip content={labels.cancel}>
						<Button
							aria-label={`${labels.cancel} "${deleteLabelFor(entry)}"`}
							className="rounded bg-transparent p-1 text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground"
							onClick={cancelEdit}
						>
							<HugeiconsIcon icon={Cancel01Icon} size={14} />
						</Button>
					</Tooltip>
				</>
			) : (
				<>
					{onUpdate ? (
						<Tooltip content={labels.edit}>
							<Button
								aria-label={`${labels.edit} "${deleteLabelFor(entry)}"`}
								className="rounded bg-transparent p-1 text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground"
								onClick={() => startEdit(entry)}
							>
								<HugeiconsIcon icon={Edit02Icon} size={14} />
							</Button>
						</Tooltip>
					) : null}
					<Tooltip content={labels.delete}>
						<Button
							aria-label={`${labels.delete} "${deleteLabelFor(entry)}"`}
							className="rounded bg-transparent p-1 text-error transition-colors duration-150 hover:bg-error-dim"
							onClick={() => onRemove(id)}
						>
							<HugeiconsIcon icon={Delete02Icon} size={14} />
						</Button>
					</Tooltip>
				</>
			)}
		</div>
	);
}
