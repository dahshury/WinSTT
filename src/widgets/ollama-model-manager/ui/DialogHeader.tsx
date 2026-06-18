import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DialogDescription, DialogTitle } from "@/shared/ui/dialog";
import { IconButton } from "@/shared/ui/icon-button";
import type { TranslateFn } from "./types";

export interface DialogHeaderProps {
	onClose: () => void;
	t: TranslateFn;
	tc: TranslateFn;
}

export function DialogHeader({ t, tc, onClose }: DialogHeaderProps) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0 flex-1">
				<DialogTitle>{t("manageModelsTitle")}</DialogTitle>
				<DialogDescription className="mt-1">
					{t("manageModelsDescription")}
				</DialogDescription>
			</div>
			<IconButton
				aria-label={tc("close")}
				className="shrink-0"
				icon={<HugeiconsIcon icon={Cancel01Icon} size={14} />}
				onClick={onClose}
			/>
		</div>
	);
}
