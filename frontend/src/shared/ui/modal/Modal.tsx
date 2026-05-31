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
 *  surface path with every other dialog in the app. */
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
			<DialogContent className="overflow-hidden overscroll-contain" fluid padded={false}>
				{children}
			</DialogContent>
		</Dialog>
	);
}
