import { useSyncExternalStore } from "react";
import { ipcOn } from "./native-boundary";
import { NATIVE_EVENTS } from "./native-events";

// This state belongs to the window that opened the detached picker. The picker
// window itself keeps its own tooltips available.
let open = false;
const listeners = new Set<() => void>();
let stopListening: (() => void) | undefined;

export function setModelPickerWindowOpen(next: boolean): void {
	if (open === next) {
		return;
	}
	open = next;
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		stopListening = ipcOn(NATIVE_EVENTS.MODEL_PICKER_CLOSING, () => {
			setModelPickerWindowOpen(false);
		});
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			stopListening?.();
			stopListening = undefined;
		}
	};
}

export function useModelPickerWindowOpen(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => open,
		() => false,
	);
}
