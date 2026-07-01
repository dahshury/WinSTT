/**
 * shadcn-compatible `Checkbox` on base-ui, styled with WinSTT surface tokens.
 *
 * Bridges shadcn's `checked: boolean | "indeterminate"` to base-ui's separate
 * `checked` / `indeterminate` props, and emits `data-state` so the grid's
 * `data-[state=checked]` selectors keep working. Extra button props (onClick,
 * onMouseDown, …) the grid forwards are passed through.
 */
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Remove01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps, KeyboardEvent, MouseEvent } from "react";
import { cn } from "@/shared/lib/cn";

export interface CheckboxProps extends Omit<
	ComponentProps<typeof BaseCheckbox.Root>,
	| "checked"
	| "defaultChecked"
	| "indeterminate"
	| "onCheckedChange"
	| "onClick"
	| "onDoubleClick"
	| "onKeyDown"
	| "onMouseDown"
	| "render"
> {
	checked?: boolean | "indeterminate" | undefined;
	onCheckedChange?: ((checked: boolean) => void) | undefined;
	// Method syntax (bivariant) so the grid's button-typed handlers assign onto
	// the base-ui span without element-type variance errors.
	onClick?(event: MouseEvent): void;
	onDoubleClick?(event: MouseEvent): void;
	onKeyDown?(event: KeyboardEvent): void;
	onMouseDown?(event: MouseEvent): void;
}

export function Checkbox({
	checked,
	className,
	disabled,
	id,
	name,
	onCheckedChange,
	...props
}: CheckboxProps) {
	const indeterminate = checked === "indeterminate";
	const isChecked = checked === true;
	const state = indeterminate
		? "indeterminate"
		: isChecked
			? "checked"
			: "unchecked";
	return (
		<BaseCheckbox.Root
			checked={indeterminate ? false : isChecked}
			className={cn(
				"flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-border bg-surface-3 text-foreground outline-none transition-[background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:border-accent data-[checked]:bg-accent data-[indeterminate]:border-accent data-[indeterminate]:bg-accent",
				className,
			)}
			data-state={state}
			disabled={disabled}
			id={id}
			indeterminate={indeterminate}
			name={name}
			onCheckedChange={(value) => onCheckedChange?.(value)}
			{...props}
		>
			<BaseCheckbox.Indicator className="flex items-center justify-center text-foreground">
				<HugeiconsIcon
					icon={indeterminate ? Remove01Icon : Tick02Icon}
					size={12}
					strokeWidth={2.5}
				/>
			</BaseCheckbox.Indicator>
		</BaseCheckbox.Root>
	);
}
