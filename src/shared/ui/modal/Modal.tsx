import type { ReactNode } from "react";
import { Dialog, DialogContent } from "@/shared/ui/dialog";

export interface ModalProps {
	children: ReactNode;
	isOpen: boolean;
	onClose: () => void;
}

/** Free-form modal — the content owns its own width, padding, and layout (the
 *  model picker, LLM panels, …). A thin wrapper over the shared {@link Dialog}
 *  primitive in its `fluid`, unpadded mode: content-driven size, `overflow-hidden`
 *  rounded popup, `z-modal` stacking. Shares one popup-chrome / animation /
 *  surface path with every other dialog in the app.
 *
 *  No surface reset needed: `DialogContent` pins every popup to
 *  `DIALOG_SURFACE_LEVEL`, so a modal opened from a deeply nested substrate
 *  (e.g. the custom-modifier dialog launched from inside the profile editor)
 *  gets the same popup → cards → inputs ramp as one opened from the page root,
 *  instead of clamping flat at surface-8 and reading as a single slab. */
export function Modal({ children, isOpen, onClose }: ModalProps) {
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			open={isOpen}
		>
			<DialogContent
				className="overflow-hidden overscroll-contain"
				fluid
				padded={false}
			>
				{children}
			</DialogContent>
		</Dialog>
	);
}
