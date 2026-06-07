import type { ReactNode } from "react";
import { DialogActionButton, DialogClose } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";

export interface ConfirmDialogProps {
	cancelLabel?: string;
	confirmLabel?: string;
	/** Body copy. ReactNode (not just string) so callers can emphasize names
	 *  inline — e.g. the model-picker delete confirm bolds the model + quant. */
	description: ReactNode;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
}

export function ConfirmDialog({
	cancelLabel = "Cancel",
	confirmLabel = "Delete",
	description,
	onConfirm,
	onOpenChange,
	open,
	title,
}: ConfirmDialogProps) {
	return (
		<DialogShell
			description={description}
			onOpenChange={onOpenChange}
			open={open}
			title={title}
		>
			{/* Both footer buttons wrap in DialogClose so Base UI auto-closes via its
			    `close-press` reason — no manual `onOpenChange(false)`. The confirm
			    button additionally runs `onConfirm` before the close. */}
			<DialogClose
				render={
					<DialogActionButton variant="neutral">
						{cancelLabel}
					</DialogActionButton>
				}
			/>
			<DialogClose
				render={
					<DialogActionButton onClick={onConfirm} variant="danger">
						{confirmLabel}
					</DialogActionButton>
				}
			/>
		</DialogShell>
	);
}
