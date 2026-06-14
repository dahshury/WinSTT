import type { useQuantActions } from "@/features/model-download";
import type { useModelSwapController } from "@/features/swap-model";

type HandleDownloadAction = ReturnType<
	typeof useQuantActions
>["handleDownloadAction"];
type SwapController = ReturnType<typeof useModelSwapController>;

interface UseDownloadGatingArgs {
	controller: SwapController;
	handleDownloadAction: HandleDownloadAction;
}

interface DownloadGating {
	handleMainDownloadAction: HandleDownloadAction;
	handleRealtimeDownloadAction: HandleDownloadAction;
}

/**
 * Gates a precision-badge "download this variant" click so it opens the
 * confirmation dialog (size + hardware-fit + Download/Cancel) for the right
 * slot instead of silently starting a background fetch. Pause
 * / resume / cancel of an in-flight download still dispatch straight to the
 * server. Extracted verbatim from the panel.
 */
export function useDownloadGating({
	controller,
	handleDownloadAction,
}: UseDownloadGatingArgs): DownloadGating {
	const gateDownloadAction =
		(kind: "main" | "realtime"): HandleDownloadAction =>
		(action, modelId, quantization) => {
			if (action === "start") {
				controller.promptDownload(kind, modelId, quantization);
				return;
			}
			handleDownloadAction(action, modelId, quantization, kind);
		};
	return {
		handleMainDownloadAction: gateDownloadAction("main"),
		handleRealtimeDownloadAction: gateDownloadAction("realtime"),
	};
}
