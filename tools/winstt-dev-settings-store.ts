import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, posix, win32 } from "node:path";

const APP_IDENTIFIER = "com.winstt.winstt";
const WINSTT_SETTINGS_FILE = "winstt-settings.json";
const WINSTT_SETTINGS_KEY = "winstt_settings";
const SECRET_PRESENT_SENTINEL = "__WINSTT_SECRET_PRESENT__";

const SECRET_PATHS = [
	["llm", "openrouterApiKey"],
	["integrations", "openai", "apiKey"],
	["integrations", "elevenlabs", "apiKey"],
] as const;

type JsonRecord = Record<string, unknown>;

function pathJoinFor(os: NodeJS.Platform): (...paths: string[]) => string {
	return os === "win32" ? win32.join : posix.join;
}

export function resolveWinsttAppDataDir(
	env: NodeJS.ProcessEnv = process.env,
	homeDir = homedir(),
	os = platform()
): string {
	const join = pathJoinFor(os);
	if (env["WINSTT_APP_DATA_DIR"]) {
		return env["WINSTT_APP_DATA_DIR"];
	}
	if (os === "win32") {
		return join(env["APPDATA"] ?? join(homeDir, "AppData", "Roaming"), APP_IDENTIFIER);
	}
	if (os === "darwin") {
		return join(homeDir, "Library", "Application Support", APP_IDENTIFIER);
	}
	return join(env["XDG_DATA_HOME"] ?? join(homeDir, ".local", "share"), APP_IDENTIFIER);
}

export function resolveWinsttSettingsPath(): string {
	return pathJoinFor(platform())(resolveWinsttAppDataDir(), WINSTT_SETTINGS_FILE);
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value: JsonRecord): JsonRecord {
	return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

async function readStoreFile(path: string): Promise<JsonRecord> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch (err) {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
			return {};
		}
		throw err;
	}
}

function settingsFromStore(store: JsonRecord): JsonRecord {
	const value = store[WINSTT_SETTINGS_KEY];
	return isRecord(value) ? cloneRecord(value) : {};
}

function mergeSettings(previous: JsonRecord, patch: JsonRecord): JsonRecord {
	return {
		...previous,
		...patch,
	};
}

function getAtPath(root: JsonRecord, path: readonly string[]): unknown {
	let cursor: unknown = root;
	for (const part of path) {
		if (!isRecord(cursor)) {
			return undefined;
		}
		cursor = cursor[part];
	}
	return cursor;
}

function setAtPath(root: JsonRecord, path: readonly string[], value: unknown): void {
	let cursor: JsonRecord = root;
	for (const part of path.slice(0, -1)) {
		const next = cursor[part];
		if (!isRecord(next)) {
			cursor[part] = {};
		}
		cursor = cursor[part] as JsonRecord;
	}
	const leaf = path.at(-1);
	if (leaf) {
		cursor[leaf] = value;
	}
}

function sanitizeSettingsForRenderer(settings: JsonRecord): JsonRecord {
	const sanitized = cloneRecord(settings);
	for (const path of SECRET_PATHS) {
		const value = getAtPath(sanitized, path);
		if (typeof value === "string" && value.length > 0) {
			setAtPath(sanitized, path, SECRET_PRESENT_SENTINEL);
		}
	}
	return sanitized;
}

function preserveMaskedSecrets(previous: JsonRecord, next: JsonRecord): void {
	for (const path of SECRET_PATHS) {
		if (getAtPath(next, path) === SECRET_PRESENT_SENTINEL) {
			setAtPath(next, path, getAtPath(previous, path) ?? "");
		}
	}
}

export async function readDevSettings(): Promise<JsonRecord> {
	const store = await readStoreFile(resolveWinsttSettingsPath());
	return sanitizeSettingsForRenderer(settingsFromStore(store));
}

export async function writeDevSettings(patch: unknown): Promise<JsonRecord> {
	if (!isRecord(patch)) {
		throw new Error("Expected a settings patch object");
	}

	const path = resolveWinsttSettingsPath();
	const store = await readStoreFile(path);
	const previous = settingsFromStore(store);
	const next = mergeSettings(previous, cloneRecord(patch));
	preserveMaskedSecrets(previous, next);

	store[WINSTT_SETTINGS_KEY] = next;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");

	return sanitizeSettingsForRenderer(next);
}
