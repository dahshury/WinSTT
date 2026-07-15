"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceClasses,
	surfaceHighlightedBg,
	surfacePopupOpenBg,
	useSurface,
} from "@/shared/lib/surface";

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

type DropdownMenuContentProps = ComponentPropsWithoutRef<
	typeof MenuPrimitive.Popup
> & {
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	sideOffset?: number;
	style?: CSSProperties;
};

function dropdownOrigin(
	side: DropdownMenuContentProps["side"],
	align: DropdownMenuContentProps["align"],
) {
	const edge =
		align === "end" ? "right" : align === "center" ? "center" : "left";
	return side === "top" ? `bottom-${edge}` : `top-${edge}`;
}

export function DropdownMenuContent({
	className,
	children,
	side,
	align = "start",
	sideOffset = 4,
	style,
	...rest
}: DropdownMenuContentProps) {
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	return (
		<MenuPrimitive.Portal>
			<SurfaceProvider value={popupLevel}>
				<MenuPrimitive.Positioner
					align={align}
					side={side}
					sideOffset={sideOffset}
					style={{ zIndex: Z_INDEX.popover, ...style }}
				>
					<MenuPrimitive.Popup
						className={cn(
							"t-dropdown min-w-[10rem] overflow-hidden rounded-md p-1 font-sans text-body text-foreground",
							surfaceClasses(popupLevel, popupShadow),
							className,
						)}
						data-origin={dropdownOrigin(side, align)}
						{...rest}
					>
						{children}
					</MenuPrimitive.Popup>
				</MenuPrimitive.Positioner>
			</SurfaceProvider>
		</MenuPrimitive.Portal>
	);
}

type ItemProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Item>;

export function DropdownMenuItem({ className, ...rest }: ItemProps) {
	const substrate = useSurface();
	const highlightLevel = Math.min(substrate + 1, 8);
	return (
		<MenuPrimitive.Item
			className={cn(
				"flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-body outline-none data-[disabled]:pointer-events-none data-[highlighted]:text-foreground data-[disabled]:opacity-50",
				surfaceHighlightedBg(highlightLevel),
				className,
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
			className={cn(
				"px-2 py-1.5 font-semibold text-foreground-muted text-xs-tight",
				className,
			)}
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

export function DropdownMenuSeparator({
	className,
	...rest
}: ComponentPropsWithoutRef<"hr">) {
	return (
		<hr
			className={cn("-mx-1 my-1 h-px border-0 bg-border", className)}
			{...rest}
		/>
	);
}

type SubProps = ComponentPropsWithoutRef<typeof MenuPrimitive.SubmenuRoot>;
type SubTriggerProps = ComponentPropsWithoutRef<
	typeof MenuPrimitive.SubmenuTrigger
>;

export function DropdownMenuSub(props: SubProps) {
	return <MenuPrimitive.SubmenuRoot {...props} />;
}

export function DropdownMenuSubTrigger({
	className,
	children,
	...rest
}: SubTriggerProps & { children?: ReactNode }) {
	const substrate = useSurface();
	const highlightLevel = Math.min(substrate + 1, 8);
	return (
		<MenuPrimitive.SubmenuTrigger
			className={cn(
				"flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-body outline-none",
				surfaceHighlightedBg(highlightLevel),
				surfacePopupOpenBg(highlightLevel),
				className,
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
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	return (
		<MenuPrimitive.Portal>
			<SurfaceProvider value={popupLevel}>
				<MenuPrimitive.Positioner
					align="start"
					side="right"
					sideOffset={4}
					style={{ zIndex: Z_INDEX.popoverSubmenu, ...style }}
				>
					<MenuPrimitive.Popup
						className={cn(
							"t-dropdown min-w-[10rem] overflow-hidden rounded-md p-1 font-sans text-body text-foreground",
							surfaceClasses(popupLevel, popupShadow),
							className,
						)}
						data-origin="top-left"
						{...rest}
					>
						{children}
					</MenuPrimitive.Popup>
				</MenuPrimitive.Positioner>
			</SurfaceProvider>
		</MenuPrimitive.Portal>
	);
}
