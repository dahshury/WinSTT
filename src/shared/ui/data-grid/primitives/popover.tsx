/**
 * shadcn-compatible Popover on base-ui, styled with WinSTT surface tokens.
 *
 * Radix exposes `<PopoverAnchor>` as a sibling that retargets positioning;
 * base-ui positions via `Positioner anchor={...}` instead. A small context
 * bridges the two: `PopoverAnchor` registers an element ref that
 * `PopoverContent` feeds to the Positioner (falling back to the trigger).
 */
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import {
	cloneElement,
	createContext,
	type ComponentPropsWithoutRef,
	isValidElement,
	type ReactElement,
	type ReactNode,
	type Ref,
	useRef,
	useState,
	use,
} from "react";
import { cn } from "@/shared/lib/cn";

interface AnchorContextValue {
	anchorRef: { current: HTMLElement | null };
	hasAnchor: boolean;
	setHasAnchor: (value: boolean) => void;
}

const AnchorContext = createContext<AnchorContextValue | null>(null);

export function Popover({
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
	const anchorRef = useRef<HTMLElement | null>(null);
	const [hasAnchor, setHasAnchor] = useState(false);
	return (
		<AnchorContext.Provider value={{ anchorRef, hasAnchor, setHasAnchor }}>
			<PopoverPrimitive.Root
				defaultOpen={defaultOpen}
				modal={modal}
				onOpenChange={(next) => onOpenChange?.(next)}
				open={open}
			>
				{children}
			</PopoverPrimitive.Root>
		</AnchorContext.Provider>
	);
}

// eslint-disable-next-line react-doctor/no-multi-comp -- compound component: Popover/Trigger/Anchor/Content share the private AnchorContext and belong in one file (idiomatic shadcn/radix pattern)
export function PopoverTrigger({
	asChild,
	children,
	...props
}: {
	asChild?: boolean;
	children?: ReactNode;
} & ComponentPropsWithoutRef<"button">) {
	if (asChild) {
		return <PopoverPrimitive.Trigger render={children as ReactElement} />;
	}
	return (
		<PopoverPrimitive.Trigger {...props}>{children}</PopoverPrimitive.Trigger>
	);
}

export function PopoverAnchor({
	children,
}: {
	asChild?: boolean;
	children: ReactElement;
}) {
	const ctx = use(AnchorContext);
	if (!isValidElement(children)) return children ?? null;
	const child = children as ReactElement<{ ref?: Ref<HTMLElement> }>;
	const original = child.props.ref;
	return cloneElement(child, {
		ref: (node: HTMLElement | null) => {
			if (ctx) {
				ctx.anchorRef.current = node;
				ctx.setHasAnchor(Boolean(node));
			}
			if (typeof original === "function") original(node);
			else if (original)
				(original as { current: HTMLElement | null }).current = node;
		},
	});
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

// eslint-disable-next-line react-doctor/no-multi-comp -- compound component: shares the private AnchorContext with Popover/Trigger/Anchor (idiomatic shadcn/radix pattern)
export function PopoverContent({
	align = "center",
	alignOffset,
	children,
	className,
	onCloseAutoFocus,
	onEscapeKeyDown,
	onInteractOutside,
	onOpenAutoFocus,
	side = "bottom",
	sideOffset = 4,
	...props
}: PopoverContentProps) {
	const ctx = use(AnchorContext);
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={ctx?.hasAnchor ? ctx.anchorRef : undefined}
				className="z-popover outline-none"
				collisionPadding={8}
				side={side}
				sideOffset={sideOffset}
			>
				<PopoverPrimitive.Popup
					className={cn(
						"origin-[var(--transform-origin)] rounded-lg border border-border bg-surface-5 p-2 text-foreground shadow-overlay outline-none",
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
				</PopoverPrimitive.Popup>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}
