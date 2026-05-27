"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { dialogAnimation } from "@/shared/ui/dialog-animation";

export interface PendingDelete {
	displayName: string;
	modelId: string;
	quantization: OnnxQuantization;
	quantLabel: string;
}

export interface DeleteQuantConfirmDialogProps {
	onCancel: () => void;
	onConfirm: () => void;
	pending: PendingDelete | null;
}

/** Destructive confirmation rendered at the selector level (not inside
 *  the Combobox.Item) so Base UI's combobox dismiss + focus-trap rules
 *  don't fight the alert dialog's own focus management. Uses Base UI's
 *  AlertDialog for the correct a11y semantics (``role="alertdialog"``,
 *  Esc dismiss, focus-trap, restore focus on close). */
export function DeleteQuantConfirmDialog({
	pending,
	onCancel,
	onConfirm,
}: DeleteQuantConfirmDialogProps) {
	const open = pending !== null;
	return (
		<AlertDialog.Root
			onOpenChange={(next) => {
				if (!next) {
					onCancel();
				}
			}}
			open={open}
		>
			<AlertDialog.Portal>
				{/* z-confirm-backdrop / z-confirm (1300/1301) — the dedicated
				    destructive-confirm tier, intentionally above z-popover
				    (1100) where the Combobox renders. The earlier
				    z-overlay/z-modal pair (20/1001) put the dialog UNDER
				    the open picker. See shared/config/z-index.ts. */}
				<AlertDialog.Backdrop
					className={`${dialogAnimation.backdrop} fixed inset-0 z-confirm-backdrop bg-black/55 backdrop-blur-[1px]`}
				/>
				<AlertDialog.Popup
					className={`${dialogAnimation.popup} fixed top-1/2 left-1/2 z-confirm w-[min(420px,90vw)] rounded-lg border border-border bg-surface-elevated p-4 text-foreground shadow-xl outline-none`}
				>
					<AlertDialog.Title className="font-semibold text-base">
						Delete {pending?.quantLabel ?? "this"} weights?
					</AlertDialog.Title>
					<AlertDialog.Description className="mt-1 text-foreground-secondary text-sm">
						This removes the on-disk{" "}
						<span className="font-medium text-foreground">{pending?.quantLabel}</span> weights for{" "}
						<span className="font-medium text-foreground">{pending?.displayName}</span>. Other
						quantizations of the same model stay cached. You can re-download this variant anytime
						from the picker.
					</AlertDialog.Description>
					<div className="mt-4 flex items-center justify-end gap-2">
						<AlertDialog.Close
							render={
								<button
									className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-surface-secondary px-3 font-medium text-foreground text-sm transition-colors hover:bg-surface-hover"
									type="button"
								>
									Cancel
								</button>
							}
						/>
						<button
							className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-error px-3 font-medium text-sm text-white transition-colors hover:bg-error/90"
							onClick={onConfirm}
							type="button"
						>
							Delete
						</button>
					</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}
