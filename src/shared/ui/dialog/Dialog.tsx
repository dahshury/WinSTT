import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as VanillaDialog } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Children,
	type ComponentProps,
	type ComponentPropsWithoutRef,
	type CSSProperties,
	createContext,
	Fragment,
	isValidElement,
	type ReactElement,
	type ReactNode,
	use,
} from "react";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

/** Every popup sits on ONE fixed surface rung, regardless of what opened it.
 *  Dialogs used to step +4 off their substrate, which put them at surface-5..8
 *  — a pale slab over a ~13%L settings window — and made an identical dialog
 *  look different depending on how deep the opener was nested. The popup now
 *  paints its own material (`.dialog-surface`, see globals.css); this level
 *  exists only so the CHILDREN (cards, inputs, neutral buttons) keep laddering
 *  above the plate the way they do everywhere else.
 *
 *  Exported because a couple of dialogs compute their inner card levels from
 *  the popup's, and they must not re-derive the number. */
export const DIALOG_SURFACE_LEVEL = 4;
const MAX_SURFACE = 8;

/** Alert mode swaps the vanilla Dialog primitives for AlertDialog ones
 *  (`role="alertdialog"`, focus-trap, no light-dismiss on backdrop) and bumps
 *  the stacking tier to `z-confirm` so a destructive confirm always sits above
 *  an open popover / combobox / modal. Carried via context so the compound
 *  parts (Content, Title, Close, …) pick the matching primitive and z-tier
 *  without prop-drilling. */
const AlertModeContext = createContext(false);

function useAlertMode(): boolean {
	return use(AlertModeContext);
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
				<AlertDialog.Root
					defaultOpen={defaultOpen}
					onOpenChange={handleOpenChange}
					open={open}
				>
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
export function DialogClose({
	children,
	className,
	onClick,
	render,
}: DialogCloseProps) {
	const alert = useAlertMode();
	if (alert) {
		return (
			<AlertDialog.Close
				className={className}
				onClick={onClick}
				render={render}
			>
				{children}
			</AlertDialog.Close>
		);
	}
	return (
		<VanillaDialog.Close
			className={className}
			onClick={onClick}
			render={render}
		>
			{children}
		</VanillaDialog.Close>
	);
}

/** Floating ghost "✕" in the popup corner. Opt-in via `DialogContent showClose`.
 *  Reads the popup surface (set by DialogContent's provider) and lifts the
 *  hover one level above it, matching the app's surface-elevation convention. */
function DialogCloseButton() {
	const surface = useSurface();
	const hover = Math.min(surface + 2, MAX_SURFACE);
	return (
		<DialogClose
			render={
				<Button
					aria-label="Close"
					className={cn(
						"absolute top-4 right-4 h-7 w-7 rounded-lg p-0 text-foreground-muted transition-colors duration-150 hover:text-foreground",
						surfaceHoverBg(hover),
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
	const popupLevel = DIALOG_SURFACE_LEVEL;

	const backdropClass = cn(
		dialogAnimation.backdrop,
		"fixed inset-0 bg-overlay-scrim backdrop-blur-[3px]",
		alert ? "z-confirm-backdrop" : "z-modal-backdrop",
	);
	const usePreset = !(fluid || width !== undefined);
	const popupClass = cn(
		dialogAnimation.popup,
		// The plate's whole look — gradient, hairline ring, drop shadow — is the
		// `.dialog-surface` material, not a surface-N token pair. `isolate` keeps
		// nested popups (a confirm opened from inside a modal) from bleeding their
		// own stacking into this one.
		"dialog-surface fixed top-1/2 left-1/2 isolate overflow-hidden rounded-2xl outline-none",
		alert ? "z-confirm" : "z-modal",
		padded && "flex flex-col gap-3.5 p-5",
		!fluid && "max-w-[90vw]",
		usePreset && size === "sm" && "w-[calc(100%-2rem)] max-w-[420px]",
		usePreset && size === "lg" && "w-[calc(100%-2rem)] max-w-[560px]",
		className,
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

export interface DialogFooterProps {
	/** Trailing action buttons. */
	children?: ReactNode;
	className?: string;
	/** Render as an attached bottom rail — recessed tint + hairline, edge-to-edge
	 *  — for dialogs whose body scrolls under it. Off for the small
	 *  confirm/opt-in dialogs, where the footer is just the last row of a short
	 *  padded stack and a rail would be heavy. */
	bar?: boolean;
	/** Content pinned to the LEADING edge of the rail — a secondary link, a
	 *  hint, a "reset to defaults". Actions stay trailing. */
	leading?: ReactNode;
}

export function DialogFooter({
	bar = false,
	children,
	className,
	leading,
}: DialogFooterProps) {
	const actions = flattenDialogActions(children);

	return (
		<div
			className={cn(
				"flex items-center gap-3",
				leading ? "justify-between" : "justify-end",
				bar && "dialog-rail-bottom shrink-0 px-5 py-3.5",
				className,
			)}
		>
			{leading ? (
				<div className="flex min-w-0 items-center gap-2">{leading}</div>
			) : null}
			{/* Separate, spaced buttons rather than one connected segment control:
			    a segmented group reads as "pick one of these modes", which is the
			    wrong signal for Cancel-vs-Save. The toolbar role is kept so the
			    action row is still one stop for assistive tech. */}
			{actions.length >= 2 ? (
				<ButtonGroup aria-label="Dialog actions" className="gap-2">
					{actions}
				</ButtonGroup>
			) : (
				actions
			)}
		</div>
	);
}

export interface DialogBodyProps {
	children?: ReactNode;
	className?: string;
	/** Max height of the scroll viewport. Default `70vh` — tall enough to avoid
	 *  a scrollbar on ordinary content, short enough that the popup never runs
	 *  past the window on a laptop display. */
	maxHeight?: string;
	/** Drop the standard horizontal padding for bodies that paint edge-to-edge
	 *  rows (lists, grids) and pad their own children. */
	flush?: boolean;
}

/** Scrollable middle of a header/body/footer dialog. Owns the max-height (a
 *  `flex-1` child of a content-sized popup never gets a definite height to
 *  scroll within) and dissolves content into the rails at both edges instead of
 *  guillotining it against them. */
export function DialogBody({
	children,
	className,
	flush = false,
	maxHeight = "70vh",
}: DialogBodyProps) {
	return (
		<div
			className={cn(
				"dialog-body-edge-fade min-h-0 overflow-y-auto overscroll-contain py-4",
				!flush && "px-5",
				className,
			)}
			style={{ maxHeight }}
		>
			{children}
		</div>
	);
}

export interface DialogSectionProps {
	children?: ReactNode;
	className?: string;
	/** Trailing control for the section header row (a link, a small button). */
	action?: ReactNode;
	/** Draw the separating hairline above this section. Default `true`; the
	 *  FIRST section of a body passes `false`.
	 *
	 *  Explicit rather than a `[&+&]` sibling selector because sections are
	 *  routinely wrapped — a disabled group, a conditional fragment — which
	 *  breaks adjacency and silently drops the rule exactly where the grouping
	 *  matters most. */
	divided?: boolean;
	/** Tiny uppercase group label, matching the settings tabs' section headers.
	 *  Omit for an unlabelled group whose rows already name themselves — a
	 *  heading that repeats its only row's label is noise. */
	label?: ReactNode;
}

/** One group inside a dialog body: an optional tiny uppercase heading, a
 *  separating hairline, and consistent vertical rhythm. Gives a dialog the same
 *  stacked-groups reading order the settings panels have, instead of one
 *  undifferentiated column of controls. */
export function DialogSection({
	action,
	children,
	className,
	divided = true,
	label,
}: DialogSectionProps) {
	return (
		<section
			className={cn(
				// The body already pads its own top/bottom edge, so an undivided
				// (first) section adds none of its own, and the last one drops its
				// trailing pad — otherwise the first and last groups sit noticeably
				// further from the rails than the rules between groups.
				"pb-4 last:pb-0",
				divided ? "border-divider border-t pt-4" : "pt-0",
				className,
			)}
		>
			{label ? (
				<div className="mb-2 flex min-h-6 items-center justify-between gap-3">
					{/* Same treatment as a boxed SettingSection's heading
					    (`SettingSection.tsx`), so a group inside a dialog and a group
					    inside a settings tab read as the same kind of thing. */}
					<h3 className="m-0 font-semibold text-2xs text-foreground-muted uppercase tracking-[0.11em]">
						{label}
					</h3>
					{action}
				</div>
			) : null}
			{children}
		</section>
	);
}

function flattenDialogActions(children: ReactNode): ReactNode[] {
	return Children.toArray(children).flatMap((child) => {
		if (
			isValidElement<{ children?: ReactNode }>(child) &&
			child.type === Fragment
		) {
			return flattenDialogActions(
				(child as ReactElement<{ children?: ReactNode }>).props.children,
			);
		}
		return [child];
	});
}

export interface DialogTitleProps {
	children?: ReactNode;
	className?: string;
}

export function DialogTitle({ children, className }: DialogTitleProps) {
	const alert = useAlertMode();
	const cls = cn(
		"m-0 font-sans font-semibold text-[1.0625rem] text-foreground leading-tight tracking-[-0.01em]",
		className,
	);
	if (alert) {
		return <AlertDialog.Title className={cls}>{children}</AlertDialog.Title>;
	}
	return <VanillaDialog.Title className={cls}>{children}</VanillaDialog.Title>;
}

type DescriptionRender = ComponentProps<
	typeof VanillaDialog.Description
>["render"];

export interface DialogDescriptionProps {
	children?: ReactNode;
	className?: string;
	/** Base UI render override — pass `render={<div />}` for ReactNode bodies so
	 *  block elements (lists, paragraphs) are legal inside the description. */
	render?: DescriptionRender;
}

export function DialogDescription({
	children,
	className,
	render,
}: DialogDescriptionProps) {
	const alert = useAlertMode();
	const cls = cn(
		"m-0 whitespace-pre-line font-sans text-body text-foreground-muted leading-relaxed",
		className,
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

export interface DialogActionButtonProps
	extends ComponentPropsWithoutRef<"button"> {
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
		accent:
			"bg-accent text-on-accent shadow-action-accent hover:bg-accent-hover hover:shadow-action-accent-hover",
		danger: "bg-error text-on-error shadow-elevated hover:bg-error/95",
	};
	const variantClass =
		variant === "neutral"
			? cn(
					surfaceBg(fill),
					"text-foreground-secondary ring-1 ring-divider ring-inset hover:text-foreground",
					surfaceHoverBg(hover),
				)
			: solidVariant[variant];
	return (
		<Button
			className={cn(
				"h-8 gap-1.5 rounded-lg px-3.5 font-medium text-body transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
				variantClass,
				className,
			)}
			{...rest}
		>
			{children}
		</Button>
	);
}
