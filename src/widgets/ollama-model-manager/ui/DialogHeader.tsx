import { DialogHeader as SharedDialogHeader } from "@/shared/ui/dialog";
import type { TranslateFn } from "./types";

export interface DialogHeaderProps {
	onClose: () => void;
	t: TranslateFn;
	tc: TranslateFn;
}

export function DialogHeader({ t, tc, onClose }: DialogHeaderProps) {
	return (
		<SharedDialogHeader
			closeLabel={tc("close")}
			description={t("manageModelsDescription")}
			onClose={onClose}
			title={t("manageModelsTitle")}
		/>
	);
}
