"use client";

import { useTranslations } from "use-intl";
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
	const t = useTranslations("modelPicker");
	return (
		<ConfirmDialog
			confirmLabel={t("delete")}
			description={t.rich("deleteQuantDescriptionTts", {
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
