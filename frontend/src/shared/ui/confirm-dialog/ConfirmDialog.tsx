"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

export interface ConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	confirmLabel?: string;
	cancelLabel?: string;
	onConfirm: () => void;
}

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = "Delete",
	cancelLabel = "Cancel",
	onConfirm,
}: ConfirmDialogProps) {
	const handleConfirm = () => {
		onConfirm();
		onOpenChange(false);
	};

	return (
		<AlertDialog.Root onOpenChange={onOpenChange} open={open}>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop
					className={`${dialogAnimation.backdrop} fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm`}
				/>
				<AlertDialog.Popup
					className={`${dialogAnimation.popup} fixed top-1/2 left-1/2 z-[301] flex w-[360px] flex-col gap-4 rounded-xl border border-border bg-surface-secondary p-6 outline-none`}
				>
					<AlertDialog.Title className="m-0 font-sans font-semibold text-[15px] text-foreground">
						{title}
					</AlertDialog.Title>
					<AlertDialog.Description className="m-0 font-sans text-[13px] text-foreground-muted leading-relaxed">
						{description}
					</AlertDialog.Description>
					<div className="mt-1 flex justify-end gap-2">
						<AlertDialog.Close
							render={
								<button
									className="inline-flex h-8 cursor-pointer items-center justify-center rounded-md border border-border bg-surface-tertiary px-4 font-medium text-[13px] text-foreground-secondary outline-none transition-colors duration-150 hover:bg-surface-elevated"
									type="button"
								>
									{cancelLabel}
								</button>
							}
						/>
						<button
							className="inline-flex h-8 cursor-pointer items-center justify-center rounded-md border-none bg-error px-4 font-medium text-[13px] text-white outline-none transition-colors duration-150 hover:bg-error-dim"
							onClick={handleConfirm}
							type="button"
						>
							{confirmLabel}
						</button>
					</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}
