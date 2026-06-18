export const FILE_DRAG_DROP_EVENT = "winstt:file-drag-drop";

export type FileDragDropType = "enter" | "over" | "drop" | "leave";

export interface FileDragDropPayload {
	type: FileDragDropType;
	paths: string[];
}

export function emitFileDragDropEvent(payload: FileDragDropPayload): void {
	if (typeof window === "undefined") {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<FileDragDropPayload>(FILE_DRAG_DROP_EVENT, {
			detail: payload,
		}),
	);
}

export function fileDragDropPayloadFromEvent(
	event: Event,
): FileDragDropPayload | null {
	if (!(event instanceof CustomEvent)) {
		return null;
	}
	const detail = event.detail as Partial<FileDragDropPayload> | undefined;
	if (
		detail === undefined ||
		(detail.type !== "enter" &&
			detail.type !== "over" &&
			detail.type !== "drop" &&
			detail.type !== "leave") ||
		!Array.isArray(detail.paths)
	) {
		return null;
	}
	return { type: detail.type, paths: detail.paths };
}
