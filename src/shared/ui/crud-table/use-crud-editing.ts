import { useState } from "react";
import type { ZodType } from "zod";
import type { CrudField } from "./CrudTable";

interface UseCrudEditingArgs<TEntry, TAdd> {
	fields: CrudField[];
	schema: ZodType<TAdd>;
	getId: (entry: TEntry) => string;
	getEditValues?: ((entry: TEntry) => Record<string, string>) | undefined;
	onUpdate?: ((id: string, entry: TAdd) => void) | undefined;
	updateSchema?: ((entry: TEntry) => ZodType<TAdd>) | undefined;
}

export interface CrudEditingState<TEntry> {
	editingId: string | null;
	editValues: Record<string, string>;
	editErrors: Record<string, string>;
	setEditField: (name: string, value: string) => void;
	startEdit: (entry: TEntry) => void;
	cancelEdit: () => void;
	handleUpdate: (entry: TEntry) => void;
	isEditSaveDisabled: boolean;
}

/**
 * Inline-edit state for {@link CrudTable}: which row is open, its controlled
 * `{ field → value }` draft, per-field errors, and the save handler that runs
 * the (optionally row-aware) Zod schema and calls `onUpdate` on success. The
 * seed values come from `getEditValues` when supplied, otherwise from reading
 * the entry's field names. Extracted verbatim so the table shell stays thin.
 */
export function useCrudEditing<TEntry, TAdd>({
	fields,
	schema,
	getId,
	getEditValues,
	onUpdate,
	updateSchema,
}: UseCrudEditingArgs<TEntry, TAdd>): CrudEditingState<TEntry> {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValues, setEditValues] = useState<Record<string, string>>({});
	const [editErrors, setEditErrors] = useState<Record<string, string>>({});

	const setEditField = (name: string, value: string): void => {
		setEditValues((prev) => ({ ...prev, [name]: value }));
		if (editErrors[name]) {
			setEditErrors((prev) => {
				const { [name]: _omit, ...rest } = prev;
				return rest;
			});
		}
	};

	const buildDraft = (
		source: Record<string, string>,
	): Record<string, string> => {
		const draft: Record<string, string> = {};
		for (const f of fields) {
			draft[f.name] = source[f.name] ?? "";
		}
		return draft;
	};

	const buildDefaultEditValues = (entry: TEntry): Record<string, string> => {
		const entryRecord = entry as Record<string, unknown>;
		const draft: Record<string, string> = {};
		for (const f of fields) {
			const raw = entryRecord[f.name];
			draft[f.name] = typeof raw === "string" ? raw : "";
		}
		return draft;
	};

	const startEdit = (entry: TEntry): void => {
		const seed = getEditValues?.(entry) ?? buildDefaultEditValues(entry);
		const next: Record<string, string> = {};
		for (const f of fields) {
			next[f.name] = seed[f.name] ?? "";
		}
		setEditingId(getId(entry));
		setEditValues(next);
		setEditErrors({});
	};

	const cancelEdit = (): void => {
		setEditingId(null);
		setEditValues({});
		setEditErrors({});
	};

	const handleUpdate = (entry: TEntry): void => {
		if (!onUpdate) {
			return;
		}
		const draft = buildDraft(editValues);
		const result = (updateSchema?.(entry) ?? schema).safeParse(draft);
		if (!result.success) {
			const next: Record<string, string> = {};
			for (const issue of result.error.issues) {
				const key = issue.path[0];
				if (typeof key === "string" && !next[key]) {
					next[key] = issue.message;
				}
			}
			setEditErrors(next);
			return;
		}
		onUpdate(getId(entry), result.data);
		cancelEdit();
	};

	const isEditSaveDisabled = !fields.every(
		(f) => (editValues[f.name] ?? "").trim().length > 0,
	);

	return {
		editingId,
		editValues,
		editErrors,
		setEditField,
		startEdit,
		cancelEdit,
		handleUpdate,
		isEditSaveDisabled,
	};
}
