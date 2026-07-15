import { useModelSwapStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import {
	nextSttSwitchRequestId,
	requestSttModelSwitch,
} from "@/shared/api/ipc-client";

/** Move cloud STT back to a cached local model through the backend-owned atomic
 * transaction. No renderer settings write races the load or claims success early. */
export function revertSttToLocalAtomic(
	currentCloudModel: string,
	targetModel: string,
): void {
	const modelSettings = useSettingsStore.getState().settings.model;
	const requestId = nextSttSwitchRequestId("auto-revert");
	useModelSwapStore
		.getState()
		.beginSwap("main", currentCloudModel, targetModel, null, requestId);
	void requestSttModelSwitch({
		kind: "main",
		modelId: targetModel,
		quantization: modelSettings?.onnxQuantization ?? "",
		device: modelSettings?.device ?? "auto",
		realtimeModel: modelSettings?.realtimeModel ?? "",
		requestId,
		forceReload: false,
	})
		.then((result) => {
			if (result.status !== "completed") {
				useModelSwapStore.getState().clear("main", result.requestId);
			}
		})
		.catch((error: unknown) => {
			console.error("Atomic local STT fallback failed", error);
			useModelSwapStore.getState().clear("main", requestId);
		});
}
