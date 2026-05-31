import { readFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { buildSplashHtml } from "./splash-html";

// In-app splash window shown the instant Electron is ready and kept up until
// the real main window paints.
//
// Why this exists (not the electron-builder `portable.splashImage`): the NSIS
// portable splash BMP is only drawn by the self-extracting stub WHILE it
// unpacks the payload — i.e. before Electron even launches. We set
// `portable.unpackDirName` (a stable extraction dir), so every launch after the
// first skips extraction entirely and that BMP just flashes for a frame and
// vanishes. It also can't span the part that actually takes time here: Electron
// boot + the Vite renderer's first paint + the 5–8 s Python STT-server warmup
// the main window deliberately waits on (`show: false` until `server-ready`).
// The portable splashImage is a long-standing, extraction-only, unreliable
// feature (electron-builder #2548 / #3972 / #5112 / #5390); the robust pattern
// every Electron app converges on is an in-process splash BrowserWindow, which
// is fully under our control. See memory + main.ts `showOnce`.

let splashWindow: BrowserWindow | null = null;
let splashTimeout: ReturnType<typeof setTimeout> | null = null;

// Hard backstop: the main window's own show is gated on `server-ready` with a
// 15 s fallback, so a 30 s lifetime guarantees the splash never outlives a
// broken boot and strands a click-through window on screen.
const SPLASH_MAX_LIFETIME_MS = 30_000;

/** Inline the brand mark as a data URI so the splash has zero external
 *  dependencies (no file:// path resolution, no CSP, no extra request) and
 *  paints in a single frame. Falls back to a logo-less card if unreadable. */
function resolveLogoDataUri(): string | null {
	try {
		// Packaged: `dist-renderer/` is shipped to `resources/renderer/` via
		// extraResources. Dev: read straight from `public/` (always present;
		// `dist-renderer/` may be stale or absent under `bun dev`).
		const iconPath = app.isPackaged
			? path.join(process.resourcesPath, "renderer", "icon.png")
			: path.join(import.meta.dirname, "..", "public", "icon.png");
		return `data:image/png;base64,${readFileSync(iconPath).toString("base64")}`;
	} catch {
		return null;
	}
}

/** Create + show the splash immediately. Idempotent — a second call while one
 *  is already up is a no-op. */
export function createSplashWindow(): void {
	if (splashWindow && !splashWindow.isDestroyed()) {
		return;
	}
	splashWindow = new BrowserWindow({
		width: 300,
		height: 320,
		transparent: true,
		frame: false,
		// DWM paints a rectangular drop-shadow around frameless bounds — noise on
		// a transparent window whose card draws its own shadow (same rationale as
		// the overlay window).
		hasShadow: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		movable: false,
		// Never steal focus from whatever the user is doing (or from the main
		// window the moment it shows).
		focusable: false,
		center: true,
		show: false,
		backgroundColor: "#00000000",
		// Pure HTML/CSS — no preload, no node, no IPC surface.
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	// Purely decorative — never trap a click. The transparent margin around the
	// card would otherwise swallow clicks aimed at whatever is behind it.
	splashWindow.setIgnoreMouseEvents(true);
	// `showInactive` (not `show`) so it appears without activation — pairs with
	// `focusable: false`. ready-to-show fires within a frame for a data: URL.
	splashWindow.once("ready-to-show", () => splashWindow?.showInactive());
	splashWindow
		.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildSplashHtml(resolveLogoDataUri()))}`)
		.catch(() => undefined);
	splashTimeout = setTimeout(closeSplashWindow, SPLASH_MAX_LIFETIME_MS);
}

/** Tear the splash down. Idempotent and safe to call when none is open. */
export function closeSplashWindow(): void {
	if (splashTimeout) {
		clearTimeout(splashTimeout);
		splashTimeout = null;
	}
	if (splashWindow && !splashWindow.isDestroyed()) {
		splashWindow.close();
	}
	splashWindow = null;
}
