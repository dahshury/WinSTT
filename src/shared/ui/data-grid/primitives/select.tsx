/** shadcn-compatible Select on base-ui, styled with WinSTT surface tokens. */
import { Select as SelectPrimitive } from "@base-ui/react/select";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Check, ChevronDown } from "./icons";

export function Select<Value>({
	children,
	defaultValue,
	disabled,
	onOpenChange,
	onValueChange,
	open,
	value,
}: {
	children?: ReactNode;
	defaultValue?: Value | undefined;
	disabled?: boolean | undefined;
	onOpenChange?: ((open: boolean) => void) | undefined;
	onValueChange?: ((value: Value) => void) | undefined;
	open?: boolean | undefined;
	value?: Value | undefined;
}) {
	return (
		<SelectPrimitive.Root
			defaultValue={defaultValue as never}
			disabled={disabled}
			onOpenChange={(next) => onOpenChange?.(next)}
			onValueChange={(next) => onValueChange?.(next as Value)}
			open={open}
			value={value as never}
		>
			{children}
		</SelectPrimitive.Root>
	);
}

export function SelectTrigger({
	children,
	className,
	...props
}: ComponentPropsWithoutRef<"button"> & { children?: ReactNode }) {
	return (
		<SelectPrimitive.Trigger
			className={cn(
				"flex h-8 w-full cursor-pointer select-none items-center justify-between gap-2 rounded-md border border-border bg-surface-3 px-2.5 text-body text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
				className,
			)}
			{...props}
		>
			<span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
			<SelectPrimitive.Icon className="shrink-0 text-foreground-muted">
				<ChevronDown />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

export function SelectValue({
	children,
	placeholder,
}: {
	children?: ReactNode;
	placeholder?: ReactNode;
}) {
	return (
		<SelectPrimitive.Value placeholder={placeholder}>
			{children ? () => children : undefined}
		</SelectPrimitive.Value>
	);
}

export interface SelectContentProps extends ComponentPropsWithoutRef<"div"> {
	align?: "start" | "center" | "end" | undefined;
	alignOffset?: number | undefined;
	side?: "top" | "bottom" | "left" | "right" | undefined;
	sideOffset?: number | undefined;
}

export function SelectContent({
	align,
	alignOffset,
	children,
	className,
	side,
	sideOffset = 4,
	...props
}: SelectContentProps) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				alignItemWithTrigger={false}
				className="z-popover outline-none"
				side={side}
				sideOffset={sideOffset}
			>
				<SelectPrimitive.Popup
					className={cn(
						"max-h-[min(20rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-md border border-border bg-surface-5 p-1 text-foreground shadow-overlay outline-none",
						className,
					)}
					{...props}
				>
					{children}
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

export function SelectGroup({
	children,
	...props
}: ComponentPropsWithoutRef<"div"> & { children?: ReactNode }) {
	return <SelectPrimitive.Group {...props}>{children}</SelectPrimitive.Group>;
}

export function SelectItem({
	children,
	className,
	value,
}: {
	children?: ReactNode;
	className?: string;
	value: string;
}) {
	return (
		<SelectPrimitive.Item
			className={cn(
				"relative flex cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-body text-foreground outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover [&_svg]:size-4 [&_svg]:shrink-0",
				className,
			)}
			value={value}
		>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center text-accent">
				<Check className="size-4" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}
