"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactNode } from "react";
import { Button } from "@/shared/ui/button";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

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
 * One-shot opt-in confirmation dialog. Differs from ConfirmDialog in two
 * ways:
 *   - The body accepts multi-line ReactNode (warning text usually wraps
 *     across multiple paragraphs).
 *   - The confirm button is the brand-accent action (not the destructive
 *     red); the user is consenting to a feature, not deleting anything.
 *   - Closing via Escape / backdrop click is treated as cancel, not
 *     confirm — flipping the toggle back to off requires an explicit
 *     button press.
 */
export function OptInDialog({
	open,
	onOpenChange,
	title,
	body,
	confirmLabel,
	cancelLabel,
	onConfirm,
	onCancel,
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
		<AlertDialog.Root
			onOpenChange={(next) => {
				if (next) {
					onOpenChange(true);
				} else {
					handleCancel();
				}
			}}
			open={open}
		>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop
					className={`${dialogAnimation.backdrop} fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm`}
				/>
				<AlertDialog.Popup
					className={`${dialogAnimation.popup} fixed top-1/2 left-1/2 z-[301] flex w-[460px] max-w-[90vw] flex-col gap-4 rounded-xl border border-border bg-surface-secondary p-6 outline-none`}
				>
					<AlertDialog.Title className="m-0 font-sans font-semibold text-[15px] text-foreground">
						{title}
					</AlertDialog.Title>
					<AlertDialog.Description
						className="m-0 whitespace-pre-line font-sans text-body text-foreground-muted leading-relaxed"
						render={<div />}
					>
						{body}
					</AlertDialog.Description>
					<div className="mt-1 flex justify-end gap-2">
						<Button
							className="h-8 rounded-md border border-border bg-surface-tertiary px-4 font-medium text-body text-foreground-secondary transition-colors duration-150 hover:bg-surface-elevated"
							onClick={handleCancel}
						>
							{cancelLabel}
						</Button>
						<Button
							className="h-8 rounded-md bg-accent px-4 font-medium text-body text-white transition-colors duration-150 hover:bg-accent-dim"
							onClick={handleConfirm}
						>
							{confirmLabel}
						</Button>
					</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}
