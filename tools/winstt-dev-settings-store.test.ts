import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
	readDevSettings,
	resolveWinsttAppDataDir,
	writeDevSettings,
} from "./winstt-dev-settings-store";

const SETTINGS_FILE = "winstt-settings.json";
const SETTINGS_KEY = "winstt_settings";
const SECRET_PRESENT_SENTINEL = "__WINSTT_SECRET_PRESENT__";

let tempDir: string | undefined;
const originalAppDataDir = process.env.WINSTT_APP_DATA_DIR;

async function useTempAppDataDir(): Promise<string> {
	tempDir = await mkdtemp(join(tmpdir(), "winstt-settings-"));
	process.env.WINSTT_APP_DATA_DIR = tempDir;
	return tempDir;
}

afterEach(async () => {
	if (originalAppDataDir === undefined) {
		delete process.env.WINSTT_APP_DATA_DIR;
	} else {
		process.env.WINSTT_APP_DATA_DIR = originalAppDataDir;
	}
	if (tempDir) {
		await rm(tempDir, { force: true, recursive: true });
		tempDir = undefined;
	}
});

describe("resolveWinsttAppDataDir", () => {
	test("uses platform app-data conventions plus the Tauri identifier", () => {
		expect(resolveWinsttAppDataDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me", "win32")).toBe(
			"C:\\Users\\me\\AppData\\Roaming\\com.winstt.winstt"
		);
		expect(resolveWinsttAppDataDir({}, "/Users/me", "darwin")).toBe(
			"/Users/me/Library/Application Support/com.winstt.winstt"
		);
		expect(resolveWinsttAppDataDir({}, "/home/me", "linux")).toBe(
			"/home/me/.local/share/com.winstt.winstt"
		);
	});
});

describe("dev settings store", () => {
	test("reads and writes the Tauri store shape while preserving masked secrets", async () => {
		const appDataDir = await useTempAppDataDir();
		const path = join(appDataDir, SETTINGS_FILE);
		await writeFile(
			path,
			JSON.stringify({
				[SETTINGS_KEY]: {
					dictionary: [],
					integrations: {
						elevenlabs: { apiKey: "" },
						openai: { apiKey: "plain-existing-key" },
					},
					llm: { openrouterApiKey: "enc:v1:sealed-existing-key" },
				},
			})
		);

		const loaded = await readDevSettings();
		expect(loaded).toMatchObject({
			integrations: {
				elevenlabs: { apiKey: "" },
				openai: { apiKey: SECRET_PRESENT_SENTINEL },
			},
			llm: { openrouterApiKey: SECRET_PRESENT_SENTINEL },
		});

		await writeDevSettings({
			dictionary: [{ id: "term-1", term: "central" }],
			llm: { openrouterApiKey: SECRET_PRESENT_SENTINEL },
		});

		const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, unknown>>;
		expect(stored[SETTINGS_KEY]).toMatchObject({
			dictionary: [{ id: "term-1", term: "central" }],
			llm: { openrouterApiKey: "enc:v1:sealed-existing-key" },
		});
	});
});
