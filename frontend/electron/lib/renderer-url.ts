import path from "node:path";
import { app, type BrowserWindow } from "electron";

const LEADING_SLASHES_RE = /^\/+/;

// Each BrowserWindow loads its own HTML entry — there is no SPA router
// inside the renderer; routing happens at the OS-window level. The names
// here are the keys that BrowserWindow callers ask for; the values are
// the on-disk HTML filenames produced by Vite's multi-page build (see
// vite.config.ts `rollupOptions.input`).
//
// `main` deliberately maps to `index.html` (Vite's convention for the
// app-root entry) so the dev server URL is plain `http://…:3000/`.
export type RendererPage =
	| "main"
	| "settings"
	| "overlay"
	| "tray-menu"
	| "model-picker"
	| "device-picker"
	| "onboarding"
	| "history";

// `main` stays at the project root (Vite dev-root convention); the 6 secondary
// window entries live under `windows/` so the frontend root isn't cluttered
// with one HTML per BrowserWindow. The build mirrors the input layout, so the
// packaged paths are `renderer/windows/<name>.html`.
const PAGE_TO_FILE: Record<RendererPage, string> = {
	main: "index.html",
	settings: "windows/settings.html",
	overlay: "windows/overlay.html",
	"tray-menu": "windows/tray-menu.html",
	"model-picker": "windows/model-picker.html",
	"device-picker": "windows/device-picker.html",
	onboarding: "windows/onboarding.html",
	history: "windows/history.html",
};

const DEV_BASE_URL = "http://localhost:3000";

function getRendererRoot(): string {
	if (app.isPackaged) {
		// electron-builder ships dist-renderer/ to resources/renderer/ via
		// extraResources. Mirrors the `to: "renderer"` mapping in the .yml
		// files; if you change one, change the other.
		return path.join(process.resourcesPath, "renderer");
	}
	// Local dev (vite build) drops the static output here; in `bun dev` the
	// Vite dev server is what we actually load from, this path is only used
	// if someone runs the compiled main against a packaged-style build dir.
	return path.join(import.meta.dirname, "..", "..", "dist-renderer");
}

/** Returns the dev-server URL for a page, e.g. http://localhost:3000/windows/settings.html.
 * Only meaningful while `bun dev` is running. */
export function getDevPageUrl(page: RendererPage): string {
	const file = PAGE_TO_FILE[page];
	// Root entry: serve at "/" not "/index.html" — Vite resolves both, but
	// "/" keeps the address bar and the navigation guard clean.
	return file === "index.html" ? `${DEV_BASE_URL}/` : `${DEV_BASE_URL}/${file}`;
}

/** Absolute filesystem path to the page's HTML file in a packaged install. */
export function getPackagedPagePath(page: RendererPage): string {
	return path.join(getRendererRoot(), PAGE_TO_FILE[page]);
}

/**
 * Loads the requested renderer page into a window. Picks dev vs prod
 * transparently via `app.isPackaged`. Errors propagate via the returned
 * promise so callers decide how to handle a load failure.
 */
export function loadRendererPage(win: BrowserWindow, page: RendererPage): Promise<void> {
	if (app.isPackaged) {
		return win.loadFile(getPackagedPagePath(page));
	}
	return win.loadURL(getDevPageUrl(page));
}

/**
 * True if `url` is something the renderer is allowed to navigate to. The
 * navigation guard installed on every window blocks anything else (and
 * defers external https: links to `shell.openExternal`).
 *
 * Dev: only the Vite dev server origin. Prod: only `file:` URLs that live
 * under the packaged renderer root (defence in depth — prevents a
 * compromised renderer from loading `file:///C:/Windows/...`).
 */
function isAllowedDevUrl(parsed: URL): boolean {
	return parsed.origin === DEV_BASE_URL;
}

function normalisedRendererRoot(): string {
	return path.normalize(getRendererRoot()).toLowerCase();
}

function normalisedPageDir(parsed: URL): string {
	return path
		.normalize(path.dirname(decodeURIComponent(parsed.pathname).replace(LEADING_SLASHES_RE, "")))
		.toLowerCase();
}

function isAllowedPackagedFileUrl(parsed: URL): boolean {
	if (parsed.protocol !== "file:") {
		return false;
	}
	// On Windows the URL host is empty and the pathname starts with `/C:/…`;
	// normalize before the prefix check.
	const rendererRoot = normalisedRendererRoot();
	const pageDir = normalisedPageDir(parsed);
	return pageDir === rendererRoot || pageDir.startsWith(`${rendererRoot}${path.sep}`);
}

function parseUrlOrNull(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

export function isAllowedRendererUrl(url: string): boolean {
	const parsed = parseUrlOrNull(url);
	if (parsed === null) {
		return false;
	}
	return app.isPackaged ? isAllowedPackagedFileUrl(parsed) : isAllowedDevUrl(parsed);
}

/** Used by the navigation-guard's same-origin check inside detached windows. */
export function isSameOrigin(url: string, baseUrl: string): boolean {
	try {
		return new URL(url).origin === new URL(baseUrl).origin;
	} catch {
		return false;
	}
}

export function isHttpUrl(url: string): boolean {
	return url.startsWith("https://") || url.startsWith("http://");
}
