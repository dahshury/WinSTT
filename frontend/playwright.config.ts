import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for WinSTT frontend e2e tests.
 *
 * Renderer is a Vite static SPA. The `webServer` hook boots `vite preview`
 * against the production build (`bun run build` must have produced
 * `dist-renderer/` first) so the chromium project drives the same bundle
 * end-users get. Port 4001 is chosen to avoid colliding with `bun dev`'s
 * Vite server on 3000.
 *
 * The `electron` project uses `playwright-core`'s `_electron.launch()` to
 * drive the actual Electron app — needed to verify behaviours that only
 * manifest against a real DWM compositor (e.g. transparent-window
 * show/hide ordering, overlay pill stuck-visible regressions). It does
 * not talk to the renderer over HTTP, so the webServer hook is skipped
 * when `PW_SKIP_WEBSERVER=1` is set (the `test:e2e:electron` script does
 * exactly that).
 */
const webServer = process.env.PW_SKIP_WEBSERVER
	? undefined
	: {
			command: "bunx vite preview --port 4001 --strictPort --host 127.0.0.1",
			url: "http://127.0.0.1:4001",
			timeout: 120_000,
			reuseExistingServer: !process.env.CI,
		};

export default defineConfig({
	...(webServer && { webServer }),
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
});
