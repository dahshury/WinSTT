import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = 1428;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_DATA_DIR = mkdtempSync(join(tmpdir(), "winstt-settings-e2e-"));

// The teardown runs in the Playwright coordinator process, so this is the
// narrow hand-off for the one temporary directory it is allowed to remove.
process.env["WINSTT_SETTINGS_E2E_APP_DATA_DIR"] = APP_DATA_DIR;

const inheritedEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	),
);

export default defineConfig({
	testDir: "./tests/settings",
	fullyParallel: false,
	forbidOnly: true,
	retries: 0,
	workers: 1,
	reporter: [["list"]],
	timeout: 45_000,
	expect: { timeout: 10_000 },
	globalTeardown: "./tests/settings/global-teardown.ts",
	use: {
		baseURL: BASE_URL,
		headless: true,
		locale: "en-US",
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: `bun run dev -- --host ${HOST} --port ${PORT} --strictPort`,
		env: {
			...inheritedEnvironment,
			WINSTT_APP_DATA_DIR: APP_DATA_DIR,
		},
		reuseExistingServer: false,
		stderr: "pipe",
		stdout: "ignore",
		timeout: 90_000,
		url: BASE_URL,
	},
});
