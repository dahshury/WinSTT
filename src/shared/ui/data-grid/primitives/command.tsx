/** shadcn-compatible Command (cmdk) styled with WinSTT surface tokens. */
import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";
import { SearchIcon } from "./icons";

export function Command({
	className,
	...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			className={cn(
				"flex h-full w-full flex-col overflow-hidden rounded-md bg-surface-5 text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandInput({
	className,
	ref,
	...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div
			className="flex items-center gap-2 border-divider border-b px-2.5"
			// eslint-disable-next-line react-doctor/no-unknown-property -- cmdk targets this exact attribute via its [cmdk-input-wrapper] CSS selectors; renaming/removing it breaks Command input styling
			cmdk-input-wrapper=""
		>
			<SearchIcon className="size-4 shrink-0 text-foreground-muted" />
			<CommandPrimitive.Input
				className={cn(
					"flex h-9 w-full bg-transparent text-body text-foreground outline-none placeholder:text-foreground-muted disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
				ref={ref}
				{...props}
			/>
		</div>
	);
}

export function CommandList({
	className,
	...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			className={cn(
				"max-h-[300px] overflow-y-auto overflow-x-hidden p-1",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandEmpty(
	props: ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>,
) {
	return (
		<CommandPrimitive.Empty
			className="py-4 text-center text-body text-foreground-muted"
			{...props}
		/>
	);
}

export function CommandGroup({
	className,
	...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			className={cn(
				"overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:text-foreground-muted",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandItem({
	className,
	...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			className={cn(
				"relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body text-foreground outline-none transition-colors data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-hover [&_svg]:size-4 [&_svg]:shrink-0",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandSeparator({
	className,
	...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>) {
	return (
		<CommandPrimitive.Separator
			className={cn("-mx-1 h-px bg-divider", className)}
			{...props}
		/>
	);
}
