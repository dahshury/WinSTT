import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for WinSTT frontend e2e tests.
 *
 * Mode: renderer-only. The Next.js standalone server is launched via
 * `webServer` and Playwright drives Chromium against it.
 *
 * Note: this project uses `output: "standalone"` (not `output: "export"`),
 * so the renderer is served by the bundled Next.js server rather than a
 * static file server. `bun run build` is a prerequisite — it produces
 * `out/standalone/server.js` which `webServer` boots on port 4001.
 *
 * The `electron` project uses `playwright-core`'s `_electron.launch()` to
 * drive the actual Electron app — needed to verify behaviours that only
 * manifest against a real DWM compositor (e.g. transparent-window
 * show/hide ordering, overlay pill stuck-visible regressions).
 *
 * The renderer-only `chromium` project covers the rest.
 */
export default defineConfig({
	testDir: "./e2e",
	// Use a custom suffix so the existing `bun test` runner (which picks up
	// `*.test.ts` and `*.spec.ts` by default) does not try to execute these
	// files. Playwright's default would otherwise overlap with bunfig.toml.
	testMatch: /.*\.e2e\.ts$/,
	timeout: 30_000,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
	use: {
		baseURL: "http://127.0.0.1:4001",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
			testIgnore: /electron\.e2e\.ts$/,
		},
		{
			name: "electron",
			// `_electron.launch()` doesn't use a browser context, so the
			// chromium device profile and the screenshot/trace settings
			// from `use:` above are mostly inert. The electron suite still
			// inherits `timeout` and `retries` from the top-level config.
			testMatch: /.*\.electron\.e2e\.ts$/,
		},
	],
	// Skip the renderer-only Next.js standalone server when running only the
	// electron project — those tests drive `_electron.launch()` directly and
	// don't talk to the renderer over HTTP.
	webServer: process.env.PW_SKIP_WEBSERVER
		? undefined
		: {
				command: "node out/standalone/server.js",
				url: "http://127.0.0.1:4001",
				env: {
					PORT: "4001",
					HOSTNAME: "127.0.0.1",
				},
				timeout: 120_000,
				reuseExistingServer: !process.env.CI,
			},
});
