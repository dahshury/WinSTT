"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Z_INDEX } from "@/shared/lib/z-index";

/**
 * Local dropdown-menu wrappers around Base UI Menu, adapted to the shadcn
 * naming used across the OpenRouter model selector widget. WinSTT does not
 * have a shared dropdown-menu primitive, so this is widget-internal.
 */

type RootProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Root>;
type TriggerProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Trigger>;

export function DropdownMenu(props: RootProps) {
	return <MenuPrimitive.Root {...props} />;
}

export function DropdownMenuTrigger(props: TriggerProps) {
	return <MenuPrimitive.Trigger {...props} />;
}

type DropdownMenuContentProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Popup> & {
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	sideOffset?: number;
	style?: CSSProperties;
};

export function DropdownMenuContent({
	className,
	children,
	side,
	align = "start",
	sideOffset = 4,
	style,
	...rest
}: DropdownMenuContentProps) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				align={align}
				side={side}
				sideOffset={sideOffset}
				style={{ zIndex: Z_INDEX.dropdown, ...style }}
			>
				<MenuPrimitive.Popup
					className={cn(
						"min-w-[10rem] overflow-hidden rounded-md border border-border bg-surface-elevated p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
						className
					)}
					{...rest}
				>
					{children}
				</MenuPrimitive.Popup>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

type ItemProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Item>;

export function DropdownMenuItem({ className, ...rest }: ItemProps) {
	return (
		<MenuPrimitive.Item
			className={cn(
				"flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-body outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-hover data-[highlighted]:text-foreground data-[disabled]:opacity-50",
				className
			)}
			{...rest}
		/>
	);
}

export function DropdownMenuLabel({
	className,
	...rest
}: ComponentPropsWithoutRef<typeof MenuPrimitive.GroupLabel>) {
	return (
		<MenuPrimitive.GroupLabel
			className={cn("px-2 py-1.5 font-semibold text-foreground-muted text-xs-tight", className)}
			{...rest}
		/>
	);
}

export function DropdownMenuGroup({
	className,
	...rest
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Group>) {
	return <MenuPrimitive.Group className={cn(className)} {...rest} />;
}

export function DropdownMenuSeparator({ className, ...rest }: ComponentPropsWithoutRef<"hr">) {
	return <hr className={cn("-mx-1 my-1 h-px border-0 bg-border", className)} {...rest} />;
}

type SubProps = ComponentPropsWithoutRef<typeof MenuPrimitive.SubmenuRoot>;
type SubTriggerProps = ComponentPropsWithoutRef<typeof MenuPrimitive.SubmenuTrigger>;

export function DropdownMenuSub(props: SubProps) {
	return <MenuPrimitive.SubmenuRoot {...props} />;
}

export function DropdownMenuSubTrigger({
	className,
	children,
	...rest
}: SubTriggerProps & { children?: ReactNode }) {
	return (
		<MenuPrimitive.SubmenuTrigger
			className={cn(
				"flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-body outline-none data-[highlighted]:bg-surface-hover data-[popup-open]:bg-surface-hover",
				className
			)}
			{...rest}
		>
			{children}
		</MenuPrimitive.SubmenuTrigger>
	);
}

export function DropdownMenuSubContent({
	className,
	children,
	style,
	...rest
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Popup> & {
	style?: CSSProperties;
}) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				align="start"
				side="right"
				sideOffset={4}
				style={{ zIndex: Z_INDEX.dropdownSubmenu, ...style }}
			>
				<MenuPrimitive.Popup
					className={cn(
						"min-w-[10rem] overflow-hidden rounded-md border border-border bg-surface-elevated p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
						className
					)}
					{...rest}
				>
					{children}
				</MenuPrimitive.Popup>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}
