import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { SurfaceProvider, surfaceClasses, useSurface } from "@/shared/lib/surface";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

export interface ModalProps {
	children: ReactNode;
	isOpen: boolean;
	onClose: () => void;
}

export function Modal({ isOpen, onClose, children }: ModalProps) {
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 4, 8);
	const popupShadow = Math.max(popupLevel, 7);
	return (
		<Dialog.Root
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			open={isOpen}
		>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={`${dialogAnimation.backdrop} fixed inset-0 z-modal-backdrop bg-black/60 backdrop-blur-sm`}
				/>
				<SurfaceProvider value={popupLevel}>
					<Dialog.Popup
						className={`${dialogAnimation.popup} fixed top-1/2 left-1/2 z-modal overflow-hidden overscroll-contain rounded-xl ${surfaceClasses(popupLevel, popupShadow)} outline-none`}
					>
						{children}
					</Dialog.Popup>
				</SurfaceProvider>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
