"use client";

import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

export interface TtsPendingDelete {
	displayName: string;
	modelId: string;
	quantization: string;
	quantLabel: string;
}

export interface TtsDeleteQuantConfirmDialogProps {
	onCancel: () => void;
	onConfirm: () => void;
	pending: TtsPendingDelete | null;
}

/** Destructive confirmation rendered at the selector level (not inside the
 *  Combobox.Item) so Base UI's combobox dismiss + focus-trap don't fight the
 *  alert dialog. Mirrors the STT `DeleteQuantConfirmDialog`. */
export function TtsDeleteQuantConfirmDialog({
	pending,
	onCancel,
	onConfirm,
}: TtsDeleteQuantConfirmDialogProps) {
	return (
		<ConfirmDialog
			confirmLabel="Delete"
			description={
				<>
					This removes the on-disk{" "}
					<span className="font-medium text-foreground">{pending?.quantLabel}</span> weights for{" "}
					<span className="font-medium text-foreground">{pending?.displayName}</span>. Other
					precisions of the same model stay cached. You can re-download this variant anytime from
					the picker.
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
