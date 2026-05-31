/**
 * State-driven, theme-aware tray icon + menu controller.
 *
 * The
 * tray reflects three live states (idle / recording / transcribing) and
 * picks light vs dark vs colored icons from the OS theme, refreshing on
 * every nativeTheme `updated` event.
 *
 * On Linux we force the colored variant — system tray
 * icons aren't reliably theme-aware on every desktop environment.
 *
 * The renderer never sees this module — the tray lives entirely in main.
 *
 * History submenu: the actual transcription-history feature lives in the
 * `transcription-history` slice and is wired by a separate agent. Until
 * then, `setTrayHistoryProvider` keeps a hook reserved so the menu can
 * pull entries on demand without this module needing to know how they
 * are persisted. When no provider is installed the submenu is hidden.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	app,
	Menu,
	type MenuItemConstructorOptions,
	type NativeImage,
	nativeImage,
	nativeTheme,
	type Tray,
} from "electron";

export type TrayIconState = "idle" | "recording" | "transcribing";
export type TrayAppTheme = "dark" | "light" | "color";

export interface TrayHistoryEntry {
	/** Final transcript text (post-LLM, if any). */
	text: string;
	/** ISO-8601 timestamp or any human-readable label — main puts it in the
	 *  submenu item title alongside a short transcript preview. */
	timestamp?: string;
}

export type TrayHistoryProvider = () => Promise<TrayHistoryEntry[]> | TrayHistoryEntry[];

interface TrayStateActions {
	onOpenMainWindow: () => void;
	onOpenSettings: () => void;
	onQuit: () => void;
}

/** Module-level singleton state. Only one tray exists per app instance. */
interface TrayStateModel {
	actions: TrayStateActions | null;
	historyEntriesCache: TrayHistoryEntry[];
	historyProvider: TrayHistoryProvider | null;
	state: TrayIconState;
	themeListener: (() => void) | null;
	tray: Tray | null;
}

const model: TrayStateModel = {
	actions: null,
	historyEntriesCache: [],
	historyProvider: null,
	state: "idle",
	themeListener: null,
	tray: null,
};

/** Resolve the current OS theme. Linux always returns "color". */
export function getCurrentTrayTheme(): TrayAppTheme {
	if (process.platform === "linux") {
		return "color";
	}
	return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function trayResourcesRoot(): string {
	if (app.isPackaged) {
		// extraResources copies electron/resources/tray/ → resources/tray/
		// (see packaging/electron-builder.{cpu,gpu,yml}). On disk the asar
		// is sibling to resources/, so `process.resourcesPath/tray/` is the
		// runtime path.
		return path.join(process.resourcesPath, "tray");
	}
	// Dev: the tsup bundle is at dist-electron/main.js; resources live at
	// frontend/electron/resources/tray/ — i.e. `../electron/resources/tray`
	// relative to the bundle.
	return path.join(import.meta.dirname, "..", "electron", "resources", "tray");
}

/**
 * Resolve the path to the @1x icon PNG for the given state + theme. Electron's
 * `nativeImage.createFromPath` auto-detects the `@2x` sibling on HiDPI displays
 * so we only return the base path.
 */
export function getTrayIconPath(theme: TrayAppTheme, state: TrayIconState): string {
	return path.join(trayResourcesRoot(), `tray_${state}_${theme}.png`);
}

/**
 * Filenames (largest → smallest) we'll try for the idle glyph. We deliberately
 * prefer the BIGGEST bitmap rather than the @1x 16px one.
 *
 * Why: on Windows, Electron's tray uses the image's PRIMARY bitmap and lets the
 * OS DPI-scale it for the notification-area cell. The 16px primary therefore
 * gets *upscaled* at 125–175% scaling → the blur you saw. `addRepresentation`
 * scale-reps are NOT honored for the Win32 tray, so the multi-rep approach
 * didn't help. The recording/transcribing animation has always been crisp
 * because `recording-indicator.ts` hands the tray a 48px bitmap that Windows
 * only ever *downscales*. So we do the same here: feed a single 48px bitmap and
 * let Windows downscale to whatever the current DPI needs (16/20/24/28/32/40/48
 * are all clean downscales of 48). This is also what Steam/Discord ship.
 */
const TRAY_IDLE_PREFERENCE = [
	"@4x",
	"@3x",
	"@2.5x",
	"@2x",
	"@1.75x",
	"@1.5x",
	"@1.25x",
	"",
] as const;

/**
 * Load the idle glyph as a single high-res bitmap so Windows downscales (crisp)
 * instead of upscaling the 16px base (blurry). Picks the largest available
 * `tray_idle_<theme>@{n}x.png`, falling back through the ladder to the 16px
 * base. Loaded via createFromBuffer so Electron's implicit "@2x" filename
 * detection can't override our chosen bitmap with a smaller sibling.
 */
export function loadIdleIcon(theme: TrayAppTheme): NativeImage {
	const root = trayResourcesRoot();
	for (const suffix of TRAY_IDLE_PREFERENCE) {
		const repPath = path.join(root, `tray_idle_${theme}${suffix}.png`);
		if (!existsSync(repPath)) {
			continue;
		}
		const img = nativeImage.createFromBuffer(readFileSync(repPath), { scaleFactor: 1 });
		if (!img.isEmpty()) {
			return img;
		}
	}
	return nativeImage.createEmpty();
}

function loadIcon(state: TrayIconState, theme: TrayAppTheme): NativeImage {
	if (state === "idle") {
		return loadIdleIcon(theme);
	}
	const iconPath = getTrayIconPath(theme, state);
	if (!existsSync(iconPath)) {
		return nativeImage.createEmpty();
	}
	const img = nativeImage.createFromPath(iconPath);
	return img.isEmpty() ? nativeImage.createEmpty() : img;
}

/** Human-readable label rendered at the top of the tray menu. */
function stateLabel(state: TrayIconState): string {
	switch (state) {
		case "recording":
			return "Recording…";
		case "transcribing":
			return "Transcribing…";
		default:
			return "Idle";
	}
}

function clipTranscript(text: string, max = 60): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max - 1)}…`;
}

/** Build the "Recent transcriptions" submenu from the cached snapshot.
 *  Returns `null` when no provider is installed (the menu omits the slot
 *  entirely in that case). */
function buildHistorySubmenu(): MenuItemConstructorOptions | null {
	if (!model.historyProvider) {
		return null;
	}
	const entries = model.historyEntriesCache;
	if (entries.length === 0) {
		return {
			label: "Recent transcriptions",
			submenu: [{ label: "No entries yet", enabled: false }],
		};
	}
	const submenu: MenuItemConstructorOptions[] = entries.slice(0, 10).map((entry) => ({
		label: clipTranscript(entry.text || "(empty)"),
		enabled: false,
	}));
	return { label: "Recent transcriptions", submenu };
}

function buildMenuTemplate(): MenuItemConstructorOptions[] {
	const items: MenuItemConstructorOptions[] = [];
	items.push({ label: stateLabel(model.state), enabled: false });
	items.push({ type: "separator" });
	items.push({
		label: "Open WinSTT",
		click: () => model.actions?.onOpenMainWindow(),
	});
	items.push({
		label: "Settings",
		click: () => model.actions?.onOpenSettings(),
	});
	const history = buildHistorySubmenu();
	if (history) {
		items.push({ type: "separator" });
		items.push(history);
	}
	items.push({ type: "separator" });
	items.push({ label: "Quit", click: () => model.actions?.onQuit() });
	return items;
}

function applyTrayImage(): void {
	if (!model.tray || model.tray.isDestroyed()) {
		return;
	}
	// Only the idle state owns the static PNG. Recording and transcribing are
	// driven by the recording-indicator's live animation (bars / topology
	// morph); painting the static "recording" or "transcribing" icons here
	// would race the indicator and flash a red dot before the bars come up.
	// The context-menu label still tracks all three states for the right-click
	// menu — only the icon paint is gated.
	if (model.state !== "idle") {
		return;
	}
	const theme = getCurrentTrayTheme();
	const img = loadIcon(model.state, theme);
	model.tray.setImage(img);
}

function rebuildContextMenu(): void {
	if (!model.tray || model.tray.isDestroyed()) {
		return;
	}
	// Native context menus are intentionally limited to Linux. On
	// Windows/macOS, calling `Tray.setContextMenu` makes the OS surface
	// the native menu on right-click — which preempts the custom
	// BrowserWindow-based menu (`showTrayMenuAt` in tray-menu-window.ts)
	// that owns the rich UI: mic selector, recording-mode switcher,
	// file-transcribe, log/diag actions, etc. Linux AppIndicator backends
	// don't fire `right-click` events reliably, so the native menu is the
	// only viable fallback there.
	if (process.platform !== "linux") {
		return;
	}
	const template = buildMenuTemplate();
	const menu = Menu.buildFromTemplate(template);
	model.tray.setContextMenu(menu);
}

/**
 * Attach the live tray to the state controller. Idempotent — calling it
 * again with a new Tray replaces the reference (useful for hot-reload in
 * dev). Performs an initial render so the tray reflects the current state
 * the moment it appears.
 */
export function attachTray(tray: Tray, actions: TrayStateActions): void {
	model.tray = tray;
	model.actions = actions;
	// Listen for system-theme changes — flip icon when the user toggles
	// Windows dark/light mode without restarting the app.
	if (!model.themeListener) {
		const listener = (): void => {
			applyTrayImage();
		};
		nativeTheme.on("updated", listener);
		model.themeListener = (): void => {
			nativeTheme.off("updated", listener);
		};
	}
	applyTrayImage();
	rebuildContextMenu();
}

/** Drop the tray reference and tear down the theme listener. */
export function detachTray(): void {
	model.tray = null;
	model.actions = null;
	if (model.themeListener) {
		model.themeListener();
		model.themeListener = null;
	}
}

/** Re-apply the current state's tray PNG without changing logical state. The
 *  recording-indicator's topology animation overwrites the tray icon every
 *  frame while transcribing/thinking; when that animation ends it needs to
 *  put the theme-appropriate static icon back. This is the public hook for
 *  doing that — main.ts holds the only reference to the live tray, but the
 *  indicator imports this when it transitions back to idle. */
export function reapplyTrayImage(): void {
	applyTrayImage();
}

/** Transition the tray into a new state. No-op if the state is unchanged. */
export function setTrayState(state: TrayIconState): void {
	if (model.state === state) {
		return;
	}
	model.state = state;
	applyTrayImage();
	rebuildContextMenu();
}

export function getTrayState(): TrayIconState {
	return model.state;
}

/**
 * Install a history provider. The tray menu will call the provider lazily
 * (on every rebuild) and cache the latest result; setting `null` removes
 * the submenu from the menu entirely.
 */
export function setTrayHistoryProvider(provider: TrayHistoryProvider | null): void {
	model.historyProvider = provider;
	if (!provider) {
		model.historyEntriesCache = [];
		rebuildContextMenu();
		return;
	}
	// Best-effort refresh — failures keep the previous cache. We rebuild after
	// the refresh resolves so the user sees the fresh entries the next time the
	// menu opens.
	const result = provider();
	Promise.resolve(result)
		.then((entries) => {
			model.historyEntriesCache = entries;
			rebuildContextMenu();
		})
		.catch(() => {
			// Swallow — keep last cache, tray is non-critical.
		});
	rebuildContextMenu();
}

/** Trigger a manual history refresh. Use from history-update IPC channels
 *  so the submenu doesn't go stale between right-clicks. */
export function refreshTrayHistory(): void {
	if (!model.historyProvider) {
		return;
	}
	const result = model.historyProvider();
	Promise.resolve(result)
		.then((entries) => {
			model.historyEntriesCache = entries;
			rebuildContextMenu();
		})
		.catch(() => {
			// Best-effort — tray is non-critical.
		});
}

// ── Server-event wiring ──────────────────────────────────────────────
// The relay (electron/ipc/relay.ts) is the natural place to derive tray
// state — it already owns the recording lifecycle (handleRecordingStart /
// handleRecordingStop) plus the `transcription_start` simple-relay branch.
// Rather than have the relay reach into this module, we expose narrow
// transition helpers it can call. Same shape as recording-indicator's
// `onRecordingStart` / `onRecordingStop` pair.

/** Recording capture started — the recorder is now buffering microphone audio. */
export function onTrayRecordingStart(): void {
	setTrayState("recording");
}

/** The recorder has stopped capture and handed audio to the transcriber. */
export function onTrayTranscriptionStart(): void {
	setTrayState("transcribing");
}

/**
 * Pipeline reached a terminal state — transcript delivered, no-audio result,
 * cancellation, etc. Callers don't need to distinguish; they just signal that
 * the tray should return to its calm "Idle" look.
 */
export function onTrayIdle(): void {
	setTrayState("idle");
}

// ── Testing helpers ──────────────────────────────────────────────────
// Exported behind a single object so production code can't accidentally
// reach into the module's private state.
export const __tray_state_test_helpers__ = {
	clipTranscript,
	buildMenuTemplate,
	stateLabel,
	getModelSnapshot: () => ({ ...model }),
	resetForTests: (): void => {
		model.tray = null;
		model.actions = null;
		if (model.themeListener) {
			model.themeListener();
			model.themeListener = null;
		}
		model.state = "idle";
		model.historyProvider = null;
		model.historyEntriesCache = [];
	},
	setHistoryEntriesCache: (entries: TrayHistoryEntry[]): void => {
		model.historyEntriesCache = entries;
	},
};
