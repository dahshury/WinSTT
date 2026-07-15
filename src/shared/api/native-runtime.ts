import { listen } from "@tauri-apps/api/event";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import { wireDragDrop } from "./adapter/drag-drop";
import { checkAndDownloadUpdate } from "./adapter/updater";

export interface AppProfileActivePayload {
	ruleId: string;
	configurationId: string;
	configurationName: string;
	appExe: string;
}

let initialized = false;

/** Initialize native side-effects shared by every renderer window. */
export function initializeNativeRuntime(): void {
	if (initialized || !hasTauriRuntime()) {
		return;
	}
	initialized = true;
	void wireDragDrop();
	void listen("updater:check", () => {
		void checkAndDownloadUpdate();
	}).catch((error) => {
		console.warn("[updater] failed to subscribe to update checks:", error);
	});
}

export function listenForAppProfileActive(
	handler: (payload: AppProfileActivePayload) => void,
): () => void {
	if (!hasTauriRuntime()) {
		return () => undefined;
	}
	const pending = listen<AppProfileActivePayload>(
		"llm:app-profile-active",
		(event) => handler(event.payload),
	);
	void pending.catch((error) => {
		console.warn("[events] failed to subscribe to app profile changes:", error);
	});
	return () => {
		void pending.then((unlisten) => unlisten()).catch(() => undefined);
	};
}
