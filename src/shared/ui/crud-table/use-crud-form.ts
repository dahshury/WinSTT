import { type FormEvent, useId, useState } from "react";
import type { ZodType } from "zod";
import type { CrudField } from "./types";

interface UseCrudFormArgs<TAdd> {
	fields: CrudField[];
	schema: ZodType<TAdd>;
	onAdd: (entry: TAdd) => void;
}

export interface CrudFormState {
	values: Record<string, string>;
	errors: Record<string, string>;
	setField: (name: string, value: string) => void;
	handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
	isAddDisabled: boolean;
	hasAddErrors: boolean;
	addFieldErrorId: (fieldName: string) => string;
}

/**
 * Add-entry form state for {@link CrudTable}: the controlled `{ field → value }`
 * draft, per-field validation errors, and the submit handler that runs the Zod
 * schema and calls `onAdd` on success. The Zod schema applies `.trim()` during
 * validation, so the handler never trims manually. Extracted verbatim so the
 * table shell stays a thin composition root.
 */
export function useCrudForm<TAdd>({
	fields,
	schema,
	onAdd,
}: UseCrudFormArgs<TAdd>): CrudFormState {
	const addErrorIdPrefix = useId();
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

	const buildDraft = (
		source: Record<string, string>,
	): Record<string, string> => {
		const draft: Record<string, string> = {};
		for (const f of fields) {
			draft[f.name] = source[f.name] ?? "";
		}
		return draft;
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		const draft = buildDraft(values);
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

	const isAddDisabled = !fields.every(
		(f) => (values[f.name] ?? "").trim().length > 0,
	);
	const addFieldErrorId = (fieldName: string): string =>
		`${addErrorIdPrefix}-${fieldName}-error`;
	const hasAddErrors = fields.some((field) => !!errors[field.name]);

	return {
		values,
		errors,
		setField,
		handleSubmit,
		isAddDisabled,
		hasAddErrors,
		addFieldErrorId,
	};
}
