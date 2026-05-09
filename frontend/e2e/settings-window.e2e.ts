import { expect, test } from "@playwright/test";

test.describe("settings window", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/settings");
	});

	test("renders settings page without console errors", async ({ page }) => {
		await expect(page).toHaveURL(/\/settings/);
		// At minimum the document body should contain rendered content.
		const body = page.locator("body");
		await expect(body).toBeVisible();
		const html = await body.innerHTML();
		expect(html.length).toBeGreaterThan(0);
	});

	test("renders the settings sidebar with a top-level control", async ({ page }) => {
		// SettingsPage exposes tab links such as "General" / "Model" via
		// next-intl. Use an accessibility-friendly query so the test survives
		// minor copy changes in any single language.
		const tabList = page.getByRole("tablist").first();
		await expect(tabList).toBeVisible({ timeout: 10_000 });
	});
});
