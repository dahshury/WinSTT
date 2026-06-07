"use client";

import type { OnnxQuantization } from "@/shared/config/defaults";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

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

/** Destructive confirmation rendered at the selector level (not inside the
 *  Combobox.Item) so Base UI's combobox dismiss + focus-trap rules don't fight
 *  the alert dialog's own focus management.
 *
 *  Uses the shared {@link ConfirmDialog} (→ {@link DialogShell}) so it matches
 *  every other confirm/dialog in the app — same surface, radius, padding,
 *  typography, backdrop, and the z-confirm tier (1300/1301, intentionally above
 *  z-popover/1100 where the Combobox renders, so the dialog never hides behind
 *  the open picker). AlertDialog under the hood keeps the destructive-confirm
 *  a11y semantics (``role="alertdialog"``, Esc dismiss, focus-trap, restore). */
export function DeleteQuantConfirmDialog({
	pending,
	onCancel,
	onConfirm,
}: DeleteQuantConfirmDialogProps) {
	return (
		<ConfirmDialog
			confirmLabel="Delete"
			description={
				<>
					This removes the on-disk{" "}
					<span className="font-medium text-foreground">
						{pending?.quantLabel}
					</span>{" "}
					weights for{" "}
					<span className="font-medium text-foreground">
						{pending?.displayName}
					</span>
					. Other quantizations of the same model stay cached. You can
					re-download this variant anytime from the picker.
				</>
			}
			onConfirm={onConfirm}
			onOpenChange={(next) => {
				if (!next) {
					onCancel();
				}
			}}
			open={pending !== null}
			title={`Delete ${pending?.quantLabel ?? "this"} weights?`}
		/>
	);
}
