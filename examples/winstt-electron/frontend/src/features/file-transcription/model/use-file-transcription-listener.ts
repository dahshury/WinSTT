import { useEffect } from "react";
import { onFileQueueActive, onFileQueueProgress, onFileQueueUpdate } from "@/shared/api/ipc-client";
import { useFileTranscriptionStore } from "./file-transcription-store";

/**
 * Wires the file-transcription queue IPC events into the store. Mounted once at
 * app bootstrap (every window) via {@link IpcProvider}. The three streams:
 *  - queue-update  → replace the whole list (structural changes)
 *  - queue-progress → patch one row's progress (high-frequency ticks)
 *  - queue-active  → cross-window busy flag (model-swap gating)
 */
export function useFileTranscriptionListener(): void {
	const setItems = useFileTranscriptionStore((s) => s.setItems);
	const patchProgress = useFileTranscriptionStore((s) => s.patchProgress);
	const setQueueActive = useFileTranscriptionStore((s) => s.setQueueActive);

	useEffect(() => onFileQueueUpdate((data) => setItems(data.items)), [setItems]);

	useEffect(
		() => onFileQueueProgress((data) => patchProgress(data.id, data.progress, data.stage)),
		[patchProgress]
	);

	useEffect(() => onFileQueueActive((data) => setQueueActive(data.active)), [setQueueActive]);
}
