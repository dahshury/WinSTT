import type { ChangeEventHandler } from "react";

interface RowSelectionCheckboxProps {
	checked: boolean;
	disabled?: boolean;
	indeterminate?: boolean;
	label: string;
	onChange: ChangeEventHandler<HTMLInputElement>;
}

/**
 * The select-all / per-row checkbox rendered in {@link CrudTable}'s leading
 * column. Native `<input type="checkbox">` driven so the indeterminate state can
 * be set imperatively (the DOM has no attribute for it).
 */
export function RowSelectionCheckbox({
	checked,
	disabled = false,
	indeterminate = false,
	label,
	onChange,
}: RowSelectionCheckboxProps) {
	return (
		<input
			aria-label={label}
			checked={checked}
			className="size-4 cursor-pointer rounded-[4px] border border-border bg-surface-2/60 accent-accent outline-none transition-colors duration-150 hover:border-border-hover focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40"
			disabled={disabled}
			onChange={onChange}
			ref={(node) => {
				if (node) {
					node.indeterminate = indeterminate;
				}
			}}
			type="checkbox"
		/>
	);
}
