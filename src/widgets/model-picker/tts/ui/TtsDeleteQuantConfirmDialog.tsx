"use client";

import {
	QuantDeleteConfirmDialog,
	type PendingQuantDelete,
} from "../../ui/QuantDeleteConfirmDialog";

export type TtsPendingDelete = PendingQuantDelete<string>;

export interface TtsDeleteQuantConfirmDialogProps {
	onCancel: () => void;
	onConfirm: () => void;
	pending: TtsPendingDelete | null;
}

export function TtsDeleteQuantConfirmDialog({
	pending,
	onCancel,
	onConfirm,
}: TtsDeleteQuantConfirmDialogProps) {
	return (
		<QuantDeleteConfirmDialog
			descriptionKey="deleteQuantDescriptionTts"
			onCancel={onCancel}
			onConfirm={onConfirm}
			pending={pending}
		/>
	);
}
