import type { BrowserWindow } from "electron";
import { screen } from "electron";
import { getStoreValue, store } from "../lib/store";

let overlayWindow: BrowserWindow | null = null;

/**
 * Store reference to the overlay window
 */
export function setOverlayWindow(win: BrowserWindow): void {
	overlayWindow = win;
}

/**
 * Show the overlay window with position and settings checks
 */
export function showOverlay(): void {
	if (!overlayWindow) {
		return;
	}

	const enabled = getStoreValue("general.showRecordingOverlay");
	const recordingMode = getStoreValue("general.recordingMode");

	// Only show in PTT/toggle modes when setting is enabled
	if (!enabled || recordingMode === "listen") {
		return;
	}

	// Reposition on primary display (handle multi-monitor)
	const primaryDisplay = screen.getPrimaryDisplay();
	const { width, height } = primaryDisplay.workAreaSize;
	const [winWidth = 800, winHeight = 120] = overlayWindow.getSize();
	const x = Math.round((width - winWidth) / 2);
	const y = Math.round(height - winHeight - 60); // 60px from bottom

	overlayWindow.setPosition(x, y);
	overlayWindow.showInactive(); // Show without stealing focus
}

/**
 * Hide the overlay window
 */
export function hideOverlay(): void {
	if (!overlayWindow) {
		return;
	}

	overlayWindow.hide();
}

/**
 * Setup overlay handlers for settings changes.
 * Returns a cleanup function that removes the store watchers.
 */
export function setupOverlayHandlers(): () => void {
	// Listen to settings changes and hide overlay if disabled
	const disposeOverlaySetting = store.onDidChange("general.showRecordingOverlay", (newValue) => {
		if (!newValue) {
			hideOverlay();
		}
	});

	// Hide overlay when switching to listen mode
	const disposeModeSetting = store.onDidChange("general.recordingMode", (newValue) => {
		if (newValue === "listen") {
			hideOverlay();
		}
	});

	return () => {
		disposeOverlaySetting();
		disposeModeSetting();
	};
}
