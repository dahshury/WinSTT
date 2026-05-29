import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";

const ALLOWED_EXTS = new Set([".wav", ".mp3"]);

interface AddRequest {
	name?: string;
	sourcePath: string;
}

interface AddResult {
	entry?: { id: string; name: string; path: string };
	error?: string;
	ok: boolean;
}

interface RemoveRequest {
	path: string;
}

interface ReadFileRequest {
	path: string;
}

function getLibraryDir(): string {
	const dir = path.join(app.getPath("userData"), "sounds");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function isInLibrary(p: string): boolean {
	const dir = getLibraryDir();
	const resolved = path.resolve(p);
	return resolved.startsWith(`${path.resolve(dir)}${path.sep}`);
}

function sanitizeExtension(sourcePath: string): string | null {
	const ext = path.extname(sourcePath).toLowerCase();
	return ALLOWED_EXTS.has(ext) ? ext : null;
}

function defaultDisplayName(sourcePath: string): string {
	const base = path.basename(sourcePath, path.extname(sourcePath));
	return base.trim() || "Untitled";
}

/** Prefer an explicit, non-blank caller name; otherwise derive from the file. */
function resolveDisplayName(req: AddRequest): string {
	if (typeof req.name === "string" && req.name.trim().length > 0) {
		return req.name.trim();
	}
	return defaultDisplayName(req.sourcePath);
}

/**
 * Validate the add request up front. Returns either the rejection error or the
 * resolved (allowed) extension. Collapses the three guard branches out of
 * {@link handleAdd} so its body is a flat success path.
 */
function validateAddRequest(req: AddRequest): { error: string } | { ext: string } {
	if (!req?.sourcePath || typeof req.sourcePath !== "string") {
		return { error: "Invalid source path" };
	}
	const ext = sanitizeExtension(req.sourcePath);
	if (!ext) {
		return { error: "Only .wav and .mp3 files are accepted" };
	}
	if (!fs.existsSync(req.sourcePath)) {
		return { error: "Source file not found" };
	}
	return { ext };
}

function handleAdd(payload: unknown): AddResult {
	const req = payload as AddRequest;
	const validated = validateAddRequest(req);
	if ("error" in validated) {
		return { ok: false, error: validated.error };
	}
	try {
		const id = randomUUID();
		const dir = getLibraryDir();
		const destPath = path.join(dir, `${id}${validated.ext}`);
		fs.copyFileSync(req.sourcePath, destPath);
		return { ok: true, entry: { id, name: resolveDisplayName(req), path: destPath } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to copy file: ${message}` };
	}
}

function handleRemove(payload: unknown): { ok: boolean; error?: string } {
	const req = payload as RemoveRequest;
	if (!req?.path || typeof req.path !== "string") {
		return { ok: false, error: "Invalid path" };
	}
	// Only unlink files that live inside our managed folder — refuse to touch
	// arbitrary disk paths even if the renderer passes them.
	if (!isInLibrary(req.path)) {
		return { ok: false, error: "Refusing to delete file outside library folder" };
	}
	try {
		if (fs.existsSync(req.path)) {
			fs.unlinkSync(req.path);
		}
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

function handleReadFile(payload: unknown): Uint8Array | null {
	const req = payload as ReadFileRequest;
	if (!req?.path || typeof req.path !== "string") {
		return null;
	}
	try {
		return fs.readFileSync(req.path);
	} catch {
		return null;
	}
}

export function initSoundLibrary(): () => void {
	ipcMain.handle(IPC.SOUND_LIBRARY_ADD, (_event, payload) => handleAdd(payload));
	ipcMain.handle(IPC.SOUND_LIBRARY_REMOVE, (_event, payload) => handleRemove(payload));
	ipcMain.handle(IPC.SOUND_LIBRARY_READ_FILE, (_event, payload) => handleReadFile(payload));
	return () => {
		ipcMain.removeHandler(IPC.SOUND_LIBRARY_ADD);
		ipcMain.removeHandler(IPC.SOUND_LIBRARY_REMOVE);
		ipcMain.removeHandler(IPC.SOUND_LIBRARY_READ_FILE);
	};
}
