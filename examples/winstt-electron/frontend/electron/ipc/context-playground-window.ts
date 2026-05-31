import path from "node:path";
import { BrowserWindow, ipcMain, shell } from "electron";
import type {
	ContextPlaygroundPush,
	ContextPlaygroundWaitReason,
} from "../../src/shared/api/context-debug-types";
import { IPC } from "../../src/shared/api/ipc-channels";
import { CONTEXT_PLAYGROUND_ENABLED } from "../../src/shared/config/debug-flags";
import { captureContextDebugReport } from "../lib/context-debug";
import { dbg } from "../lib/debug-log";
import { isAllowedRendererUrl, isHttpUrl, loadRendererPage } from "../lib/renderer-url";
import { getStoreValue } from "../lib/store";

/**
 * DEBUG-ONLY context-awareness playground window.
 *
 * A standalone, framed, resizable window that shows EXACTLY what dictation's
 * context-awareness pulls from whatever input field is focused — live. The
 * native UIA helper reads the foreground window, so the playground must never
 * read ITS OWN UI: the poll loop skips any tick where one of our BrowserWindows
 * holds OS focus (`BrowserWindow.getFocusedWindow() !== null`). The effect is
 * that the playground always reflects the last EXTERNAL field you focused, and
 * clicking into the playground to inspect freezes (rather than clobbers) it.
 *
 * Capture model (matches the user-chosen "live observer + deep capture"):
 *   - Live: every ~750ms, capture the foreground field via the production tree
 *     path and push a report.
 *   - Deep (armed via the renderer): the NEXT external tick runs all four UIA
 *     modes side-by-side, then disarms.
 *
 * The whole surface is gated by {@link CONTEXT_PLAYGROUND_ENABLED}; with the
 * flag off, `setupContextPlaygroundHandlers` registers nothing and
 * `openContextPlayground` is a no-op, so end users never reach it.
 */

const POLL_INTERVAL_MS = 750;
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 780;
const MIN_WIDTH = 440;
const MIN_HEIGHT = 420;

let playgroundWindow: BrowserWindow | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let liveEnabled = true;
let armedDeep = false;
let capturing = false;
// Last "waiting" reason pushed to the renderer — used to dedupe the heartbeat
// so we don't flood IPC every 750ms while the playground holds focus. Reset to
// null after a real report so the next wait re-pushes.
let lastWaitReason: ContextPlaygroundWaitReason | null = null;

// --- Window aliveness ---------------------------------------------------

function isWindowAlive(win: BrowserWindow | null): win is BrowserWindow {
	return win !== null && !win.isDestroyed();
}

// --- Pure tick decision (extracted for testability) --------------------

export interface TickDecisionInput {
	alive: boolean;
	armedDeep: boolean;
	capturing: boolean;
	liveEnabled: boolean;
	ownFocus: boolean;
	visible: boolean;
}

export type TickDecision =
	| "capture-deep"
	| "capture-live"
	| "hidden"
	| "skip-capturing"
	| "stopped"
	| "wait-off"
	| "wait-own";

/** Decide what a poll tick should do, given the current state. Pure.
 *  `stopped` = window destroyed (let the loop die); `hidden` = minimized/parked
 *  (don't capture, but keep ticking so it resumes when shown again). */
export function decideTick(input: TickDecisionInput): TickDecision {
	if (!input.alive) {
		return "stopped";
	}
	if (!input.visible) {
		return "hidden";
	}
	if (input.capturing) {
		return "skip-capturing";
	}
	if (!(input.liveEnabled || input.armedDeep)) {
		return "wait-off";
	}
	if (input.ownFocus) {
		return "wait-own";
	}
	return input.armedDeep ? "capture-deep" : "capture-live";
}

// --- Push helpers -------------------------------------------------------

function sendToRenderer(payload: ContextPlaygroundPush): void {
	if (!isWindowAlive(playgroundWindow)) {
		return;
	}
	playgroundWindow.webContents.send(IPC.CONTEXT_PLAYGROUND_REPORT, payload);
}

function pushReport(payload: ContextPlaygroundPush): void {
	lastWaitReason = null;
	sendToRenderer(payload);
}

function pushWaiting(reason: ContextPlaygroundWaitReason): void {
	if (reason === lastWaitReason) {
		return;
	}
	lastWaitReason = reason;
	sendToRenderer({ at: Date.now(), kind: "waiting", reason });
}

// --- Capture ------------------------------------------------------------

async function runCapture(deep: boolean): Promise<void> {
	capturing = true;
	try {
		const report = await captureContextDebugReport({
			contextAwarenessEnabled: getStoreValue("general.contextAwareness"),
			deep,
			denyList: getStoreValue("general.contextDenyList"),
		});
		pushReport({ at: Date.now(), kind: "report", report });
	} catch (err) {
		dbg("context-playground", "capture failed:", String(err));
	} finally {
		capturing = false;
	}
}

// --- Poll loop (recursive setTimeout, no overlap) ----------------------

function clearPollTimer(): void {
	if (pollTimer !== null) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
}

function handleTickError(err: unknown): void {
	dbg("context-playground", "poll tick error:", String(err));
}

/** Fire-and-forget the async tick. `runPollTick` handles its own capture
 *  errors internally; this `.catch` is the backstop for any unexpected throw. */
function tick(): void {
	runPollTick().catch(handleTickError);
}

function scheduleNextTick(): void {
	clearPollTimer();
	pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

async function runPollTick(): Promise<void> {
	const decision = decideTick({
		alive: isWindowAlive(playgroundWindow),
		armedDeep,
		capturing,
		liveEnabled,
		ownFocus: BrowserWindow.getFocusedWindow() !== null,
		visible: isWindowAlive(playgroundWindow) && playgroundWindow.isVisible(),
	});

	switch (decision) {
		case "stopped":
			// Window destroyed — let the loop die; restarted on next open.
			return;
		case "hidden":
			// Minimized/parked — skip the capture but keep the loop alive so it
			// resumes automatically when the window is shown again.
			break;
		case "skip-capturing":
			break;
		case "wait-off":
			pushWaiting("live-off");
			break;
		case "wait-own":
			pushWaiting("own-window-focused");
			break;
		case "capture-live":
			await runCapture(false);
			break;
		case "capture-deep":
			armedDeep = false;
			await runCapture(true);
			break;
		default:
			break;
	}
	scheduleNextTick();
}

function startPolling(): void {
	lastWaitReason = null;
	clearPollTimer();
	// Kick an immediate tick so the user sees state without waiting a full
	// interval, then settle into the cadence.
	tick();
}

// --- Window setup -------------------------------------------------------

function handleWillNavigate(event: Electron.Event, url: string): void {
	if (isAllowedRendererUrl(url)) {
		return;
	}
	event.preventDefault();
}

// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op error handler
function ignoreOpenExternalError(): void {}

function handleWindowOpen({ url }: { url: string }): { action: "deny" } {
	if (isHttpUrl(url)) {
		shell.openExternal(url).catch(ignoreOpenExternalError);
	}
	return { action: "deny" };
}

function describeLoadError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function logLoadError(error: unknown): void {
	dbg("context-playground", "Failed to load playground window:", describeLoadError(error));
}

function handleClosed(): void {
	clearPollTimer();
	playgroundWindow = null;
	capturing = false;
	armedDeep = false;
	lastWaitReason = null;
}

function handleDidFinishLoad(win: BrowserWindow): void {
	if (!isWindowAlive(win)) {
		return;
	}
	win.show();
	win.focus();
	startPolling();
}

function buildPlaygroundWindow(): BrowserWindow {
	const win = new BrowserWindow({
		title: "WinSTT — Context Playground (debug)",
		width: DEFAULT_WIDTH,
		height: DEFAULT_HEIGHT,
		minWidth: MIN_WIDTH,
		minHeight: MIN_HEIGHT,
		resizable: true,
		// Pin above other windows so it stays visible while you click around
		// target apps to capture their fields — the whole point of the live view.
		alwaysOnTop: true,
		show: false,
		backgroundColor: "#09090b",
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	win.setMenuBarVisibility(false);
	// "screen-saver" level keeps it above fullscreen/most other top-most windows
	// (e.g. the model picker) so the debug panel is never occluded while tuning.
	win.setAlwaysOnTop(true, "screen-saver");
	win.webContents.on("will-navigate", handleWillNavigate);
	win.webContents.setWindowOpenHandler(handleWindowOpen);
	win.webContents.once("did-finish-load", () => handleDidFinishLoad(win));
	win.on("closed", handleClosed);
	loadRendererPage(win, "context-playground").catch(logLoadError);
	return win;
}

/** Open (or focus) the playground window and (re)start the live poll loop.
 *  Wired to the OPEN IPC channel in {@link setupContextPlaygroundHandlers}. */
function openContextPlayground(): void {
	if (!CONTEXT_PLAYGROUND_ENABLED) {
		return;
	}
	if (isWindowAlive(playgroundWindow)) {
		playgroundWindow.show();
		playgroundWindow.focus();
		startPolling();
		return;
	}
	playgroundWindow = buildPlaygroundWindow();
}

// --- IPC handlers -------------------------------------------------------

function isLivePayload(value: unknown): value is { enabled: boolean } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { enabled?: unknown }).enabled === "boolean"
	);
}

function handleSetLive(_event: Electron.IpcMainEvent, payload: unknown): void {
	if (!isLivePayload(payload)) {
		return;
	}
	liveEnabled = payload.enabled;
	// A renderer that just mounted sends SET_LIVE — treat it as "ready" and
	// (re)prime the loop so a capture lands promptly.
	if (isWindowAlive(playgroundWindow)) {
		startPolling();
	}
}

function handleArmDeep(): void {
	armedDeep = true;
	if (isWindowAlive(playgroundWindow)) {
		startPolling();
	}
}

function handleClose(): void {
	if (isWindowAlive(playgroundWindow)) {
		playgroundWindow.close();
	}
}

function teardownContextPlaygroundHandlers(): void {
	ipcMain.off(IPC.CONTEXT_PLAYGROUND_OPEN, openContextPlayground);
	ipcMain.off(IPC.CONTEXT_PLAYGROUND_SET_LIVE, handleSetLive);
	ipcMain.off(IPC.CONTEXT_PLAYGROUND_ARM_DEEP, handleArmDeep);
	ipcMain.off(IPC.CONTEXT_PLAYGROUND_CLOSE, handleClose);
	clearPollTimer();
	if (isWindowAlive(playgroundWindow)) {
		playgroundWindow.destroy();
	}
	playgroundWindow = null;
}

/** Register the playground IPC handlers. No-op (returns a no-op teardown) when
 *  the debug flag is off, so the feature is invisible in shipped builds. */
export function setupContextPlaygroundHandlers(): () => void {
	if (!CONTEXT_PLAYGROUND_ENABLED) {
		// biome-ignore lint/suspicious/noEmptyBlockStatements: disabled = no teardown work
		return () => {};
	}
	ipcMain.on(IPC.CONTEXT_PLAYGROUND_OPEN, openContextPlayground);
	ipcMain.on(IPC.CONTEXT_PLAYGROUND_SET_LIVE, handleSetLive);
	ipcMain.on(IPC.CONTEXT_PLAYGROUND_ARM_DEEP, handleArmDeep);
	ipcMain.on(IPC.CONTEXT_PLAYGROUND_CLOSE, handleClose);
	return teardownContextPlaygroundHandlers;
}

// Test-only setters/getters to drive internal state without a real
// BrowserWindow (mirrors the picker test surfaces).
function __setLiveEnabled(value: boolean): void {
	liveEnabled = value;
}
function __setArmedDeep(value: boolean): void {
	armedDeep = value;
}
function __getArmedDeep(): boolean {
	return armedDeep;
}
function __setLastWaitReason(reason: ContextPlaygroundWaitReason | null): void {
	lastWaitReason = reason;
}
function __getLastWaitReason(): ContextPlaygroundWaitReason | null {
	return lastWaitReason;
}

export const __context_playground_test_helpers__ = {
	decideTick,
	isLivePayload,
	pushWaiting,
	pushReport,
	__setLiveEnabled,
	__setArmedDeep,
	__getArmedDeep,
	__setLastWaitReason,
	__getLastWaitReason,
};
