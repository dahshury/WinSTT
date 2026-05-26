import path from "node:path";
import { app, BrowserWindow, ipcMain, screen, shell } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { dbg } from "../lib/debug-log";
import { isAllowedRendererUrl, isHttpUrl, loadRendererPage } from "../lib/renderer-url";
import { store } from "../lib/store";

// First-run wizard window. Frameless to match the Settings window aesthetic
// (the renderer draws its own titlebar with the accent hairline + dot + mono
// caps), but otherwise a normal positioned window — not the transparent
// click-to-dismiss backdrop used by the model-picker / device-picker, since
// the wizard is a one-shot "real dialog" the user reads and interacts with
// at length.

const ONBOARDING_WIDTH = 720;
const ONBOARDING_HEIGHT = 620;

let onboardingWindow: BrowserWindow | null = null;
let onFinishCallback: (() => void) | null = null;
// Tracks whether we've already proxied a finish event to the host. Without
// this guard, `close` after a user-initiated FINISH would fire onFinish
// twice (once from the IPC handler, once from the window's close listener).
// We also use this to know that a "close" event came from our own teardown
// rather than the user clicking the X — in that case we don't want to count
// it as a skip.
let finishedOnce = false;

function isWindowAlive(win: BrowserWindow | null): win is BrowserWindow {
	return win !== null && !win.isDestroyed();
}

function getWindowIconPath(): string | undefined {
	if (process.platform !== "win32") {
		return;
	}
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "renderer", "icon.ico");
	}
	return path.join(import.meta.dirname, "..", "build", "icon.ico");
}

function centerOnPrimaryDisplay(): { x: number; y: number } {
	const display = screen.getPrimaryDisplay();
	const { workArea } = display;
	return {
		x: Math.round(workArea.x + (workArea.width - ONBOARDING_WIDTH) / 2),
		y: Math.round(workArea.y + (workArea.height - ONBOARDING_HEIGHT) / 2),
	};
}

function handleWillNavigate(event: Electron.Event, url: string): void {
	if (isAllowedRendererUrl(url)) {
		return;
	}
	event.preventDefault();
}

function handleWindowOpen({ url }: { url: string }): { action: "deny" } {
	if (isHttpUrl(url)) {
		// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op error handler
		shell.openExternal(url).catch(() => {});
	}
	return { action: "deny" };
}

function logLoadError(error: unknown): void {
	dbg(
		"onboarding",
		"Failed to load onboarding window:",
		error instanceof Error ? error.message : String(error)
	);
}

export function createOnboardingWindow(): BrowserWindow {
	if (isWindowAlive(onboardingWindow)) {
		return onboardingWindow;
	}

	const iconPath = getWindowIconPath();
	const { x, y } = centerOnPrimaryDisplay();

	finishedOnce = false;

	onboardingWindow = new BrowserWindow({
		title: "Welcome to WinSTT",
		...(iconPath ? { icon: iconPath } : {}),
		width: ONBOARDING_WIDTH,
		height: ONBOARDING_HEIGHT,
		x,
		y,
		minWidth: 600,
		minHeight: 560,
		resizable: true,
		minimizable: true,
		maximizable: false,
		fullscreenable: false,
		// Frameless to match the Settings window. The renderer paints its own
		// titlebar (TitleBar pattern: surface-2 substrate + accent hairline +
		// dot + mono caps + close button on the right).
		frame: false,
		show: false,
		backgroundColor: "#09090b",
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	onboardingWindow.webContents.on("will-navigate", handleWillNavigate);
	onboardingWindow.webContents.setWindowOpenHandler(handleWindowOpen);
	onboardingWindow.once("ready-to-show", () => {
		onboardingWindow?.show();
		onboardingWindow?.focus();
	});

	// Closing via the OS chrome (X button) means "skip" — record onboardedAt
	// and flip the flag so the wizard never re-opens, then continue boot. If
	// IPC FINISH already fired, `finishedOnce` is true and we leave silently.
	onboardingWindow.on("close", () => {
		if (!finishedOnce) {
			finishedOnce = true;
			markOnboardedInStore({ completed: false, track: "" });
			onFinishCallback?.();
		}
	});

	loadRendererPage(onboardingWindow, "onboarding").catch(logLoadError);

	return onboardingWindow;
}

interface FinishPayload {
	completed: boolean;
	track: "" | "local" | "cloud";
}

function isFinishPayload(value: unknown): value is FinishPayload {
	if (!value || typeof value !== "object") {
		return false;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.completed !== "boolean") {
		return false;
	}
	return v.track === "" || v.track === "local" || v.track === "cloud";
}

function markOnboardedInStore(payload: FinishPayload): void {
	store.set("general.onboarded", true);
	store.set("general.onboardedAt", Date.now());
	store.set("general.onboardedTrack", payload.track);
}

function handleFinish(_event: unknown, payload: unknown): void {
	if (!isFinishPayload(payload)) {
		dbg("onboarding", "Ignoring malformed finish payload");
		return;
	}
	if (finishedOnce) {
		return;
	}
	finishedOnce = true;
	markOnboardedInStore(payload);
	dbg("onboarding", `wizard finished: completed=${payload.completed} track=${payload.track}`);
	// Close the window — its `close` listener will see `finishedOnce === true`
	// and skip the duplicate fallback path.
	if (isWindowAlive(onboardingWindow)) {
		onboardingWindow.close();
	}
	onFinishCallback?.();
}

interface SetupOptions {
	onFinish: () => void;
}

export function setupOnboardingHandlers(options: SetupOptions): () => void {
	onFinishCallback = options.onFinish;
	ipcMain.on(IPC.ONBOARDING_FINISH, handleFinish);
	return () => {
		ipcMain.off(IPC.ONBOARDING_FINISH, handleFinish);
		onFinishCallback = null;
		if (isWindowAlive(onboardingWindow)) {
			onboardingWindow.destroy();
		}
		onboardingWindow = null;
	};
}
