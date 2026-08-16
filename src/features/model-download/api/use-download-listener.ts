import { useEffect } from "react";
import {
	fetchSttModelLifecycleSnapshots,
	hasNativeRuntime,
	onModelDownloadComplete,
	onModelDownloadProgress,
	onModelDownloadStart,
	onSttModelLifecycle,
} from "@/shared/api/ipc-client";
import { useDownloadStore } from "../model/download-store";

/**
 * Projects backend-owned download/activation snapshots into renderer state.
 *
 * Per-quant state has exactly one authority: `stt:model-lifecycle`. The older download events are
 * retained only for the no-quantization whole-model path while that legacy backend flow exists.
 * Subscription is installed before hydration; revision checks make a late snapshot response unable
 * to overwrite a newer live event.
 */
export function useDownloadListener(): void {
	const applyLifecycleSnapshot = useDownloadStore(
		(state) => state.applyLifecycleSnapshot,
	);
	const setDownloadStart = useDownloadStore((state) => state.setDownloadStart);
	const setDownloadProgress = useDownloadStore(
		(state) => state.setDownloadProgress,
	);
	const setDownloadComplete = useDownloadStore(
		(state) => state.setDownloadComplete,
	);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		const offLifecycle = onSttModelLifecycle(applyLifecycleSnapshot);
		void fetchSttModelLifecycleSnapshots()
			.then((snapshots) => {
				if (!disposed && Array.isArray(snapshots)) {
					for (const snapshot of snapshots) {
						applyLifecycleSnapshot(snapshot);
					}
				}
			})
			.catch((error) =>
				console.error("STT model lifecycle hydration failed", error),
			);

		const offStart = onModelDownloadStart((model, quantization) => {
			if (quantization === undefined) {
				setDownloadStart(model);
			}
		});
		const offProgress = onModelDownloadProgress((payload) => {
			if (payload.quantization === undefined) {
				setDownloadProgress(payload);
			}
		});
		const offComplete = onModelDownloadComplete(
			(_model, cancelled, quantization) => {
				if (quantization === undefined) {
					setDownloadComplete(cancelled);
				}
			},
		);

		return () => {
			disposed = true;
			offLifecycle();
			offStart();
			offProgress();
			offComplete();
		};
	}, [
		applyLifecycleSnapshot,
		setDownloadStart,
		setDownloadProgress,
		setDownloadComplete,
	]);
}
