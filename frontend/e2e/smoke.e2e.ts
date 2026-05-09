import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("renders main window with non-empty title", async ({ page }) => {
		const title = await page.title();
		expect(title.length).toBeGreaterThan(0);
	});

	test("renders at least one visible top-level region", async ({ page }) => {
		// Look for a generic landmark or common interactive surface so the
		// assertion survives copy/layout tweaks. Fall back through a few
		// resilient selectors.
		const main = page.locator("main, [role='main'], #__next, body > div").first();
		await expect(main).toBeVisible();
	});
});
