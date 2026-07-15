import {
	commands,
	type SttModelLifecyclePhase,
	type SttModelLifecycleSnapshot,
} from "@/bindings";
import { NATIVE_EVENTS as IPC } from "../native-events";
import { onCast } from "../native-boundary";

export type { SttModelLifecyclePhase, SttModelLifecycleSnapshot };

/** Canonical revisioned acquisition/activation snapshot. Consumers must ignore older revisions. */
export const onSttModelLifecycle = (
	callback: (snapshot: SttModelLifecycleSnapshot) => void,
) => onCast(IPC.STT_MODEL_LIFECYCLE, callback);

/** Hydrates a newly opened window before its live subscription begins receiving updates. */
export const fetchSttModelLifecycleSnapshots = () =>
	commands.sttModelLifecycleSnapshots();

export const cancelModelDownloadQuant = async (
	modelId: string,
	quantization: string,
): Promise<void> => {
	const result = await commands.downloadCancelQuant(modelId, quantization);
	if (result.status === "error") {
		throw result.error;
	}
};
