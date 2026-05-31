import { expect, test } from "@playwright/test";

/**
 * Visual regression snapshots for each renderer window.
 *
 * Each BrowserWindow in the Electron app loads its own HTML entry from the
 * Vite multi-page build. The `webServer` hook in `playwright.config.ts`
 * exposes them via `bunx vite preview`, so we drive each entry as a plain
 * static page and pixel-diff against a committed baseline.
 *
 * Flake budget:
 *   - `maxDiffPixelRatio: 0.02` (2%) tolerates minor sub-pixel/antialiasing
 *     drift across hosts (font hinting, GPU layer compositing).
 *   - We disable CSS animations + transitions, await `document.fonts.ready`,
 *     and wait for `networkidle` so the snapshot reflects steady state.
 *   - Transparent / compositor-driven windows are intentionally skipped:
 *     their rendering depends on the live Electron DWM surface and isn't
 *     reproducible inside a vanilla chromium page context.
 *
 * Baselines live in `e2e/visual-regression.e2e.ts-snapshots/` and ARE
 * committed — CI compares against them. Regenerate with:
 *     bunx playwright test visual-regression --update-snapshots
 */

const FREEZE_ANIMATIONS_CSS = `
	*, *::before, *::after {
		animation-duration: 0s !important;
		animation-delay: 0s !important;
		transition-duration: 0s !important;
		transition-delay: 0s !important;
		caret-color: transparent !important;
	}
`;

async function stabilizePage(page: import("@playwright/test").Page): Promise<void> {
	await page.waitForLoadState("domcontentloaded");
	await page.waitForLoadState("networkidle");
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	await page.addStyleTag({ content: FREEZE_ANIMATIONS_CSS });
	// One extra rAF to let the style-tag injection flush before we snap.
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

const DEFAULT_SNAPSHOT_OPTIONS = {
	maxDiffPixelRatio: 0.02,
	animations: "disabled",
	caret: "hide",
} as const;

test.describe("visual regression", () => {
	test("main window snapshot", async ({ page }) => {
		await page.goto("/");
		await stabilizePage(page);
		await expect(page).toHaveScreenshot("main.png", DEFAULT_SNAPSHOT_OPTIONS);
	});

	test("settings window snapshot", async ({ page }) => {
		await page.goto("/settings");
		await stabilizePage(page);
		await expect(page).toHaveScreenshot("settings.png", DEFAULT_SNAPSHOT_OPTIONS);
	});

	test("tray menu window snapshot", async ({ page }) => {
		await page.goto("/tray-menu");
		await stabilizePage(page);
		await expect(page).toHaveScreenshot("tray-menu.png", DEFAULT_SNAPSHOT_OPTIONS);
	});

	test("model picker window snapshot", async ({ page }) => {
		await page.goto("/model-picker");
		await stabilizePage(page);
		await expect(page).toHaveScreenshot("model-picker.png", DEFAULT_SNAPSHOT_OPTIONS);
	});

	test("device picker window snapshot", async ({ page }) => {
		await page.goto("/device-picker");
		await stabilizePage(page);
		await expect(page).toHaveScreenshot("device-picker.png", DEFAULT_SNAPSHOT_OPTIONS);
	});

	// The overlay window is a transparent, frameless BrowserWindow whose final
	// appearance depends on the Electron DWM compositor layering it over the
	// desktop. Outside of `_electron.launch()` it renders against a default
	// chromium white background, which produces deterministic but misleading
	// pixels — masking the whole surface would defeat the point. Cover the
	// overlay's live behaviour via `overlay-pill.electron.e2e.ts` instead.
	test.skip("overlay window snapshot (skipped: transparent compositor surface)", () => {
		// TODO: revisit once we have a Playwright-driven Electron screenshot
		// helper that captures the composited surface (see playwright-core's
		// `_electron.launch().firstWindow().screenshot()` for a starting
		// point — currently flaky on win-latest GH runners).
	});

	// Onboarding is built conditionally and isn't part of the standard `vite
	// build` output footprint on every revision. Skip rather than fail the
	// suite when its HTML entry isn't published to `dist-renderer/`.
	test.skip("onboarding window snapshot (skipped: not always built)", () => {
		// TODO: enable once `windows/onboarding.html` is unconditionally
		// emitted by the Vite build.
	});
});
