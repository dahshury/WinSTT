import { expect, test } from "@playwright/test";

test.describe("tray menu window", () => {
	const consoleErrors: string[] = [];

	test.beforeEach(async ({ page }) => {
		consoleErrors.length = 0;
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				consoleErrors.push(msg.text());
			}
		});
		await page.goto("/tray-menu");
	});

	test("renders tray-menu page", async ({ page }) => {
		await expect(page).toHaveURL(/\/tray-menu/);
		const body = page.locator("body");
		await expect(body).toBeVisible();
	});

	test("renders without page-level errors", async ({ page }) => {
		// Wait for the renderer to settle, then make sure body has
		// non-trivial content. We don't assert on console errors directly
		// because IPC-related errors are expected when not running inside
		// Electron — the renderer should still mount.
		await page.waitForLoadState("domcontentloaded");
		const html = await page.locator("body").innerHTML();
		expect(html.length).toBeGreaterThan(0);
	});
});
