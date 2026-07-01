"use client";

import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	QuantDeleteConfirmDialog,
	type PendingQuantDelete,
} from "../../ui/QuantDeleteConfirmDialog";

export type PendingDelete = PendingQuantDelete<OnnxQuantization>;

export interface DeleteQuantConfirmDialogProps {
	onCancel: () => void;
	onConfirm: () => void;
	pending: PendingDelete | null;
}

export function DeleteQuantConfirmDialog({
	pending,
	onCancel,
	onConfirm,
}: DeleteQuantConfirmDialogProps) {
	return (
		<QuantDeleteConfirmDialog
			descriptionKey="deleteQuantDescription"
			onCancel={onCancel}
			onConfirm={onConfirm}
			pending={pending}
		/>
	);
}
