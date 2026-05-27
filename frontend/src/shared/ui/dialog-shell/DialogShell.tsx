import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactNode } from "react";
import { SurfaceProvider, surfaceClasses, useSurface } from "@/shared/lib/surface";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

export interface DialogShellProps {
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

/** Shared `AlertDialog` skeleton — backdrop + portal + surface-aware popup + title +
 *  description. Used by `ConfirmDialog` and `OptInDialog`; the two callers differ only
 *  in width, body type, button colors, and escape-key behavior — all kept caller-side. */
export function DialogShell({
	open,
	onOpenChange,
	title,
	description,
	children,
	width = 360,
}: DialogShellProps) {
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 4, 8);
	const popupShadow = Math.max(popupLevel, 7);
	return (
		<AlertDialog.Root onOpenChange={onOpenChange} open={open}>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop
					className={`${dialogAnimation.backdrop} fixed inset-0 z-confirm-backdrop bg-black/60 backdrop-blur-sm`}
				/>
				<SurfaceProvider value={popupLevel}>
					<AlertDialog.Popup
						className={`${dialogAnimation.popup} fixed top-1/2 left-1/2 z-confirm flex max-w-[90vw] flex-col gap-4 rounded-xl ${surfaceClasses(popupLevel, popupShadow)} p-6 outline-none`}
						style={{ width }}
					>
						<AlertDialog.Title className="m-0 font-sans font-semibold text-[15px] text-foreground">
							{title}
						</AlertDialog.Title>
						<AlertDialog.Description
							className="m-0 whitespace-pre-line font-sans text-body text-foreground-muted leading-relaxed"
							render={<div />}
						>
							{description}
						</AlertDialog.Description>
						<div className="mt-1 flex justify-end gap-2">{children}</div>
					</AlertDialog.Popup>
				</SurfaceProvider>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}
