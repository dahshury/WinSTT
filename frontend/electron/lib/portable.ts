/**
 * Portable mode support for WinSTT.
 *
 * When a file literally named `portable` lives next to the running
 * executable, ALL user data (electron-store settings, debug logs, HF model
 * cache, recordings, transcription history DB, temp files) is stored in a
 * sibling `Data/` directory instead of `%APPDATA%` / `~/.config` / etc.
 *
 * Why this exists:
 *   - Runs from a USB stick — settings stay on the stick.
 *   - Corporate-locked-down machines that disallow AppData writes.
 *   - Self-contained dev builds that don't pollute the host's APPDATA.
 *
 * Marker file conventions (mirroring the Handy reference impl):
 *   - The marker's content MUST start with the magic string
 *     ``WinSTT Portable Mode`` (whitespace tolerated). Any other content
 *     does NOT enable portable mode by itself.
 *   - Legacy upgrade path: an EMPTY marker file alongside an EXISTING
 *     ``Data/`` directory is treated as a real portable install — the
 *     marker is rewritten in place to contain the magic string. This
 *     covers any v0.8.0-equivalent build that shipped an empty marker.
 *     Empty marker WITHOUT a Data/ dir (e.g. a Scoop installer that
 *     unconditionally drops the file) does NOT enable portable mode.
 *
 * The detection function is exported separately from the side-effecting
 * ``applyPortablePaths`` so tests can exercise the rules without touching
 * the real Electron ``app`` singleton.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { App } from "electron";

/**
 * Stat-based existence check. Substitute for ``fs.existsSync`` that
 * avoids a known cross-test mock-pollution hazard: ``paste.test.ts``
 * installs a global ``mock.module("node:fs", { existsSync: () => true })``
 * which would otherwise make every portable detection report "marker
 * present" once that test has run earlier in the suite. ``statSync``
 * is unaffected by that mock and returns the real on-disk state.
 */
function pathExists(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

/** Magic string the marker file must contain (after trim) for portable mode. */
export const PORTABLE_MAGIC_STRING = "WinSTT Portable Mode";

/** Default subdirectory (next to the exe) that holds all portable data. */
export const PORTABLE_DATA_DIRNAME = "Data";

/** Default marker file name (next to the exe). */
export const PORTABLE_MARKER_FILENAME = "portable";

/**
 * Returns ``true`` when the marker at ``markerPath`` contains the magic
 * string ``WinSTT Portable Mode`` (leading/trailing whitespace allowed).
 * Returns ``false`` for any IO error, a missing file, or unrelated content.
 *
 * Exported for direct unit testing.
 */
export function isValidPortableMarker(markerPath: string): boolean {
	try {
		const content = readFileSync(markerPath, "utf8");
		return content.trim().startsWith(PORTABLE_MAGIC_STRING);
	} catch {
		return false;
	}
}

/** Result of {@link resolvePortableState}. */
export interface PortableState {
	/** Absolute path to the ``Data/`` directory (whether or not it exists). */
	dataDir: string;
	/** Whether portable mode is active for this launch. */
	isPortable: boolean;
	/**
	 * Whether the marker file was upgraded in place from an empty legacy
	 * shape to the magic-string content. Populated only when ``isPortable``
	 * is ``true`` and the marker was rewritten.
	 */
	legacyUpgradeApplied: boolean;
	/** Absolute path to the marker file (whether or not it exists). */
	markerPath: string;
}

/**
 * Decide whether ``exeDir`` is a portable install.
 *
 * Rules:
 *   1. A marker file whose content starts with the magic string activates
 *      portable mode unconditionally.
 *   2. A marker file with empty/other content + an EXISTING ``Data/``
 *      directory next to it is treated as a legacy portable install. The
 *      marker is rewritten in place to contain the magic string and
 *      portable mode is activated. ``legacyUpgradeApplied`` is set to
 *      ``true`` so callers can log the migration.
 *   3. Anything else is non-portable.
 *
 * No directories are created by this function — that side-effect lives in
 * :func:`applyPortablePaths` so tests can run the pure detection in
 * isolation.
 */
export function resolvePortableState(exeDir: string): PortableState {
	const markerPath = path.join(exeDir, PORTABLE_MARKER_FILENAME);
	const dataDir = path.join(exeDir, PORTABLE_DATA_DIRNAME);

	if (isValidPortableMarker(markerPath)) {
		return { markerPath, dataDir, isPortable: true, legacyUpgradeApplied: false };
	}

	// Legacy-marker migration: an empty / unrelated marker plus an
	// existing Data/ directory is a real portable install from an earlier
	// version that wrote a no-content marker. Rewrite the marker so future
	// launches take the fast path (rule 1) and a routine integrity check
	// doesn't flag the file as suspicious.
	if (pathExists(markerPath) && pathExists(dataDir)) {
		try {
			writeFileSync(markerPath, PORTABLE_MAGIC_STRING, "utf8");
		} catch {
			// Best-effort: a read-only USB stick may refuse the rewrite.
			// We still proceed in portable mode — the rule-1 fast path will
			// fail next launch and we'll fall back to rule 2 again.
		}
		return { markerPath, dataDir, isPortable: true, legacyUpgradeApplied: true };
	}

	return { markerPath, dataDir, isPortable: false, legacyUpgradeApplied: false };
}

/**
 * Path-name tokens we feed to ``app.setPath`` / ``app.getPath``. Mirrors
 * the subset of Electron's literal union that this module touches; kept
 * as a local union (instead of importing the full Electron types) so the
 * test shim can implement ``PortableApp`` without dragging in the
 * BrowserWindow / IpcMain / safeStorage typings.
 */
export type PortablePathName =
	| "exe"
	| "userData"
	| "logs"
	| "temp"
	| "sessionData"
	| "cache"
	| "crashDumps";

/**
 * Minimal subset of Electron's ``App`` surface that
 * {@link applyPortablePaths} touches. Lets tests pass an in-memory shim
 * instead of importing the real ``app`` singleton (which has process-wide
 * side effects).
 */
export interface PortableApp {
	getPath: (name: PortablePathName) => string;
	setPath: (name: PortablePathName, value: string) => void;
}

/** Minimal ``electron-log`` surface used by {@link applyPortablePaths}. */
export interface PortableLogger {
	info?: (message: string) => void;
}

/**
 * Apply portable-mode path overrides to the given Electron-like ``app``.
 *
 * MUST be called at the very top of main-process boot, BEFORE any module
 * reads ``app.getPath("userData")`` (electron-store, electron-log,
 * sentry-electron, our own ``debug-log.ts``). Calling it after another
 * module has already cached a userData path is too late.
 *
 * Behaviour when ``isPortable`` is ``true``:
 *   - Ensures ``Data/`` exists next to the exe.
 *   - Routes ``userData``, ``logs``, ``temp``, ``sessionData``, ``cache``,
 *     ``crashDumps`` into the portable tree so EVERYTHING the app would
 *     normally drop into ``%APPDATA%`` lives under ``Data/`` instead.
 *   - Sets ``HF_HOME`` so the Python child's HuggingFace model cache
 *     also lives under ``Data/hf/`` (the cache lookup is in
 *     ``server/src/recorder/infrastructure/model_cache.py``).
 *
 * Returns the resolved {@link PortableState} so the caller can log the
 * outcome and pass ``dataDir`` to downstream consumers (e.g. the Python
 * child's ``--data-dir`` CLI flag).
 */
export function applyPortablePaths(
	app: PortableApp,
	exeDir: string,
	logger?: PortableLogger
): PortableState {
	const state = resolvePortableState(exeDir);
	if (!state.isPortable) {
		return state;
	}

	// Create the data tree before any setPath call that points into it
	// runs — Electron itself doesn't auto-create the directories it's
	// told to use, and downstream modules (electron-store etc.) crash if
	// the parent doesn't exist.
	mkdirSync(state.dataDir, { recursive: true });
	const logsDir = path.join(state.dataDir, "logs");
	const tempDir = path.join(state.dataDir, "temp");
	const sessionDir = path.join(state.dataDir, "session");
	const cacheDir = path.join(state.dataDir, "cache");
	const crashDir = path.join(state.dataDir, "crash");
	const hfCacheDir = path.join(state.dataDir, "hf");
	mkdirSync(logsDir, { recursive: true });
	mkdirSync(tempDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cacheDir, { recursive: true });
	mkdirSync(crashDir, { recursive: true });
	mkdirSync(hfCacheDir, { recursive: true });

	app.setPath("userData", state.dataDir);
	app.setPath("logs", logsDir);
	app.setPath("temp", tempDir);
	app.setPath("sessionData", sessionDir);
	app.setPath("cache", cacheDir);
	app.setPath("crashDumps", crashDir);

	// Hugging Face cache root — picked up by the Python child via
	// huggingface_hub's standard env vars. Set both so different hf_hub
	// versions resolve consistently.
	process.env.HF_HOME = hfCacheDir;
	process.env.HUGGINGFACE_HUB_CACHE = path.join(hfCacheDir, "hub");
	// Mirror the data root so the Python child can fall back to env when
	// the CLI flag is missing (legacy launches via raw `stt-server` from
	// a portable tree).
	process.env.WINSTT_DATA_DIR = state.dataDir;

	if (state.legacyUpgradeApplied) {
		logger?.info?.(
			`[portable] upgraded legacy empty marker to magic string at ${state.markerPath}`
		);
	}
	logger?.info?.(`[portable] data dir: ${state.dataDir}`);

	return state;
}

/**
 * Thin wrapper that resolves the exe directory from the real Electron
 * ``app`` singleton and delegates to {@link applyPortablePaths}. Kept
 * separate so tests don't pay the cost of importing the real app.
 *
 * The cast through ``PortableApp`` is intentional: ``Electron.App`` types
 * ``getPath`` / ``setPath`` with a narrow literal union that we mirror
 * (and slightly subset) via :type:`PortablePathName`. TypeScript treats
 * method-typed properties with strict-variance, so a direct assignment
 * is rejected — but the runtime shapes are identical (same method
 * names, same arg/return types). Using ``unknown`` as the cast pivot
 * keeps the unsafe step localised to this one boundary.
 */
export function initPortableMode(app: App, logger?: PortableLogger): PortableState {
	const exePath = app.getPath("exe");
	const exeDir = path.dirname(exePath);
	return applyPortablePaths(app as unknown as PortableApp, exeDir, logger);
}
