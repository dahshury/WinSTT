"use client";

import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

export interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	children: ReactNode;
}

export function Modal({ isOpen, onClose, children }: ModalProps) {
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
					className={`${dialogAnimation.backdrop} fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm`}
				/>
				<Dialog.Popup
					className={`${dialogAnimation.popup} fixed top-1/2 left-1/2 z-[101] overflow-hidden overscroll-contain rounded-xl border border-border bg-surface-secondary outline-none`}
				>
					{children}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
