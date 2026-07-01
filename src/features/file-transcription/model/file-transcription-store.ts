import { create } from "zustand";
import type { FileQueueItem } from "@/shared/api/ipc-client";

/**
 * Renderer-side projection of the file-transcription queue. The Rust backend
 * owns the authoritative queue (ordering, sequential dispatch, the
 * shared STT model); this store just mirrors it for display:
 *
 *  - `items`        full queue snapshot, replaced on every structural change
 *                   (`file:queue-update`).
 *  - `patchProgress` lightweight in-place update for the high-frequency
 *                   per-chunk progress ticks (`file:queue-progress`).
 *  - `queueActive`  cross-window flag (`file:queue-active`) so any window —
 *                   notably the detached model-picker — can disable model
 *                   switching while the queue is busy.
 */
interface FileTranscriptionStore {
	items: FileQueueItem[];
	patchProgress: (id: string, progress: number, stage: string) => void;
	queueActive: boolean;
	reset: () => void;
	setItems: (items: FileQueueItem[]) => void;
	setQueueActive: (active: boolean) => void;
}

export const useFileTranscriptionStore = create<FileTranscriptionStore>()(
	(set) => ({
		items: [],
		queueActive: false,
		setItems: (items) => set({ items }),
		patchProgress: (id, progress, stage) =>
			set((state) => ({
				items: state.items.map((item) =>
					item.id === id ? { ...item, progress, stage } : item,
				),
			})),
		setQueueActive: (active) => set({ queueActive: active }),
		reset: () => set({ items: [], queueActive: false }),
	}),
);
