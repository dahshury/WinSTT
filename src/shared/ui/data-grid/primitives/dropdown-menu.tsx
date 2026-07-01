/**
 * shadcn-compatible DropdownMenu on base-ui `Menu`, styled with WinSTT tokens.
 *
 * Radix `onSelect` is mapped to base-ui `onClick`; Radix `onCloseAutoFocus` is
 * mapped to base-ui `Popup.finalFocus` (the grid uses it to return focus to the
 * grid root after the context menu closes).
 */
import { Menu } from "@base-ui/react/menu";
import type {
	ComponentPropsWithoutRef,
	MouseEvent as ReactMouseEvent,
	ReactElement,
	ReactNode,
} from "react";
import { cn } from "@/shared/lib/cn";
import { Check } from "./icons";

const itemBase =
	"relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body text-foreground outline-none transition-colors data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

export function DropdownMenu({
	children,
	defaultOpen,
	modal,
	onOpenChange,
	open,
}: {
	children?: ReactNode;
	defaultOpen?: boolean | undefined;
	modal?: boolean | undefined;
	onOpenChange?: ((open: boolean) => void) | undefined;
	open?: boolean | undefined;
}) {
	return (
		<Menu.Root
			defaultOpen={defaultOpen}
			modal={modal}
			onOpenChange={(next) => onOpenChange?.(next)}
			open={open}
		>
			{children}
		</Menu.Root>
	);
}

export function DropdownMenuTrigger({
	asChild,
	children,
	...props
}: {
	asChild?: boolean;
	children?: ReactNode;
} & ComponentPropsWithoutRef<"button">) {
	if (asChild) {
		return <Menu.Trigger render={children as ReactElement} {...props} />;
	}
	return <Menu.Trigger {...props}>{children}</Menu.Trigger>;
}

export interface DropdownMenuContentProps extends Omit<
	ComponentPropsWithoutRef<"div">,
	"onScroll"
> {
	align?: "start" | "center" | "end";
	side?: "top" | "bottom" | "left" | "right";
	sideOffset?: number;
	onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
}

export function DropdownMenuContent({
	align = "start",
	children,
	className,
	onCloseAutoFocus,
	side = "bottom",
	sideOffset = 4,
	...props
}: DropdownMenuContentProps) {
	return (
		<Menu.Portal>
			<Menu.Positioner
				align={align}
				className="z-popover outline-none"
				collisionPadding={8}
				side={side}
				sideOffset={sideOffset}
			>
				<Menu.Popup
					className={cn(
						"min-w-[10rem] origin-[var(--transform-origin)] rounded-lg border border-border bg-surface-5 p-1 text-foreground shadow-overlay outline-none",
						className,
					)}
					finalFocus={
						onCloseAutoFocus
							? () => {
									onCloseAutoFocus({ preventDefault: () => {} });
									return false;
								}
							: undefined
					}
					{...props}
				>
					{children}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	);
}

export interface DropdownMenuItemProps extends Omit<
	ComponentPropsWithoutRef<"div">,
	"onSelect"
> {
	disabled?: boolean | undefined;
	onSelect?: ((event: Event) => void) | undefined;
	variant?: "default" | "destructive" | undefined;
}

export function DropdownMenuItem({
	children,
	className,
	disabled,
	onClick,
	onSelect,
	variant = "default",
	...props
}: DropdownMenuItemProps) {
	return (
		<Menu.Item
			className={cn(
				itemBase,
				variant === "destructive" &&
					"text-error data-[highlighted]:bg-error/10 data-[highlighted]:text-error",
				className,
			)}
			disabled={disabled}
			onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
				onClick?.(event);
				onSelect?.(event.nativeEvent);
			}}
			{...props}
		>
			{children}
		</Menu.Item>
	);
}

export interface DropdownMenuCheckboxItemProps extends Omit<
	ComponentPropsWithoutRef<"div">,
	"onSelect"
> {
	checked?: boolean | undefined;
	disabled?: boolean | undefined;
	onSelect?: ((event: Event) => void) | undefined;
}

export function DropdownMenuCheckboxItem({
	checked,
	children,
	className,
	disabled,
	onSelect,
	...props
}: DropdownMenuCheckboxItemProps) {
	return (
		<Menu.Item
			className={cn(itemBase, "pl-7", className)}
			closeOnClick={false}
			disabled={disabled}
			onClick={(event: ReactMouseEvent<HTMLDivElement>) =>
				onSelect?.(event.nativeEvent)
			}
			{...props}
		>
			<span className="absolute left-2 flex size-3.5 items-center justify-center">
				{checked ? <Check className="size-3.5 text-accent" /> : null}
			</span>
			{children}
		</Menu.Item>
	);
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
	return (
		<Menu.Separator className={cn("-mx-1 my-1 h-px bg-divider", className)} />
	);
}
