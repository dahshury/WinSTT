import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as VanillaDialog } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type ComponentProps,
	type ComponentPropsWithoutRef,
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
} from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceClasses, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

/** DialogContent lifts the popup four surface levels above its substrate — the
 *  shared elevation contract every dialog/modal in the app uses. Capped at 8
 *  (the deepest surface token), shadow floored at 7 so the popup always reads
 *  as "floating" even from a shallow substrate. */
const DIALOG_OFFSET = 4;
const MAX_SURFACE = 8;
const MIN_POPUP_SHADOW = 7;

/** Alert mode swaps the vanilla Dialog primitives for AlertDialog ones
 *  (`role="alertdialog"`, focus-trap, no light-dismiss on backdrop) and bumps
 *  the stacking tier to `z-confirm` so a destructive confirm always sits above
 *  an open popover / combobox / modal. Carried via context so the compound
 *  parts (Content, Title, Close, …) pick the matching primitive and z-tier
 *  without prop-drilling. */
const AlertModeContext = createContext(false);

function useAlertMode(): boolean {
	return useContext(AlertModeContext);
}

export interface DialogProps {
	/** Render as a destructive/confirmation alert dialog (AlertDialog semantics
	 *  + `z-confirm`) instead of a plain dialog (`z-modal`). */
	alert?: boolean;
	children?: ReactNode;
	defaultOpen?: boolean;
	/** Base UI `modal` knob (vanilla dialog only; alert dialogs are always
	 *  modal). `false` lets background interaction through. */
	modal?: boolean;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
}

/** Root. Picks the AlertDialog or Dialog primitive from `alert` and publishes
 *  that choice so the rest of the compound parts stay in sync. */
export function Dialog({
	alert = false,
	children,
	defaultOpen,
	modal,
	onOpenChange,
	open,
}: DialogProps) {
	const handleOpenChange = (next: boolean): void => onOpenChange?.(next);
	if (alert) {
		return (
			<AlertModeContext.Provider value={true}>
				<AlertDialog.Root defaultOpen={defaultOpen} onOpenChange={handleOpenChange} open={open}>
					{children}
				</AlertDialog.Root>
			</AlertModeContext.Provider>
		);
	}
	return (
		<AlertModeContext.Provider value={false}>
			<VanillaDialog.Root
				defaultOpen={defaultOpen}
				modal={modal}
				onOpenChange={handleOpenChange}
				open={open}
			>
				{children}
			</VanillaDialog.Root>
		</AlertModeContext.Provider>
	);
}

type CloseRender = ComponentProps<typeof VanillaDialog.Close>["render"];

export interface DialogCloseProps {
	children?: ReactNode;
	className?: string;
	onClick?: ComponentPropsWithoutRef<"button">["onClick"];
	render?: CloseRender;
}

/** Closes the dialog. Wrap a footer button in this (`render={<Button/>}`) to get
 *  Base UI's auto-close-on-press, or use it bare for an icon close. */
export function DialogClose({ children, className, onClick, render }: DialogCloseProps) {
	const alert = useAlertMode();
	if (alert) {
		return (
			<AlertDialog.Close className={className} onClick={onClick} render={render}>
				{children}
			</AlertDialog.Close>
		);
	}
	return (
		<VanillaDialog.Close className={className} onClick={onClick} render={render}>
			{children}
		</VanillaDialog.Close>
	);
}

/** Floating ghost "✕" in the popup corner. Opt-in via `DialogContent showClose`.
 *  Reads the popup surface (set by DialogContent's provider) and lifts the
 *  hover one level above it, matching the app's surface-elevation convention. */
function DialogCloseButton() {
	const surface = useSurface();
	const hover = Math.min(surface + 1, MAX_SURFACE);
	return (
		<DialogClose
			render={
				<Button
					aria-label="Close"
					className={cn(
						"absolute top-3 right-3 h-7 w-7 rounded-md p-0 text-foreground-muted transition-colors duration-150",
						surfaceHoverBg(hover)
					)}
				>
					<HugeiconsIcon icon={Cancel01Icon} size={14} />
				</Button>
			}
		/>
	);
}

export interface DialogContentProps {
	children?: ReactNode;
	className?: string;
	/** Content-driven width: drop every width / max-width constraint so the
	 *  popup sizes to its children (the free-form modal case). */
	fluid?: boolean;
	/** `p-6` + `flex flex-col gap-4` standard dialog padding/rhythm. Turn off for
	 *  free-form content that owns its own layout. Default `true`. */
	padded?: boolean;
	/** Render a floating close "✕" in the corner. Default `false` — most dialogs
	 *  drive closing from explicit footer buttons. */
	showClose?: boolean;
	/** Preset max-width (fluidfunctionalism parity). Ignored when `width` or
	 *  `fluid` is set. Default `"sm"`. */
	size?: "sm" | "lg";
	style?: CSSProperties;
	/** Exact popup width in px (caps at 90vw). Overrides `size`. */
	width?: number;
}

/** The single source of popup chrome — portal, backdrop, surface-aware popup,
 *  enter/exit animation, stacking tier, and optional close. `DialogShell` and
 *  `Modal` both render through this, so every dialog shares one look. */
export function DialogContent({
	children,
	className,
	fluid = false,
	padded = true,
	showClose = false,
	size = "sm",
	style,
	width,
}: DialogContentProps) {
	const alert = useAlertMode();
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + DIALOG_OFFSET, MAX_SURFACE);
	const popupShadow = Math.max(popupLevel, MIN_POPUP_SHADOW);

	const backdropClass = cn(
		dialogAnimation.backdrop,
		"fixed inset-0 bg-black/60 backdrop-blur-sm",
		alert ? "z-confirm-backdrop" : "z-modal-backdrop"
	);
	const usePreset = !(fluid || width !== undefined);
	const popupClass = cn(
		dialogAnimation.popup,
		"fixed top-1/2 left-1/2 rounded-xl outline-none",
		alert ? "z-confirm" : "z-modal",
		surfaceClasses(popupLevel, popupShadow),
		padded && "flex flex-col gap-4 p-6",
		!fluid && "max-w-[90vw]",
		usePreset && size === "sm" && "w-[calc(100%-2rem)] max-w-[400px]",
		usePreset && size === "lg" && "w-[calc(100%-2rem)] max-w-[540px]",
		className
	);
	const popupStyle: CSSProperties | undefined =
		typeof width === "number" ? { width, ...style } : style;

	const inner = (
		<SurfaceProvider value={popupLevel}>
			{children}
			{showClose ? <DialogCloseButton /> : null}
		</SurfaceProvider>
	);

	// Only the primitive namespace differs between modes; class + surface math
	// above is shared. Branching the 3-element portal subtree keeps both paths
	// fully type-checked against their concrete Base UI components.
	if (alert) {
		return (
			<AlertDialog.Portal>
				<AlertDialog.Backdrop className={backdropClass} />
				<AlertDialog.Popup className={popupClass} style={popupStyle}>
					{inner}
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		);
	}
	return (
		<VanillaDialog.Portal>
			<VanillaDialog.Backdrop className={backdropClass} />
			<VanillaDialog.Popup className={popupClass} style={popupStyle}>
				{inner}
			</VanillaDialog.Popup>
		</VanillaDialog.Portal>
	);
}

export function DialogFooter({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return <div className={cn("flex justify-end gap-2", className)}>{children}</div>;
}

export interface DialogTitleProps {
	children?: ReactNode;
	className?: string;
}

export function DialogTitle({ children, className }: DialogTitleProps) {
	const alert = useAlertMode();
	const cls = cn("m-0 font-sans font-semibold text-[15px] text-foreground", className);
	if (alert) {
		return <AlertDialog.Title className={cls}>{children}</AlertDialog.Title>;
	}
	return <VanillaDialog.Title className={cls}>{children}</VanillaDialog.Title>;
}

type DescriptionRender = ComponentProps<typeof VanillaDialog.Description>["render"];

export interface DialogDescriptionProps {
	children?: ReactNode;
	className?: string;
	/** Base UI render override — pass `render={<div />}` for ReactNode bodies so
	 *  block elements (lists, paragraphs) are legal inside the description. */
	render?: DescriptionRender;
}

export function DialogDescription({ children, className, render }: DialogDescriptionProps) {
	const alert = useAlertMode();
	const cls = cn(
		"m-0 whitespace-pre-line font-sans text-body text-foreground-muted leading-relaxed",
		className
	);
	if (alert) {
		return (
			<AlertDialog.Description className={cls} render={render}>
				{children}
			</AlertDialog.Description>
		);
	}
	return (
		<VanillaDialog.Description className={cls} render={render}>
			{children}
		</VanillaDialog.Description>
	);
}

type DialogActionVariant = "neutral" | "accent" | "danger";

export interface DialogActionButtonProps extends ComponentPropsWithoutRef<"button"> {
	/** `neutral` = surface-lifted cancel/dismiss; `accent` = brand confirm;
	 *  `danger` = destructive confirm. Default `neutral`. */
	variant?: DialogActionVariant;
}

/** The shared footer button. Neutral reads the popup surface (set by
 *  DialogContent) and lifts +1 fill / +2 hover — the same elevation the confirm
 *  / opt-in / download dialogs hand-rolled before this existed. Compose with
 *  `DialogClose` for auto-close, or pass `onClick` for explicit handling. */
export function DialogActionButton({
	children,
	className,
	variant = "neutral",
	...rest
}: DialogActionButtonProps) {
	const surface = useSurface();
	const fill = Math.min(surface + 1, MAX_SURFACE);
	const hover = Math.min(surface + 2, MAX_SURFACE);
	// Neutral derives its fill/hover from the popup surface, so it can't live in
	// a static map; accent/danger are flat brand colors.
	const solidVariant: Record<"accent" | "danger", string> = {
		accent: "bg-accent text-white hover:bg-accent-dim",
		danger: "bg-error text-white hover:bg-error-dim",
	};
	const variantClass =
		variant === "neutral"
			? cn(surfaceClasses(fill), "text-foreground-secondary", surfaceHoverBg(hover))
			: solidVariant[variant];
	return (
		<Button
			className={cn(
				"h-8 rounded-md px-4 font-medium text-body transition-colors duration-150",
				variantClass,
				className
			)}
			{...rest}
		>
			{children}
		</Button>
	);
}
