"use client";

import { useTranslations } from "use-intl";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

type DeleteDescriptionKey =
	| "deleteQuantDescription"
	| "deleteQuantDescriptionTts";

export interface PendingQuantDelete<TQuantization = string> {
	displayName: string;
	modelId: string;
	quantization: TQuantization;
	quantLabel: string;
}

export interface QuantDeleteConfirmDialogProps<TQuantization = string> {
	descriptionKey: DeleteDescriptionKey;
	onCancel: () => void;
	onConfirm: () => void;
	pending: PendingQuantDelete<TQuantization> | null;
}

export function QuantDeleteConfirmDialog<TQuantization>({
	descriptionKey,
	pending,
	onCancel,
	onConfirm,
}: QuantDeleteConfirmDialogProps<TQuantization>) {
	const t = useTranslations("modelPicker");
	return (
		<ConfirmDialog
			confirmLabel={t("delete")}
			description={t.rich(descriptionKey, {
				quant: pending?.quantLabel ?? "",
				name: pending?.displayName ?? "",
				strong: (chunks) => (
					<span className="font-medium text-foreground">{chunks}</span>
				),
			})}
			onConfirm={onConfirm}
			onOpenChange={(next) => {
				if (!next) {
					onCancel();
				}
			}}
			open={pending !== null}
			title={t("deleteQuantTitle", {
				quant: pending?.quantLabel ?? t("thisQuantFallback"),
			})}
		/>
	);
}
