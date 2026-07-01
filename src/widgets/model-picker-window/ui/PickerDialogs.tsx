import type { ReactNode } from "react";
import type { useTranslations } from "use-intl";
import type {
	ModelStatesById as StatesById,
	ModelSystemInfo as SystemInfo,
} from "@/entities/model-catalog";
import {
	DownloadConfirmationDialog,
	type DownloadConfirmationDialogProps,
} from "@/features/model-download";
import type { SwapController } from "@/features/swap-model";
import { ResourceWarningDialog } from "@/shared/ui/resource-warning-dialog";

type GetModel = DownloadConfirmationDialogProps["getModel"];
type ModelT = ReturnType<typeof useTranslations<"model">>;

interface PickerDialogsProps {
	controller: SwapController;
	getModel: GetModel;
	statesById: StatesById;
	systemInfo: SystemInfo;
	tModel: ModelT;
}

/**
 * The download-confirmation and resource-warning dialogs for the model picker
 * window. Both are driven entirely by the swap controller, so they live in a
 * sibling component to keep `ModelPickerWindow` focused on its picker body.
 */
export function PickerDialogs({
	controller,
	getModel,
	statesById,
	systemInfo,
	tModel,
}: PickerDialogsProps): ReactNode {
	return (
		<>
			<DownloadConfirmationDialog
				getModel={getModel}
				onCancel={controller.cancelPendingDownload}
				pending={controller.pendingDownload}
				statesById={statesById}
				systemInfo={systemInfo}
			/>
			<ResourceWarningDialog
				assessment={controller.pendingFitWarning?.assessment ?? null}
				cancelLabel={tModel("resourceWarning.cancel")}
				candidateName={controller.pendingFitWarning?.candidateName ?? ""}
				confirmLabel={tModel("resourceWarning.proceedAnyway")}
				kind="dictation"
				onCancel={() => controller.setPendingFitWarning(null)}
				onConfirm={() => {
					const next = controller.pendingFitWarning?.next;
					controller.setPendingFitWarning(null);
					if (next) {
						next();
					}
				}}
				onOpenChange={(open) => {
					if (!open) {
						controller.setPendingFitWarning(null);
					}
				}}
				open={controller.pendingFitWarning !== null}
				t={(key, vars) =>
					tModel(`resourceWarning.${key}` as Parameters<typeof tModel>[0], vars)
				}
			/>
		</>
	);
}
