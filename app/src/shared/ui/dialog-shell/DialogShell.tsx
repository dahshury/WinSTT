import type { ReactNode } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@/shared/ui/dialog";

export interface DialogShellProps {
	/** Optional rich body rendered BETWEEN the description and the footer —
	 *  progress bars, info cards, warnings. Simple confirm/opt-in dialogs omit
	 *  it; richer ones (the model-download dialog) slot their phase UI here. */
	body?: ReactNode;
	/** Footer row — typically two buttons. Caller owns wiring (close vs explicit handlers). */
	children: ReactNode;
	/** Dialog body. Strings render fine; ReactNode bodies render inside a <div> so block
	 *  elements (lists, paragraphs) are legal. `whitespace-pre-line` preserves `\n` for
	 *  string bodies without affecting node bodies. */
	description: ReactNode;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
	/** Pixel width of the popup. Caps at 90vw so narrow viewports stay readable. */
	width?: number;
}

/** Shared confirm/dialog skeleton — title + description (+ optional body) + footer
 *  on the app's standard alert-dialog chrome. The single source of the
 *  confirm / opt-in look: `ConfirmDialog`, `OptInDialog`, the model-picker delete
 *  confirm, and the model-download dialog all render through it, so they share one
 *  surface, radius, padding, typography, backdrop, and `z-confirm` stacking.
 *
 *  A thin wrapper over the shared {@link Dialog} primitive in `alert` mode
 *  (AlertDialog semantics: `role="alertdialog"`, focus-trap, Esc dismiss). Callers
 *  differ only in width, body content, button colors, and escape-key behavior —
 *  all kept caller-side. */
export function DialogShell({
	body,
	children,
	description,
	onOpenChange,
	open,
	title,
	width = 360,
}: DialogShellProps) {
	return (
		<Dialog alert onOpenChange={onOpenChange} open={open}>
			<DialogContent width={width}>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription render={<div />}>{description}</DialogDescription>
				{body}
				<DialogFooter className="mt-1">{children}</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
