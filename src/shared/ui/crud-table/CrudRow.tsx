import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/shared/ui/input-group";
import type { CrudColumn, CrudField } from "./types";

interface CrudEditableCellProps<TEntry> {
	col: CrudColumn<TEntry>;
	entry: TEntry;
	editingId: string | null;
	editValues: Record<string, string>;
	editErrors: Record<string, string>;
	fields: CrudField[];
	getId: (entry: TEntry) => string;
	setEditField: (name: string, value: string) => void;
	startEdit: (entry: TEntry) => void;
	handleUpdate: (entry: TEntry) => void;
	cancelEdit: () => void;
}

/**
 * Inline-edit cell: editable cells enter edit mode on double-click (or Enter/F2
 * while focused), then Enter saves and Escape cancels. Sorting reads the
 * committed value, so a row never jumps while it is being typed in.
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
	startEdit,
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
					onKeyDownCapture={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							handleUpdate(entry);
						}
						if (event.key === "Escape") {
							event.preventDefault();
							cancelEdit();
						}
					}}
					size="sm"
					tone={error ? "danger" : "default"}
				>
					<InputGroupAddon align="inline-start">
						<HugeiconsIcon aria-hidden="true" icon={editField.icon} size={14} />
					</InputGroupAddon>
					<InputGroupInput
						aria-invalid={!!error}
						aria-label={editField.label}
						defaultValue={editValues[editField.name] ?? ""}
						name={editField.name}
						onChange={(event) =>
							setEditField(editField.name, event.target.value)
						}
						placeholder={editField.placeholder}
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

	if (!editField) {
		return col.render(entry);
	}

	return (
		<button
			className="block min-w-0 max-w-full rounded-xs bg-transparent p-0 text-left text-inherit outline-none focus-visible:ring-2 focus-visible:ring-accent"
			onDoubleClick={() => startEdit(entry)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === "F2") {
					event.preventDefault();
					startEdit(entry);
				}
			}}
			type="button"
		>
			{col.render(entry)}
		</button>
	);
}
