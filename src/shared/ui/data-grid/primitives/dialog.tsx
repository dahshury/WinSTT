/** shadcn-compatible Dialog on base-ui, styled with WinSTT surface tokens. */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { X } from "./icons";

export function Dialog({
	children,
	defaultOpen,
	modal,
	onOpenChange,
	open,
}: {
	children?: ReactNode;
	defaultOpen?: boolean;
	modal?: boolean;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
}) {
	return (
		<DialogPrimitive.Root
			defaultOpen={defaultOpen}
			modal={modal}
			onOpenChange={(next) => onOpenChange?.(next)}
			open={open}
		>
			{children}
		</DialogPrimitive.Root>
	);
}

export interface DialogContentProps extends ComponentPropsWithoutRef<"div"> {
	onOpenAutoFocus?: ((event: Event) => void) | undefined;
	onCloseAutoFocus?: ((event: Event) => void) | undefined;
	showCloseButton?: boolean | undefined;
}

export function DialogContent({
	children,
	className,
	onCloseAutoFocus,
	onOpenAutoFocus,
	showCloseButton = true,
	...props
}: DialogContentProps) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Backdrop className="fixed inset-0 z-modal-backdrop bg-overlay-scrim backdrop-blur-sm" />
			<DialogPrimitive.Popup
				className={cn(
					"fixed top-1/2 left-1/2 z-modal w-[calc(100%-2rem)] max-w-[480px] origin-[var(--transform-origin)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-xl border border-border bg-surface-5 p-6 text-foreground shadow-overlay outline-none",
					className,
				)}
				finalFocus={
					onCloseAutoFocus
						? () => {
								onCloseAutoFocus(new Event("close"));
								return false;
							}
						: undefined
				}
				initialFocus={onOpenAutoFocus ? false : undefined}
				{...props}
			>
				{children}
				{showCloseButton ? (
					<DialogPrimitive.Close className="absolute end-4 top-4 flex size-7 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-hover hover:text-foreground">
						<X className="size-4" />
					</DialogPrimitive.Close>
				) : null}
			</DialogPrimitive.Popup>
		</DialogPrimitive.Portal>
	);
}

export function DialogClose({
	asChild,
	children,
	className,
	...props
}: {
	asChild?: boolean;
	children?: ReactNode;
} & ComponentPropsWithoutRef<"button">) {
	if (asChild) {
		return (
			<DialogPrimitive.Close
				className={className}
				render={children as ReactElement}
			/>
		);
	}
	return (
		<DialogPrimitive.Close className={className} {...props}>
			{children}
		</DialogPrimitive.Close>
	);
}

export function DialogTitle({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<DialogPrimitive.Title
			className={cn("m-0 font-semibold text-[15px] text-foreground", className)}
		>
			{children}
		</DialogPrimitive.Title>
	);
}

export function DialogDescription({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<DialogPrimitive.Description
			className={cn(
				"m-0 text-body text-foreground-muted leading-relaxed",
				className,
			)}
		>
			{children}
		</DialogPrimitive.Description>
	);
}

export function DialogHeader({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>{children}</div>
	);
}

export function DialogFooter({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				className,
			)}
		>
			{children}
		</div>
	);
}
