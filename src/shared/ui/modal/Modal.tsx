import type { ReactNode } from "react";
import { SurfaceProvider } from "@/shared/lib/surface";
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
 *  Resets the surface baseline to 1 BEFORE `DialogContent` derives the popup
 *  level (substrate + 4 → surface-5). Without this, a modal opened from a deeply
 *  nested substrate (e.g. the custom-modifier dialog launched from inside the
 *  LLM Playground's preset list) inherits a high substrate, clamps flat at
 *  surface-8, and loses the popup → cards → inputs elevation ramp — so its
 *  contents read as a single flat slab instead of matching the rest of the app's
 *  dialogs. Pinning the baseline gives every free-form modal the same ramp
 *  regardless of how deep the opener sat. */
export function Modal({ children, isOpen, onClose }: ModalProps) {
	return (
		<SurfaceProvider value={1}>
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
		</SurfaceProvider>
	);
}
