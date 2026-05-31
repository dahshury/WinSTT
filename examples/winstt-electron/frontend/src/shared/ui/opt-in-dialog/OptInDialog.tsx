import type { ReactNode } from "react";
import { DialogActionButton } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";

export interface OptInDialogProps {
	body: ReactNode;
	cancelLabel: string;
	confirmLabel: string;
	onCancel: () => void;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
}

/**
 * One-shot opt-in confirmation dialog. Differs from ConfirmDialog in three
 * ways:
 *   - The body accepts multi-line ReactNode (warning text usually wraps
 *     across multiple paragraphs).
 *   - The confirm button is the brand-accent action (not the destructive
 *     red); the user is consenting to a feature, not deleting anything.
 *   - Closing via Escape / backdrop click is treated as cancel, not
 *     confirm — flipping the toggle back to off requires an explicit
 *     button press. So the buttons drive their handlers directly rather
 *     than wrapping in DialogClose.
 */
export function OptInDialog({
	body,
	cancelLabel,
	confirmLabel,
	onCancel,
	onConfirm,
	onOpenChange,
	open,
	title,
}: OptInDialogProps) {
	const handleConfirm = () => {
		onConfirm();
		onOpenChange(false);
	};

	const handleCancel = () => {
		onCancel();
		onOpenChange(false);
	};

	return (
		<DialogShell
			description={body}
			onOpenChange={(next) => {
				if (next) {
					onOpenChange(true);
				} else {
					handleCancel();
				}
			}}
			open={open}
			title={title}
			width={460}
		>
			<DialogActionButton onClick={handleCancel} variant="neutral">
				{cancelLabel}
			</DialogActionButton>
			<DialogActionButton onClick={handleConfirm} variant="accent">
				{confirmLabel}
			</DialogActionButton>
		</DialogShell>
	);
}
