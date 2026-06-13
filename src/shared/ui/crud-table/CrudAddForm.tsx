import { Form } from "@base-ui/react/form";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FormEvent, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { ButtonGroup } from "@/shared/ui/button-group";
import { FormControl } from "@/shared/ui/form-control";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/shared/ui/input-group";
import type { CrudField, CrudTableLabels } from "./types";

interface CrudAddFormProps {
	addFormLayout: "separate" | "joined";
	fields: CrudField[];
	labels: CrudTableLabels;
	values: Record<string, string>;
	errors: Record<string, string>;
	isAddDisabled: boolean;
	hasAddErrors: boolean;
	addFieldErrorId: (fieldName: string) => string;
	setField: (name: string, value: string) => void;
	handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/**
 * Add-an-entry row: each field sits in its own input-group; the Add button
 * lives in the trailing slot of the LAST field so the field(s) + their action
 * read as one control (the fluidfunctionalism input-group recipe). The `joined`
 * layout connects the input groups into one toolbar via {@link ButtonGroup}.
 */
export function CrudAddForm({
	addFormLayout,
	fields,
	labels,
	values,
	errors,
	isAddDisabled,
	hasAddErrors,
	addFieldErrorId,
	setField,
	handleSubmit,
}: CrudAddFormProps) {
	const showJoinedLabels = fields.length > 1;
	const addInputGroup = (
		field: CrudField,
		isLast: boolean,
		error: string | undefined,
		joined: boolean,
	): ReactNode => (
		<InputGroup
			appearance={joined ? "minimal" : "elevated"}
			className={cn(
				"h-9",
				joined &&
					"rounded-none bg-transparent shadow-none ring-0 hover:bg-transparent focus-within:bg-foreground/[0.04] focus-within:ring-0",
			)}
			data-crud-add-input-group={joined ? "true" : undefined}
			size="sm"
			tone={error ? "danger" : "default"}
		>
			<InputGroupAddon align="inline-start">
				<HugeiconsIcon aria-hidden="true" icon={field.icon} size={14} />
			</InputGroupAddon>
			<InputGroupInput
				aria-describedby={error ? addFieldErrorId(field.name) : undefined}
				aria-invalid={!!error}
				aria-label={field.label}
				name={field.name}
				onChange={(event) => setField(field.name, event.target.value)}
				placeholder={field.placeholder}
				value={values[field.name] ?? ""}
			/>
			{isLast ? (
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						aria-label={labels.add}
						className={cn(
							joined &&
								"rounded-none text-accent shadow-none ring-0 hover:bg-accent hover:text-white disabled:text-foreground-dim disabled:hover:bg-transparent",
						)}
						disabled={isAddDisabled}
						tone={joined ? "ghost" : "surface"}
						type="submit"
					>
						<HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={2.25} />
					</InputGroupButton>
				</InputGroupAddon>
			) : null}
		</InputGroup>
	);

	return (
		<Form
			className={
				addFormLayout === "joined"
					? "flex flex-col gap-1.5"
					: fields.length > 1
						? "flex items-end gap-2"
						: undefined
			}
			onSubmit={handleSubmit}
		>
			{addFormLayout === "joined" ? (
				<>
					{showJoinedLabels ? (
						<div
							aria-hidden="true"
							className="flex text-2xs text-foreground-secondary"
						>
							{fields.map((field) => (
								<div
									className={cn("min-w-0 px-2", field.width ?? "flex-1")}
									key={field.name}
								>
									{field.label}
								</div>
							))}
						</div>
					) : null}
					<ButtonGroup
						aria-label={labels.add}
						className={cn(
							"w-full transition-[box-shadow] duration-150",
							hasAddErrors ? "ring-error/45" : "focus-within:ring-accent/45",
							"[&_[data-crud-add-input-group='true']]:h-9",
						)}
						connected
					>
						{fields.map((field, i) => {
							const isLast = i === fields.length - 1;
							const error = errors[field.name];
							return (
								<div
									className={cn("min-w-0", field.width ?? "flex-1")}
									key={field.name}
								>
									{addInputGroup(field, isLast, error, true)}
								</div>
							);
						})}
					</ButtonGroup>
					{hasAddErrors ? (
						<div className="flex gap-0">
							{fields.map((field) => {
								const error = errors[field.name];
								return (
									<div
										className={cn("min-w-0 px-2", field.width ?? "flex-1")}
										key={field.name}
									>
										{error ? (
											<div
												aria-live="assertive"
												className="text-error text-xs-tight leading-[14px]"
												id={addFieldErrorId(field.name)}
												role="alert"
											>
												{error}
											</div>
										) : null}
									</div>
								);
							})}
						</div>
					) : null}
				</>
			) : (
				fields.map((field, i) => {
					const isLast = i === fields.length - 1;
					const error = errors[field.name];
					const inputGroup = (
						<FormControl error={error} label={field.label}>
							{addInputGroup(field, isLast, error, false)}
						</FormControl>
					);
					return fields.length > 1 ? (
						<div className={field.width} key={field.name}>
							{inputGroup}
						</div>
					) : (
						<div key={field.name}>{inputGroup}</div>
					);
				})
			)}
		</Form>
	);
}
