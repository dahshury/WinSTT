import { defineConfig, devices } from "@playwright/test";

// Accessibility-audit Playwright config (`npm run test:a11y`). It boots the Vite
// dev server (each Tauri WebviewWindow is its own HTML entry — see vite.config.ts
// `rollupOptions.input`) and runs axe-core against every window's rendered DOM.
//
// The renderer degrades gracefully outside a real Tauri webview: `installNativeBridge`
// no-ops when `__TAURI_INTERNALS__` is absent and `ipc-client` falls back to its
// declared defaults, so each window still mounts its full DOM in plain Chromium —
// exactly what an a11y audit needs.
const HOST = "127.0.0.1";
const PORT = 1420;
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
	testDir: "./tests/a11y",
	fullyParallel: true,
	forbidOnly: false,
	retries: 0,
	workers: 1,
	reporter: [["list"]],
	timeout: 90_000,
	expect: { timeout: 15_000 },
	use: {
		baseURL: BASE_URL,
		headless: true,
		// The renderer reads its locale from this; pin it so the audit is deterministic.
		locale: "en-US",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "bun run dev",
		url: BASE_URL,
		reuseExistingServer: true,
		timeout: 180_000,
		stdout: "ignore",
		stderr: "pipe",
	},
});
