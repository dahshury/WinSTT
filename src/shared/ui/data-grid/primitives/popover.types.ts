import type {
	ComponentPropsWithoutRef,
	ReactElement,
	ReactNode,
	Ref,
} from "react";

export interface PopoverProps {
	children?: ReactNode;
	defaultOpen?: boolean;
	modal?: boolean;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
}

type PopoverTriggerAsChildProps = {
	asChild: true;
	children: ReactElement;
} & ComponentPropsWithoutRef<"button">;

type PopoverTriggerButtonProps = {
	asChild?: false | undefined;
	children?: ReactNode;
} & ComponentPropsWithoutRef<"button">;

export type PopoverTriggerProps =
	| PopoverTriggerAsChildProps
	| PopoverTriggerButtonProps;

export interface PopoverAnchorProps {
	asChild?: boolean;
	children: ReactNode;
}

export interface PopoverContentProps extends ComponentPropsWithoutRef<"div"> {
	align?: "start" | "center" | "end" | undefined;
	alignOffset?: number | undefined;
	side?: "top" | "bottom" | "left" | "right" | undefined;
	sideOffset?: number | undefined;
	/** Radix parity: `preventDefault()` keeps focus in the trigger/editor. */
	onOpenAutoFocus?: ((event: Event) => void) | undefined;
	onCloseAutoFocus?: ((event: Event) => void) | undefined;
	onEscapeKeyDown?: ((event: Event) => void) | undefined;
	onInteractOutside?: ((event: Event) => void) | undefined;
}

export interface AnchorChildProps {
	ref?: Ref<HTMLElement>;
}
