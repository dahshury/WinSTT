import { commands } from "@/bindings";

/**
 * Show the tray-indicator pill anchored over the notification-area corner.
 * Returns `false` when the backend suppressed it (the settings window is
 * focused), so the renderer can skip the enter animation.
 */
export async function trayIndicatorShow(): Promise<boolean> {
	const result = await commands.trayIndicatorShow();
	return result.status === "error" ? false : result.data;
}

/** Hide the pill (called after its exit animation completes). */
export async function trayIndicatorHide(): Promise<void> {
	await commands.trayIndicatorHide();
}
