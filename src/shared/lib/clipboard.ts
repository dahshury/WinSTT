import { clipboardWriteText } from "@/shared/api/ipc-client";
import { fireAndForget } from "./fire-and-forget";

/**
 * Copy text to the clipboard, preferring the Web Clipboard API and falling
 * back to the Tauri IPC clipboard command when it is unavailable or rejects
 * (focus/permission quirks inside the WebView). Shared by the History
 * transcript copy and the Diagnostics issue copy so both behave identically.
 */
export function copyToClipboard(text: string): void {
	if (!text) {
		return;
	}
	const webClipboard = globalThis.navigator?.clipboard;
	if (webClipboard?.writeText) {
		webClipboard.writeText(text).catch(() => {
			fireAndForget(clipboardWriteText(text), "clipboard.ipcFallback");
		});
		return;
	}
	fireAndForget(clipboardWriteText(text), "clipboard.ipcFallback");
}

/** How long a "copied" checkmark stays lit after a clipboard write, in ms. */
export const COPY_FEEDBACK_MS = 1600;
